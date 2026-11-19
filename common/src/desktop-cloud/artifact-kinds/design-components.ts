import {
  collectMains,
  type Design,
  type DesignNode,
  type FrameNode,
  type InstanceOverride,
} from './design'
import { allIds, findNode, freshId, getBoard, insertNode, removeBoard, removeNode, updateBoard, walkNodes } from './design-tree'

/**
 * Components. A MAIN component is a frame with `component: true`, anywhere in the design. An
 * INSTANCE is a frame with `instanceOf: <main id>` and no children of its own: it draws a copy of
 * the main, so editing the main restyles every instance. An instance keeps its own place and
 * size (x, y, w, h, grow, hidden, name, linkTo) and may override CONTENT only: a text's `text`,
 * a button's `label`, an image's `src`/`placeholder`/`alt`, keyed by the main's node id. A stale
 * override (its node gone from the main) is ignored, never an error.
 *
 * In the drawn copy every inner id is `<instance id>~<main node id>`: `~` is never in a stored
 * id, so the canvas can tell an instance's inside from real nodes and select the instance.
 */

export const INSTANCE_SEP = '~'

/** Nested instances deeper than this draw empty (validation already refuses cycles). */
const MAX_INSTANCE_DEPTH = 8

export function mainsInSubtree(node: DesignNode): string[] {
  const out: string[] = []
  for (const { node: current } of walkNodes(node)) if (current.type === 'frame' && current.component) out.push(current.id)
  return out
}

export function isInstance(node: DesignNode): node is FrameNode & { instanceOf: string } {
  return node.type === 'frame' && node.instanceOf !== undefined
}

/** For a drawn id `inst~child`, the instance id (outermost) and the main node id under it. */
export function splitInstanceId(drawnId: string): { instanceId: string; innerId: string | null } {
  const at = drawnId.indexOf(INSTANCE_SEP)
  if (at === -1) return { instanceId: drawnId, innerId: null }
  return { instanceId: drawnId.slice(0, at), innerId: drawnId.slice(at + 1) }
}

function applyOverride(node: DesignNode, override: InstanceOverride | undefined): DesignNode {
  if (!override) return node
  if (node.type === 'text' && override.text !== undefined) return { ...node, text: override.text }
  if (node.type === 'button' && override.label !== undefined) return { ...node, label: override.label }
  if (node.type === 'image') {
    const next = { ...node }
    if (override.src !== undefined) {
      next.src = override.src
      delete next.placeholder
    } else if (override.placeholder !== undefined) {
      next.placeholder = override.placeholder
      delete next.src
    }
    if (override.alt !== undefined) next.alt = override.alt
    return next
  }
  return node
}

/**
 * The frame an instance draws: the main's styling and children (ids prefixed, overrides
 * applied, nested instances resolved), with the instance's own id, place and size. A missing
 * main draws an empty frame.
 */
export function resolveInstance(
  instance: FrameNode,
  mains: ReadonlyMap<string, FrameNode>,
  depth = 0,
): FrameNode {
  const main = instance.instanceOf !== undefined ? mains.get(instance.instanceOf) : undefined
  const own = {
    id: instance.id,
    name: instance.name ?? main?.name,
    hidden: instance.hidden,
    x: instance.x,
    y: instance.y,
  }
  if (!main || depth >= MAX_INSTANCE_DEPTH) {
    return { ...instance, ...own, children: [] }
  }
  const prefix = (node: DesignNode, base: string, overrides: FrameNode['overrides']): DesignNode => {
    const id = `${base}${INSTANCE_SEP}${node.id}`
    const shown = applyOverride(node, overrides?.[node.id])
    if (shown.type !== 'frame') return { ...shown, id }
    if (shown.instanceOf !== undefined) {
      const inner = resolveInstance({ ...shown, id }, mains, depth + 1)
      return inner
    }
    return { ...shown, id, component: undefined, children: shown.children.map((child) => prefix(child, base, overrides)) }
  }
  const { component: _main, ...style } = main
  const resolved: FrameNode = {
    ...style,
    ...own,
    w: instance.w ?? main.w,
    h: instance.h ?? main.h,
    margin: instance.margin ?? main.margin,
    grow: instance.grow ?? main.grow,
    minW: instance.minW ?? main.minW,
    maxW: instance.maxW ?? main.maxW,
    minH: instance.minH ?? main.minH,
    maxH: instance.maxH ?? main.maxH,
    linkTo: instance.linkTo ?? main.linkTo,
    // The transition goes with whichever link is drawn.
    transition: instance.linkTo !== undefined ? instance.transition : main.transition,
    instanceOf: main.id,
    overrides: undefined,
    children: main.children.map((child) => prefix(child, instance.id, instance.overrides)),
  }
  const record = resolved as Record<string, unknown>
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
  return resolved
}

