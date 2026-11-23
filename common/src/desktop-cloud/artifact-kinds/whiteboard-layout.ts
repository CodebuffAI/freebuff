/**
 * Tidy up: lays a selection out afresh as a grid, a tree or a layered left-to-right flow.
 *
 * The things laid out are the selection's units (`arrangeUnits`: each element alone, a group as
 * one, arrows and locked elements left where they are). A section in the selection brings its
 * members, which are then not laid out separately. Tree and flow follow the bound arrows between
 * units (any arrow on the board joining two of them, selected or not); a cycle is broken at the
 * arrow that closes it, in reading order. The result starts at the selection's top-left, every
 * unit on the 8-unit grid, spaced as the guide advises (40 between neighbours, 80 between ranks).
 * Every function takes a valid board and returns a valid one (the same object when nothing would
 * move). Pure: no DOM.
 */

import { applyDeltas, arrangeUnits, type ArrangeUnit } from './whiteboard-arrange'
import { sectionMembers, unionRects, type GeometryContext } from './whiteboard-geometry'
import { isBoundEnd, type Point, type WhiteboardBoard } from './whiteboard'

export const TIDY_MODES = ['grid', 'tree', 'flow'] as const
export type TidyMode = (typeof TIDY_MODES)[number]

/** Between neighbours in a row, column or rank. */
export const TIDY_GAP = 40
/** Between ranks of a tree or flow: room for an arrow and its label. */
export const TIDY_RANK_GAP = 80

const GRID = 8
const snap = (v: number) => Math.round(v / GRID) * GRID

type Unit = ArrangeUnit

/** The units to lay out: members of a selected section travel with it rather than on their own. */
function tidyUnits(board: WhiteboardBoard, ids: readonly string[], ctx: GeometryContext): Unit[] {
  const chosen = new Set(ids)
  const carried = new Set<string>()
  for (const element of board.elements) {
    if (element.type !== 'section' || !chosen.has(element.id)) continue
    for (const member of sectionMembers(board.elements, element, ctx)) carried.add(member)
  }
  return arrangeUnits(board, ids, ctx).filter((unit) => !unit.ids.every((id) => carried.has(id)))
}

/** Units in reading order: rows (by overlapping vertical extent), then left to right. */
export function readingOrder<T extends { bounds: { x: number; y: number; w: number; h: number } }>(units: readonly T[]): T[] {
  const byTop = [...units].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
  const rows: T[][] = []
  let rowBottom = -Infinity
  for (const unit of byTop) {
    // A unit whose middle is above the bottom of the row's first unit joins that row.
    if (rows.length && unit.bounds.y + unit.bounds.h / 2 <= rowBottom) rows[rows.length - 1].push(unit)
    else {
      rows.push([unit])
      rowBottom = unit.bounds.y + unit.bounds.h
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.bounds.x - b.bounds.x))
}

/** Edges between units (by index), from every bound arrow on the board joining two different ones. */
function unitEdges(board: WhiteboardBoard, units: readonly Unit[]): Array<[number, number]> {
  const owner = new Map<string, number>()
  units.forEach((unit, i) => unit.ids.forEach((id) => owner.set(id, i)))
  const seen = new Set<string>()
  const edges: Array<[number, number]> = []
  for (const element of board.elements) {
    if (element.type !== 'arrow' || !isBoundEnd(element.from) || !isBoundEnd(element.to)) continue
    const a = owner.get(element.from.elementId)
    const b = owner.get(element.to.elementId)
    if (a === undefined || b === undefined || a === b || seen.has(`${a}>${b}`)) continue
    seen.add(`${a}>${b}`)
    edges.push([a, b])
  }
  return edges
}

/**
 * Drops the edges that close a cycle, leaving a DAG. The depth-first search starts from the units
 * nothing points at, then from those that point out the most, then in reading order, so in a
 * loop the unit that looks most like a start keeps its outgoing arrows.
 */
