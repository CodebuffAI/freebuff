import { collectMains, type Design, type DesignNode, type FrameNode, type InstanceOverride } from './design'
import { isInstance, overrideTargets } from './design-components'
import { findNode, getBoard, updateBoard } from './design-tree'

/**
 * Variants and instance swap. A VARIANT is a main component named "<Group> / <Variant>"
 * ("Button / Primary", "Button / Secondary"): mains that share a group are one component's
 * variants. Swapping an instance points it at another main (a variant, or any main) and carries
 * its content overrides across by the target's matching node: the same id, else the same layer
 * name and type, else the same type at the same position among that type. No new fields: a
 * variant is a naming convention on mains, so every stored body is already valid.
 */

export const VARIANT_SEP = '/'

/** "Button / Primary" → { group: "Button", variant: "Primary" }; a plain name has no variant. */
export function variantName(name: string | undefined): { group: string; variant: string | null } {
  const raw = (name ?? '').trim()
  const at = raw.indexOf(VARIANT_SEP)
  if (at === -1) return { group: raw, variant: null }
  const group = raw.slice(0, at).trim()
  const variant = raw.slice(at + 1).trim()
  return group && variant ? { group, variant } : { group: raw, variant: null }
}

/** The mains in `mainId`'s variant group (itself included), by variant name; just it when ungrouped. */
export function variantsOf(mains: ReadonlyMap<string, FrameNode>, mainId: string): FrameNode[] {
  const main = mains.get(mainId)
  if (!main) return []
  const { group, variant } = variantName(main.name)
  if (variant === null) return [main]
  return [...mains.values()]
    .filter((other) => {
      const named = variantName(other.name)
      return named.variant !== null && named.group.toLowerCase() === group.toLowerCase()
    })
    .sort((a, b) => (variantName(a.name).variant ?? '').localeCompare(variantName(b.name).variant ?? ''))
}

/** Whether `mainId`'s subtree holds (through instances) an instance of `targetId`, or is it. */
function reaches(mains: ReadonlyMap<string, FrameNode>, mainId: string, targetId: string, seen = new Set<string>()): boolean {
  if (mainId === targetId) return true
  if (seen.has(mainId)) return false
  seen.add(mainId)
  const main = mains.get(mainId)
  if (!main) return false
  const stack: DesignNode[] = [...main.children]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type !== 'frame') continue
    if (node.instanceOf !== undefined && reaches(mains, node.instanceOf, targetId, seen)) return true
    stack.push(...node.children)
  }
  return false
}

/** Overrides re-keyed from one main's nodes to another's (unmatched ones are dropped). */
export function carryOverrides(
  overrides: Record<string, InstanceOverride> | undefined,
  from: FrameNode | undefined,
  to: FrameNode,
): Record<string, InstanceOverride> | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return undefined
  const targets = overrideTargets(to)
  const sources = from ? overrideTargets(from) : []
  const ordinal = (list: Array<{ id: string; node: DesignNode }>, id: string) => {
    const item = list.find((entry) => entry.id === id)
    if (!item) return -1
    return list.filter((entry) => entry.node.type === item.node.type).findIndex((entry) => entry.id === id)
  }
  const out: Record<string, InstanceOverride> = {}
  const used = new Set<string>()
  const entries = Object.entries(overrides)
  const matched = new Map<string, { id: string; node: DesignNode }>()
  // Pass 1: the same id, else the same layer name and type.
  for (const [key] of entries) {
    const source = sources.find((entry) => entry.id === key)
    let match = targets.find((entry) => entry.id === key && !used.has(entry.id))
    if (!match && source?.node.name) match = targets.find((entry) => !used.has(entry.id) && entry.node.type === source.node.type && entry.node.name === source.node.name)
    if (match) {
      used.add(match.id)
      matched.set(key, match)
    }
  }
  // Pass 2: the same position among that type, else the first free node of that type.
  for (const [key] of entries) {
    if (matched.has(key)) continue
    const source = sources.find((entry) => entry.id === key)
    if (!source) continue
    const sameType = targets.filter((entry) => entry.node.type === source.node.type)
    let match: { id: string; node: DesignNode } | undefined = sameType[ordinal(sources, key)]
    if (!match || used.has(match.id)) match = sameType.find((entry) => !used.has(entry.id))
    if (match) {
      used.add(match.id)
      matched.set(key, match)
    }
  }
  for (const [key, value] of entries) {
    const match = matched.get(key)
    if (!match) continue
    // Only the fields that kind of node takes.
    const kept: InstanceOverride = {}
    if (match.node.type === 'text' && value.text !== undefined) kept.text = value.text
    if (match.node.type === 'button' && value.label !== undefined) kept.label = value.label
    if (match.node.type === 'image') {
      if (value.src !== undefined) kept.src = value.src
      else if (value.placeholder !== undefined) kept.placeholder = value.placeholder
      if (value.alt !== undefined) kept.alt = value.alt
    }
    if (Object.keys(kept).length > 0) out[match.id] = kept
  }
  return Object.keys(out).length ? out : undefined
}

export type SwapResult = { ok: true; design: Design } | { ok: false; reason: string }

/**
 * Points instance `instanceId` at main `mainId`, carrying its overrides across. Refused (with a
 * reason) when the node is not an instance, the target is not a main, or the swap would put a
 * main inside itself.
 */
export function swapInstance(design: Design, boardId: string, instanceId: string, mainId: string): SwapResult {
  const board = getBoard(design, boardId)
  const hit = board ? findNode(board.root, instanceId) : null
  if (!board || !hit) return { ok: false, reason: `board "${boardId}" has no node "${instanceId}"` }
  if (!isInstance(hit.node)) return { ok: false, reason: `"${instanceId}" is not an instance` }
  const mains = collectMains(design.boards)
  const target = mains.get(mainId)
  if (!target) return { ok: false, reason: `"${mainId}" is not a main component` }
  if (hit.node.instanceOf === mainId) return { ok: true, design }
  // Every main that holds this instance (an ancestor marked component) must not be reachable from the target.
  const chain: FrameNode[] = []
  const visit = (node: DesignNode): boolean => {
    if (node.id === instanceId) return true
    if (node.type !== 'frame') return false
    chain.push(node)
    for (const child of node.children) if (visit(child)) return true
    chain.pop()
    return false
  }
  visit(board.root)
  for (const ancestor of chain) {
    if (ancestor.component && reaches(mains, mainId, ancestor.id)) {
      return { ok: false, reason: `an instance of "${target.name ?? mainId}" cannot go inside the main "${ancestor.name ?? ancestor.id}" it contains` }
    }
  }
  const overrides = carryOverrides(hit.node.overrides, mains.get(hit.node.instanceOf), target)
  const next: FrameNode = { ...hit.node, instanceOf: mainId, layout: target.layout }
  if (overrides) next.overrides = overrides
  else delete next.overrides
  // An instance named after its old main follows the new one's name.
  const oldMain = mains.get(hit.node.instanceOf)
  if (hit.node.name !== undefined && oldMain && hit.node.name === oldMain.name) {
    if (target.name) next.name = target.name
    else delete next.name
  }
  const swapped = updateBoard(design, boardId, (current) => {
    const replace = (node: DesignNode): DesignNode => {
      if (node.id === instanceId) return next
      if (node.type !== 'frame') return node
      return { ...node, children: node.children.map(replace) }
    }
    return { ...current, root: replace(current.root) as FrameNode }
  })
  return { ok: true, design: swapped }
}
