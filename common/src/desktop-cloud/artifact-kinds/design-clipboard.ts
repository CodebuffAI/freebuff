import { z } from 'zod/v4'
import {
  DESIGN_LIMITS,
  HEX,
  collectMains,
  nodeSchema,
  type Design,
  type DesignNode,
  type DesignStyles,
  type DesignTokens,
  type FrameNode,
} from './design'
import { resolveInstance } from './design-components'
import { bakeStyles } from './design-resolve'
import { allIds, findNode, getBoard, insertNode, reidSubtree } from './design-tree'

/**
 * Node copy and paste (Cmd+C / Cmd+V), within a design and between designs. The clipboard holds
 * plain JSON text: the copied nodes, the source's tokens and styles, and a self-contained copy of
 * each node (instances expanded) for a design that lacks their main. Paste gives fresh ids,
 * resolves colour tokens and styles the target lacks to their values, and drops links to boards
 * the target does not have, so a paste always validates. Pure.
 */

export const CLIPBOARD_KIND = 'freebuff-design-nodes'

export type ClipboardPayload = {
  kind: typeof CLIPBOARD_KIND
  version: 1
  nodes: DesignNode[]
  /** Each node with every instance expanded into plain frames (same order as `nodes`). */
  plain: DesignNode[]
  tokens?: DesignTokens
  styles?: DesignStyles
}

function expandInstances(node: DesignNode, mains: ReadonlyMap<string, FrameNode>, depth = 0): DesignNode {
  // Drawn ids inside an instance read `<instance>~<node>`; a stored id cannot hold "~".
  const id = node.id.replace(/~/g, '-').slice(0, 64)
  if (node.type !== 'frame' || depth > DESIGN_LIMITS.maxDepth) return { ...node, id }
  if (node.instanceOf !== undefined) {
    const drawn = resolveInstance(node, mains)
    const { instanceOf: _i, overrides: _o, ...plain } = drawn
    return { ...plain, id, children: plain.children.map((child) => expandInstances(child, mains, depth + 1)) }
  }
  return { ...node, id, children: node.children.map((child) => expandInstances(child, mains, depth + 1)) }
}

/** The clipboard text for nodes on one board (unknown ids are skipped); null when none. */
export function copyNodes(design: Design, boardId: string, nodeIds: string[]): string | null {
  const board = getBoard(design, boardId)
  if (!board) return null
  const nodes = nodeIds.flatMap((id) => {
    const hit = findNode(board.root, id)
    return hit && hit.parent ? [hit.node] : []
  })
  if (nodes.length === 0) return null
  const mains = collectMains(design.boards)
  const payload: ClipboardPayload = {
    kind: CLIPBOARD_KIND,
    version: 1,
    nodes,
    plain: nodes.map((node) => expandInstances(node, mains)),
    ...(design.tokens ? { tokens: design.tokens } : {}),
    ...(design.styles ? { styles: design.styles } : {}),
  }
  return JSON.stringify(payload)
}

const payloadSchema = z.object({
  kind: z.literal(CLIPBOARD_KIND),
  version: z.literal(1),
  nodes: z.array(nodeSchema).min(1).max(DESIGN_LIMITS.maxChildren),
  plain: z.array(nodeSchema).min(1).max(DESIGN_LIMITS.maxChildren),
  tokens: z.unknown().optional(),
  styles: z.unknown().optional(),
})