function acyclic(count: number, edges: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const out: number[][] = Array.from({ length: count }, () => [])
  const balance = new Array<number>(count).fill(0)
  const indegree = new Array<number>(count).fill(0)
  for (const [a, b] of edges) {
    out[a].push(b)
    balance[a]++
    balance[b]--
    indegree[b]++
  }
  const order = Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => Number(indegree[a] > 0) - Number(indegree[b] > 0) || balance[b] - balance[a] || a - b,
  )
  const state = new Uint8Array(count) // 0 new, 1 on the stack, 2 done
  const kept: Array<[number, number]> = []
  for (const root of order) {
    if (state[root]) continue
    // Iterative DFS: [node, next child index].
    const stack: Array<[number, number]> = [[root, 0]]
    state[root] = 1
    while (stack.length) {
      const top = stack[stack.length - 1]
      const [node, k] = top
      if (k >= out[node].length) {
        state[node] = 2
        stack.pop()
        continue
      }
      top[1]++
      const child = out[node][k]
      if (state[child] === 1) continue // a back edge: drop it
      kept.push([node, child])
      if (state[child] === 0) {
        state[child] = 1
        stack.push([child, 0])
      }
    }
  }
  return kept
}

/** Moves each unit so its top-left lands on `targets[i]`. */
function placeUnits(board: WhiteboardBoard, units: readonly Unit[], targets: readonly Point[], ctx: GeometryContext) {
  const moves = units.map((unit, i) => ({ unit, dx: targets[i].x - unit.bounds.x, dy: targets[i].y - unit.bounds.y }))
  if (moves.every((move) => Math.abs(move.dx) < 0.05 && Math.abs(move.dy) < 0.05)) return board
  return applyDeltas(board, moves, ctx)
}

/** A near-square grid in reading order, each unit centred in an equal cell. */
function gridTargets(units: readonly Unit[], origin: Point): Point[] {
  const cols = Math.ceil(Math.sqrt(units.length))
  const cellW = Math.max(...units.map((u) => u.bounds.w))
  const cellH = Math.max(...units.map((u) => u.bounds.h))
  return units.map((unit, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      x: snap(origin.x + col * (cellW + TIDY_GAP) + (cellW - unit.bounds.w) / 2),
      y: snap(origin.y + row * (cellH + TIDY_GAP) + (cellH - unit.bounds.h) / 2),
    }
  })
}

/**
 * A top-down tree: roots are units nothing points at (or, in a pure cycle, the first in reading
 * order), each child under the parent that reaches it first; a parent is centred over its children.
 */
function treeTargets(units: readonly Unit[], edges: ReadonlyArray<[number, number]>, origin: Point): Point[] {
  const n = units.length
  const dag = acyclic(n, edges)
  const children: number[][] = Array.from({ length: n }, () => [])
  const out: number[][] = Array.from({ length: n }, () => [])
  const placed = new Uint8Array(n)
  const roots: number[] = []
  const incoming = new Uint8Array(n)
  for (const [a, b] of dag) {
    incoming[b] = 1
    out[a].push(b)
  }
  const visit = (root: number) => {
    // Breadth-first, so a unit hangs under the shallowest parent that reaches it.
    placed[root] = 1
    roots.push(root)
    const queue = [root]
    for (let q = 0; q < queue.length; q++) {
      const node = queue[q]
      const next = out[node].filter((b) => !placed[b])
      next.sort((a, b) => units[a].bounds.x - units[b].bounds.x || units[a].bounds.y - units[b].bounds.y)
      for (const child of next) {
        if (placed[child]) continue
        placed[child] = 1
        children[node].push(child)
        queue.push(child)
      }
    }
  }
  for (let i = 0; i < n; i++) if (!incoming[i] && !placed[i]) visit(i)
  for (let i = 0; i < n; i++) if (!placed[i]) visit(i)
  // Depth of each node and the height of each depth's row.
  const depth = new Array<number>(n).fill(0)
  const rowH: number[] = []
  const walk = (node: number, d: number) => {
    depth[node] = d
    rowH[d] = Math.max(rowH[d] ?? 0, units[node].bounds.h)
    for (const child of children[node]) walk(child, d + 1)
  }
  for (const root of roots) walk(root, 0)
  const rowY: number[] = []
  rowH.forEach((h, d) => (rowY[d] = d === 0 ? origin.y : rowY[d - 1] + rowH[d - 1] + TIDY_RANK_GAP))
  // Subtree widths, then left-to-right placement.
  const width = new Array<number>(n).fill(0)
  const measure = (node: number): number => {
    const kids = children[node].map(measure)
    const span = kids.reduce((s, w) => s + w, 0) + Math.max(0, kids.length - 1) * TIDY_GAP
    width[node] = Math.max(units[node].bounds.w, span)
    return width[node]
  }
  const targets: Point[] = new Array(n)
  const place = (node: number, left: number) => {
    const w = units[node].bounds.w
    targets[node] = { x: snap(left + (width[node] - w) / 2), y: snap(rowY[depth[node]]) }
    const span = children[node].reduce((s, c) => s + width[c], 0) + Math.max(0, children[node].length - 1) * TIDY_GAP
    let x = left + (width[node] - span) / 2
    for (const child of children[node]) {
      place(child, x)
      x += width[child] + TIDY_GAP
    }
  }
  let left = origin.x
  for (const root of roots) {
    measure(root)
    place(root, left)
    left += width[root] + TIDY_RANK_GAP
  }
  return targets
}