/** The nodes of a main an instance can override, in reading order. */
export function overrideTargets(main: FrameNode): Array<{ id: string; node: DesignNode }> {
  const out: Array<{ id: string; node: DesignNode }> = []
  for (const { node } of walkNodes(main)) {
    if (node === main) continue
    if (node.type === 'text' || node.type === 'button' || node.type === 'image') out.push({ id: node.id, node })
  }
  return out
}

/** Sets (or with `undefined` fields, clears) one override on an instance. */
export function setOverride(
  design: Design,
  boardId: string,
  instanceId: string,
  mainNodeId: string,
  patch: InstanceOverride | null,
): Design {
  return updateBoard(design, boardId, (board) => {
    const hit = findNode(board.root, instanceId)
    if (!hit || !isInstance(hit.node)) return board
    const overrides = { ...(hit.node.overrides ?? {}) }
    const merged: InstanceOverride = patch === null ? {} : { ...(overrides[mainNodeId] ?? {}), ...patch }
    for (const key of Object.keys(merged) as Array<keyof InstanceOverride>) if (merged[key] === undefined) delete merged[key]
    if (merged.src !== undefined && patch?.placeholder !== undefined) delete merged.src
    if (merged.placeholder !== undefined && patch?.src !== undefined) delete merged.placeholder
    if (Object.keys(merged).length === 0) delete overrides[mainNodeId]
    else overrides[mainNodeId] = merged
    const next: FrameNode = { ...hit.node, overrides: Object.keys(overrides).length ? overrides : undefined }
    if (next.overrides === undefined) delete next.overrides
    return { ...board, root: swap(board.root, instanceId, next) as FrameNode }
  })
}

