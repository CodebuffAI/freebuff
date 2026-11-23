import type { DesignBoard, DesignNode } from './design'

/**
 * What changed on one board between two revisions, by node id: added, removed and changed
 * layers (a change is any own field: text, colour, size, place; children order counts on the
 * frame). Pure; the compare view lists these beside the visual overlay.
 */
export type BoardDiff = {
  added: Array<{ id: string; label: string }>
  removed: Array<{ id: string; label: string }>
  changed: Array<{ id: string; label: string; fields: string[] }>
  /** Board fields (size, background, theme…) that changed. */
  board: string[]
}

const labelOf = (node: DesignNode) => node.name ?? (node.type === 'text' ? `“${node.text.slice(0, 32)}”` : node.type === 'button' ? `button “${node.label}”` : `${node.type} ${node.id}`)

function flatten(board: DesignBoard | undefined): Map<string, DesignNode> {
  const out = new Map<string, DesignNode>()
  if (!board) return out
  const stack: DesignNode[] = [board.root]
  while (stack.length) {
    const node = stack.pop()!
    out.set(node.id, node)
    if (node.type === 'frame') stack.push(...node.children)
  }
  return out
}

export function diffBoard(before: DesignBoard | undefined, after: DesignBoard | undefined): BoardDiff {
  const a = flatten(before)
  const b = flatten(after)
  const diff: BoardDiff = { added: [], removed: [], changed: [], board: [] }
  for (const [id, node] of b) if (!a.has(id)) diff.added.push({ id, label: labelOf(node) })
  for (const [id, node] of a) if (!b.has(id)) diff.removed.push({ id, label: labelOf(node) })
  for (const [id, node] of b) {
    const old = a.get(id)
    if (!old) continue
    const fields = new Set<string>()
    const own = (value: DesignNode) => Object.entries(value).filter(([key]) => key !== 'children')
    const left = new Map(own(old))
    const right = new Map(own(node))
    for (const key of new Set([...left.keys(), ...right.keys()])) if (JSON.stringify(left.get(key)) !== JSON.stringify(right.get(key))) fields.add(key)
    if (old.type === 'frame' && node.type === 'frame' && old.children.map((c) => c.id).join() !== node.children.map((c) => c.id).join()) fields.add('children')
    if (fields.size) diff.changed.push({ id, label: labelOf(node), fields: [...fields].sort() })
  }
  if (before && after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (key === 'root') continue
      if (JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key])) diff.board.push(key)
    }
  }
  return diff
}