/**
 * A layered flow, left to right: each unit's rank is the longest chain of arrows into it, ranks
 * sit `TIDY_RANK_GAP` apart, and within a rank units are ordered by where their predecessors sit
 * (then by their old height on the board) and centred on one midline.
 */
function flowTargets(units: readonly Unit[], edges: ReadonlyArray<[number, number]>, origin: Point): Point[] {
  const n = units.length
  const dag = acyclic(n, edges)
  const preds: number[][] = Array.from({ length: n }, () => [])
  const succs: number[][] = Array.from({ length: n }, () => [])
  const indegree = new Array<number>(n).fill(0)
  for (const [a, b] of dag) {
    preds[b].push(a)
    succs[a].push(b)
    indegree[b]++
  }
  const rank = new Array<number>(n).fill(0)
  const queue: number[] = []
  for (let i = 0; i < n; i++) if (indegree[i] === 0) queue.push(i)
  for (let q = 0; q < queue.length; q++) {
    const node = queue[q]
    for (const next of succs[node]) {
      rank[next] = Math.max(rank[next], rank[node] + 1)
      if (--indegree[next] === 0) queue.push(next)
    }
  }
  const ranks: number[][] = []
  for (let i = 0; i < n; i++) (ranks[rank[i]] ??= []).push(i)
  const slot = new Array<number>(n).fill(0)
  ranks.forEach((members, r) => {
    const key = (i: number) => {
      if (r === 0 || preds[i].length === 0) return Infinity
      return preds[i].reduce((s, p) => s + slot[p], 0) / preds[i].length
    }
    members.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      if (ka !== kb) return ka === Infinity ? 1 : kb === Infinity ? -1 : ka - kb
      return units[a].bounds.y - units[b].bounds.y || units[a].bounds.x - units[b].bounds.x
    })
    members.forEach((i, k) => (slot[i] = k))
  })
  const rankW = ranks.map((members) => Math.max(...members.map((i) => units[i].bounds.w)))
  const rankH = ranks.map(
    (members) => members.reduce((s, i) => s + units[i].bounds.h, 0) + (members.length - 1) * TIDY_GAP,
  )
  const tallest = Math.max(...rankH)
  const targets: Point[] = new Array(n)
  let x = origin.x
  ranks.forEach((members, r) => {
    let y = origin.y + (tallest - rankH[r]) / 2
    for (const i of members) {
      const u = units[i].bounds
      targets[i] = { x: snap(x + (rankW[r] - u.w) / 2), y: snap(y) }
      y += u.h + TIDY_GAP
    }
    x += rankW[r] + TIDY_RANK_GAP
  })
  return targets
}

/**
 * Lays the selection out as a grid, a tree or a flow (see the file comment). Needs two or more
 * unlocked units; returns `board` itself when there are fewer or nothing would move.
 */
export function tidyElements(
  board: WhiteboardBoard,
  ids: readonly string[],
  mode: TidyMode,
  ctx: GeometryContext,
): WhiteboardBoard {
  const units = readingOrder(tidyUnits(board, ids, ctx))
  if (units.length < 2) return board
  const all = unionRects(units.map((unit) => unit.bounds))!
  const origin = { x: snap(all.x), y: snap(all.y) }
  const targets =
    mode === 'grid'
      ? gridTargets(units, origin)
      : mode === 'tree'
        ? treeTargets(units, unitEdges(board, units), origin)
        : flowTargets(units, unitEdges(board, units), origin)
  return placeUnits(board, units, targets, ctx)
}