function swap(root: DesignNode, nodeId: string, node: DesignNode): DesignNode {
  if (root.id === nodeId) return node
  if (root.type !== 'frame') return root
  let changed = false
  const children = root.children.map((child) => {
    const next = swap(child, nodeId, node)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...root, children } : root
}

/** Marks a frame as a main component (or unmarks it, detaching its instances first). */
export function setComponent(design: Design, boardId: string, frameId: string, on: boolean): Design {
  const board = getBoard(design, boardId)
  const hit = board ? findNode(board.root, frameId) : null
  if (!hit || hit.node.type !== 'frame' || hit.node.instanceOf !== undefined) return design
  if (Boolean(hit.node.component) === on) return design
  const base = on ? design : detachInstancesOf(design, [frameId])
  return updateBoard(base, boardId, (current) => {
    const found = findNode(current.root, frameId)
    if (!found || found.node.type !== 'frame') return current
    const next: FrameNode = { ...found.node }
    if (on) next.component = true
    else delete next.component
    return { ...current, root: swap(current.root, frameId, next) as FrameNode }
  })
}

/** A new instance node of `mainId` (not yet placed). */
export function instanceNode(design: Design, mainId: string, options: { id?: string; overrides?: FrameNode['overrides'] } = {}): FrameNode | null {
  const main = collectMains(design.boards).get(mainId)
  if (!main) return null
  const id = options.id ?? freshId(allIds(design), `${main.name ?? main.id}-instance`)
  const node: FrameNode = { type: 'frame', id, layout: main.layout, instanceOf: mainId, children: [] }
  if (main.name) node.name = main.name
  if (options.overrides && Object.keys(options.overrides).length) node.overrides = options.overrides
  return node
}

/** Places an instance of `mainId` in frame `parentId`; returns its id. */
export function insertInstance(
  design: Design,
  boardId: string,
  parentId: string,
  mainId: string,
  index?: number,
): { design: Design; nodeId: string | null } {
  const node = instanceNode(design, mainId)
  const board = getBoard(design, boardId)
  const parent = board ? findNode(board.root, parentId)?.node : undefined
  if (!node || !parent || parent.type !== 'frame' || parent.instanceOf !== undefined) return { design, nodeId: null }
  if (parent.layout === 'absolute') Object.assign(node, { x: 24, y: 24 })
  return { design: insertNode(design, boardId, parentId, node, index), nodeId: node.id }
}

/**
 * The instance turned into plain nodes: the main's subtree with overrides baked in and fresh
 * ids. One level: an instance inside the main stays an instance.
 */
function detachedCopy(instance: FrameNode, main: FrameNode, taken: Set<string>): FrameNode {
  const copy = (node: DesignNode): DesignNode => {
    const shown = applyOverride(node, instance.overrides?.[node.id])
    const id = freshId(taken, shown.id.replace(/-\d+$/, ''))
    if (shown.type !== 'frame') return { ...shown, id }
    const { component: _c, ...rest } = shown
    if (shown.instanceOf !== undefined) return { ...rest, id, children: [] }
    return { ...rest, id, children: shown.children.map(copy) }
  }
  const { component: _c, instanceOf: _i, overrides: _o, ...style } = main
  const out: FrameNode = {
    ...style,
    id: instance.id,
    children: main.children.map(copy),
  }
  for (const key of ['name', 'hidden', 'x', 'y', 'w', 'h', 'grow', 'linkTo', 'minW', 'maxW', 'minH', 'maxH'] as const) {
    const value = instance[key] ?? main[key]
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
    else delete (out as Record<string, unknown>)[key]
  }
  // The transition goes with whichever link the copy keeps.
  const transition = instance.linkTo !== undefined ? instance.transition : main.transition
  if (transition !== undefined) out.transition = transition
  else delete out.transition
  return out
}

/** Detaches one instance (it keeps its id); the design is unchanged when it is not one. */
export function detachInstance(design: Design, boardId: string, instanceId: string): Design {
  const board = getBoard(design, boardId)
  const hit = board ? findNode(board.root, instanceId) : null
  if (!hit || !isInstance(hit.node)) return design
  const main = collectMains(design.boards).get(hit.node.instanceOf)
  const taken = allIds(design)
  const plain: FrameNode = main
    ? detachedCopy(hit.node, main, taken)
    : (({ instanceOf: _i, overrides: _o, ...rest }) => rest)(hit.node)
  return updateBoard(design, boardId, (current) => ({ ...current, root: swap(current.root, instanceId, plain) as FrameNode }))
}

/** Detaches every instance of the given mains (before those mains are deleted). */
export function detachInstancesOf(design: Design, mainIds: string[]): Design {
  if (mainIds.length === 0) return design
  const doomed = new Set(mainIds)
  let next = design
  for (let pass = 0; pass < 8; pass += 1) {
    const found: Array<{ boardId: string; nodeId: string }> = []
    for (const board of next.boards) {
      for (const { node } of walkNodes(board.root)) {
        if (isInstance(node) && doomed.has(node.instanceOf)) found.push({ boardId: board.id, nodeId: node.id })
      }
    }
    if (found.length === 0) break
    for (const entry of found) next = detachInstance(next, entry.boardId, entry.nodeId)
  }
  return next
}

/** removeNode that first detaches instances of any main component inside the removed subtree. */
export function removeNodeDetaching(design: Design, boardId: string, nodeId: string): Design {
  const board = getBoard(design, boardId)
  const hit = board ? findNode(board.root, nodeId) : null
  if (!hit?.parent) return design
  return removeNode(detachInstancesOf(design, mainsInSubtree(hit.node)), boardId, nodeId)
}

/** removeBoard that first detaches instances of the board's main components elsewhere. */
export function removeBoardDetaching(design: Design, boardId: string): Design {
  const board = getBoard(design, boardId)
  if (!board) return design
  return removeBoard(detachInstancesOf(design, mainsInSubtree(board.root)), boardId)
}