/** Clipboard text back into a payload, or null when it is not one of ours (or not valid). */
export function parseClipboard(text: string): ClipboardPayload | null {
  if (text.length > DESIGN_LIMITS.maxBytes || !text.includes(CLIPBOARD_KIND)) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = payloadSchema.safeParse(value)
  if (!parsed.success || parsed.data.nodes.length !== parsed.data.plain.length) return null
  const tokens = isRecord(parsed.data.tokens) && isRecord(parsed.data.tokens.colors) ? (parsed.data.tokens as DesignTokens) : undefined
  const styles = isRecord(parsed.data.styles) ? (parsed.data.styles as DesignStyles) : undefined
  return { kind: CLIPBOARD_KIND, version: 1, nodes: parsed.data.nodes, plain: parsed.data.plain, tokens, styles }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const COLOR_KEYS = ['fill', 'stroke', 'color'] as const

/** A node fitted to the target design: tokens, styles, links and mains it lacks resolved away. */
function rehome(node: DesignNode, target: Design, source: { tokens?: DesignTokens; styles?: DesignStyles }, boards: Set<string>): DesignNode {
  const ownTokens = target.tokens?.colors ?? {}
  const textIds = new Set((target.styles?.text ?? []).map((style) => style.id))
  const fillIds = new Set((target.styles?.fills ?? []).map((style) => style.id))
  const fixColor = (value: unknown): unknown => {
    if (typeof value !== 'string' || HEX.test(value) || value === 'transparent' || Object.hasOwn(ownTokens, value)) return value
    return source.tokens?.colors[value] ?? '#888888'
  }
  const visit = (raw: DesignNode): DesignNode => {
    let current = raw
    // A style the target lacks is baked in from the source's definition.
    if (current.type === 'text' && current.textStyle !== undefined && !textIds.has(current.textStyle)) current = bakeStyles(current, source.styles)
    if ((current.type === 'frame' || current.type === 'shape') && current.fillStyle !== undefined && !fillIds.has(current.fillStyle)) current = bakeStyles(current, source.styles)
    const record: Record<string, unknown> = { ...current }
    for (const key of COLOR_KEYS) if (key in record) record[key] = fixColor(record[key])
    const gradient = record.gradient as { from: string; to: string; angle?: number } | undefined
    if (gradient) record.gradient = { ...gradient, from: fixColor(gradient.from), to: fixColor(gradient.to) }
    if (typeof record.linkTo === 'string' && !boards.has(record.linkTo)) {
      delete record.linkTo
      delete record.transition
    }
    if (current.type === 'frame') record.children = current.children.map(visit)
    return record as DesignNode
  }
  return visit(node)
}

function missingMain(node: DesignNode, mains: ReadonlyMap<string, FrameNode>): boolean {
  if (node.type !== 'frame') return false
  if (node.instanceOf !== undefined && !mains.has(node.instanceOf)) return true
  return node.children.some((child) => missingMain(child, mains))
}

/**
 * Pastes a payload into `parentId` on `boardId` (after `index` children, or at the end) with
 * fresh ids; returns the new top-level ids (empty when nothing fits). An absolute parent keeps
 * the copies' x/y nudged by 16 px; any other parent takes them in its flow.
 */
export function pasteNodes(
  design: Design,
  target: { boardId: string; parentId: string; index?: number },
  payload: ClipboardPayload,
): { design: Design; ids: string[] } {
  const board = getBoard(design, target.boardId)
  const parent = board ? findNode(board.root, target.parentId)?.node : undefined
  if (!board || !parent || parent.type !== 'frame' || parent.instanceOf !== undefined) return { design, ids: [] }
  const room = DESIGN_LIMITS.maxChildren - parent.children.length
  if (room <= 0) return { design, ids: [] }
  const mains = collectMains(design.boards)
  const boards = new Set(design.boards.map((entry) => entry.id))
  const taken = allIds(design)
  let next = design
  let index = target.index
  const ids: string[] = []
  payload.nodes.slice(0, room).forEach((raw, i) => {
    const chosen = missingMain(raw, mains) ? payload.plain[i] : raw
    let node = reidSubtree(rehome(chosen, design, payload, boards), taken)
    if (parent.layout === 'absolute') node = { ...node, x: (node.x ?? 0) + 16, y: (node.y ?? 0) + 16 }
    else if (!node.absolute) {
      const { x: _x, y: _y, ...rest } = node
      node = rest as DesignNode
    }
    next = insertNode(next, target.boardId, target.parentId, node, index)
    if (index !== undefined) index += 1
    ids.push(node.id)
  })
  return { design: next, ids }
}
