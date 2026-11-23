/**
 * Arranging a board: groups, locks, align and distribute, sticky stacks, table edits and link
 * cards. Every function takes a valid board and returns a valid one. Pure: no DOM.
 *
 * Groups: an element's `groups` lists its groups innermost first. Selecting an element selects
 * its outermost group; grouping wraps the selection in a new outer group; ungrouping removes the
 * outermost group of each selected element. Locks are honoured by the editor (a locked element is
 * never moved, resized, edited or deleted from the canvas); the board model itself does not
 * refuse an edit to one, so an agent can still restyle it.
 */

import { contentBounds, elementBounds, unionRects, type GeometryContext, withSectionMembers } from './whiteboard-geometry'
import { boardIds, mintId, translateElements } from './whiteboard-ops'
import { plainRichText } from './whiteboard-richtext'
import {
  isAllowedLinkUrl,
  MAX_ELEMENTS,
  MAX_GROUP_DEPTH,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  type LinkElement,
  type NoteElement,
  type Point,
  type Rect,
  type TableElement,
  type WhiteboardBoard,
  type WhiteboardColor,
  type WhiteboardElement,
} from './whiteboard'

// ---- groups

export function outermostGroup(element: WhiteboardElement): string | undefined {
  return element.groups?.[element.groups.length - 1]
}

/** `ids` plus every element that shares the outermost group of any of them. */
export function expandToGroups(board: WhiteboardBoard, ids: readonly string[]): string[] {
  const chosen = new Set(ids)
  const groups = new Set<string>()
  for (const element of board.elements) {
    if (!chosen.has(element.id)) continue
    const group = outermostGroup(element)
    if (group) groups.add(group)
  }
  if (groups.size === 0) return [...ids]
  const out = [...ids]
  for (const element of board.elements) {
    if (chosen.has(element.id)) continue
    const group = outermostGroup(element)
    if (group && groups.has(group)) {
      out.push(element.id)
      chosen.add(element.id)
    }
  }
  return out
}

/** Whether `ids` (two or more elements) already form exactly one outermost group. */
export function isOneGroup(board: WhiteboardBoard, ids: readonly string[]): boolean {
  if (ids.length < 2) return false
  const chosen = new Set(ids)
  const picked = board.elements.filter((element) => chosen.has(element.id))
  const group = picked[0] ? outermostGroup(picked[0]) : undefined
  if (!group || !picked.every((element) => outermostGroup(element) === group)) return false
  return board.elements.every((element) => chosen.has(element.id) || outermostGroup(element) !== group)
}

/** Wraps `ids` in a new outer group. Returns the board and the group id (null when nothing changed). */
export function groupElements(
  board: WhiteboardBoard,
  ids: readonly string[],
  groupId?: string,
): { board: WhiteboardBoard; groupId: string | null } {
  const chosen = new Set(ids)
  const picked = board.elements.filter((element) => chosen.has(element.id))
  if (picked.length < 2) return { board, groupId: null }
  if (picked.some((element) => (element.groups?.length ?? 0) >= MAX_GROUP_DEPTH)) return { board, groupId: null }
  const id = groupId ?? mintId('group', new Set([...boardIds(board), ...allGroups(board)]))
  return {
    board: {
      ...board,
      elements: board.elements.map((element) =>
        chosen.has(element.id) ? { ...element, groups: [...(element.groups ?? []), id] } : element,
      ),
    },
    groupId: id,
  }
}

/** Removes the outermost group of each element in `ids` (from every member of those groups). */
export function ungroupElements(board: WhiteboardBoard, ids: readonly string[]): WhiteboardBoard {
  const chosen = new Set(ids)
  const groups = new Set<string>()
  for (const element of board.elements) {
    const group = chosen.has(element.id) ? outermostGroup(element) : undefined
    if (group) groups.add(group)
  }
  if (groups.size === 0) return board
  return {
    ...board,
    elements: board.elements.map((element) => {
      const group = outermostGroup(element)
      if (!group || !groups.has(group)) return element
      const rest = element.groups!.slice(0, -1)
      const next = { ...element } as WhiteboardElement
      if (rest.length > 0) next.groups = rest
      else delete next.groups
      return next
    }),
  }
}

export function allGroups(board: WhiteboardBoard): Set<string> {
  const out = new Set<string>()
  for (const element of board.elements) for (const group of element.groups ?? []) out.add(group)
  return out
}

// ---- locks

export const isLocked = (element: WhiteboardElement | undefined) => element?.locked === true

/** Sets or clears `locked` on `ids`. */
export function setLocked(board: WhiteboardBoard, ids: readonly string[], locked: boolean): WhiteboardBoard {
  const chosen = new Set(ids)
  let changed = false
  const elements = board.elements.map((element) => {
    if (!chosen.has(element.id) || isLocked(element) === locked) return element
    changed = true
    const next = { ...element } as WhiteboardElement
    if (locked) next.locked = true
    else delete next.locked
    return next
  })
  return changed ? { ...board, elements } : board
}

/** The ids in `ids` that are not locked. */
export function unlockedIds(board: WhiteboardBoard, ids: Iterable<string>): string[] {
  const byId = new Map(board.elements.map((element) => [element.id, element]))
  return [...ids].filter((id) => !isLocked(byId.get(id)))
}

// ---- align and distribute

export const ALIGN_MODES = ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const
export type AlignMode = (typeof ALIGN_MODES)[number]
export const ARRANGE_MODES = [...ALIGN_MODES, 'distribute-horizontal', 'distribute-vertical'] as const
export type ArrangeMode = (typeof ARRANGE_MODES)[number]

export type ArrangeUnit = { ids: string[]; bounds: Rect }
type Unit = ArrangeUnit

/**
 * The things align and distribute move: each selected element on its own, except that the
 * members of one outermost group move as one. Arrows are left out (bound ends follow their
 * elements) and locked elements stay where they are.
 */
export function arrangeUnits(board: WhiteboardBoard, ids: readonly string[], ctx: GeometryContext): Unit[] {
  const chosen = new Set(ids)
  const units = new Map<string, WhiteboardElement[]>()
  for (const element of board.elements) {
    if (!chosen.has(element.id) || element.type === 'arrow' || isLocked(element)) continue
    const key = outermostGroup(element) ?? `#${element.id}`
    const list = units.get(key)
    if (list) list.push(element)
    else units.set(key, [element])
  }
  return [...units.values()].map((members) => ({
    ids: members.map((element) => element.id),
    bounds: unionRects(members.map((element) => elementBounds(element, ctx)))!,
  }))
}

/** Moves each unit by its own delta; a section brings its members (each element moves once). */
export function applyDeltas(
  board: WhiteboardBoard,
  moves: ReadonlyArray<{ unit: Unit; dx: number; dy: number }>,
  ctx: GeometryContext,
): WhiteboardBoard {
  const claimed = new Set<string>()
  let next = board
  for (const { unit, dx, dy } of moves) {
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
      for (const id of unit.ids) claimed.add(id)
      continue
    }
    const moving = new Set(
      withSectionMembers(board.elements, unit.ids, ctx).filter((id) => !claimed.has(id) && !isLocked(ctx.byId.get(id))),
    )
    for (const id of moving) claimed.add(id)
    next = translateElements(next, moving, dx, dy)
  }
  return next
}

/**
 * Aligns or distributes the selection. Align lines every unit up with the selection's own edge
 * or centre; distribute spaces three or more units with equal gaps between their first and last.
 */
export function arrangeElements(
  board: WhiteboardBoard,
  ids: readonly string[],
  mode: ArrangeMode,
  ctx: GeometryContext,
): WhiteboardBoard {
  const units = arrangeUnits(board, ids, ctx)
  if (units.length < 2) return board
  if (mode === 'distribute-horizontal' || mode === 'distribute-vertical') {
    if (units.length < 3) return board
    const x = mode === 'distribute-horizontal'
    const sorted = [...units].sort((a, b) => (x ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y))
    const start = x ? sorted[0].bounds.x : sorted[0].bounds.y
    const last = sorted[sorted.length - 1].bounds
    const end = x ? last.x + last.w : last.y + last.h
    const used = sorted.reduce((sum, unit) => sum + (x ? unit.bounds.w : unit.bounds.h), 0)
    const gap = (end - start - used) / (sorted.length - 1)
    let at = start
    const moves = sorted.map((unit) => {
      const delta = at - (x ? unit.bounds.x : unit.bounds.y)
      at += (x ? unit.bounds.w : unit.bounds.h) + gap
      return { unit, dx: x ? delta : 0, dy: x ? 0 : delta }
    })
    return applyDeltas(board, moves, ctx)
  }
  const all = unionRects(units.map((unit) => unit.bounds))!
  const moves = units.map((unit) => {
    const r = unit.bounds
    switch (mode) {
      case 'left':
        return { unit, dx: all.x - r.x, dy: 0 }
      case 'center':
        return { unit, dx: all.x + all.w / 2 - (r.x + r.w / 2), dy: 0 }
      case 'right':
        return { unit, dx: all.x + all.w - (r.x + r.w), dy: 0 }
      case 'top':
        return { unit, dx: 0, dy: all.y - r.y }
      case 'middle':
        return { unit, dx: 0, dy: all.y + all.h / 2 - (r.y + r.h / 2) }
      case 'bottom':
        return { unit, dx: 0, dy: all.y + all.h - (r.y + r.h) }
    }
  })
  return applyDeltas(board, moves, ctx)
}

// ---- sticky stacks

export const NOTE_SIZE = 200
export const NOTE_GAP = 40

const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/**
 * Where the note after `note` goes (Tab while writing one): to its right, a gap away, stepping
 * further right past anything in the way (sections are not in the way: notes sit inside them).
 */
export function nextNoteSpot(board: WhiteboardBoard, note: NoteElement, ctx: GeometryContext): Point {
  const obstacles = board.elements
    .filter((element) => element.id !== note.id && element.type !== 'arrow' && element.type !== 'section')
    .map((element) => elementBounds(element, ctx))
  let x = note.x + note.w + NOTE_GAP
  for (let tries = 0; tries < 50; tries++) {
    const box = { x, y: note.y, w: note.w, h: note.h }
    const hit = obstacles.find((r) => overlaps(box, r))
    if (!hit) return { x, y: note.y }
    x = hit.x + hit.w + NOTE_GAP
  }
  return { x, y: note.y }
}

/**
 * `count` empty notes in rows of up to five, the first at `origin` (top-left), in one edit.
 * Returns the board and the new ids (fewer when the board fills up).
 */
export function stackNotes(
  board: WhiteboardBoard,
  origin: Point,
  count: number,
  color: WhiteboardColor,
  perRow = 5,
): { board: WhiteboardBoard; ids: string[] } {
  const room = Math.max(0, Math.min(count, MAX_ELEMENTS - board.elements.length))
  const taken = boardIds(board)
  const notes: NoteElement[] = []
  for (let i = 0; i < room; i++) {
    notes.push({
      type: 'note',
      id: mintId('note', taken),
      x: Math.round(origin.x + (i % perRow) * (NOTE_SIZE + NOTE_GAP)),
      y: Math.round(origin.y + Math.floor(i / perRow) * (NOTE_SIZE + NOTE_GAP)),
      w: NOTE_SIZE,
      h: NOTE_SIZE,
      text: '',
      color,
    })
  }
  if (notes.length === 0) return { board, ids: [] }
  return { board: { ...board, elements: [...board.elements, ...notes] }, ids: notes.map((note) => note.id) }
}

// ---- tables

export function tableSize(table: TableElement): { rows: number; cols: number } {
  return { rows: table.rows.length, cols: table.rows[0]?.length ?? 0 }
}

/**
 * A table's column (or row) shares, summing to 1 (round 5). `colWidths` / `rowHeights` are
 * relative weights; absent, or of the wrong length (a key-by-key merge, a generic `set`), they
 * are equal: a mismatch never breaks a board, it only draws evenly.
 */
export function tableShares(weights: readonly number[] | undefined, count: number): number[] {
  const n = Math.max(1, count)
  if (!weights || weights.length !== n || weights.some((w) => !(w > 0))) return Array.from({ length: n }, () => 1 / n)
  const total = weights.reduce((sum, w) => sum + w, 0)
  return weights.map((w) => w / total)
}

/** The n + 1 edges (world units) of `shares` laid over `[start, start + size]`. */
export function tableEdges(start: number, size: number, shares: readonly number[]): number[] {
  const edges = [start]
  let at = 0
  for (const share of shares) {
    at += share
    edges.push(start + at * size)
  }
  edges[edges.length - 1] = start + size
  return edges
}

export const tableColEdges = (table: TableElement) => tableEdges(table.x, table.w, tableShares(table.colWidths, tableSize(table).cols))
export const tableRowEdges = (table: TableElement) => tableEdges(table.y, table.h, tableShares(table.rowHeights, tableSize(table).rows))

/**
 * The merged regions that are drawn: inside the table, at least two cells, not overlapping an
 * earlier region (a later overlapping one is ignored).
 */
export function tableMerges(table: TableElement): Array<{ row: number; col: number; rows: number; cols: number }> {
  const { rows, cols } = tableSize(table)
  const taken = new Set<string>()
  const out: Array<{ row: number; col: number; rows: number; cols: number }> = []
  for (const merge of table.merges ?? []) {
    if (merge.row + merge.rows > rows || merge.col + merge.cols > cols || merge.rows * merge.cols < 2) continue
    const cells: string[] = []
    for (let r = merge.row; r < merge.row + merge.rows; r++) for (let c = merge.col; c < merge.col + merge.cols; c++) cells.push(`${r}:${c}`)
    if (cells.some((cell) => taken.has(cell))) continue
    for (const cell of cells) taken.add(cell)
    out.push({ row: merge.row, col: merge.col, rows: merge.rows, cols: merge.cols })
  }
  return out
}

/** The merged region covering (row, col), or null. */
export function tableMergeAt(table: TableElement, row: number, col: number) {
  return tableMerges(table).find((m) => row >= m.row && row < m.row + m.rows && col >= m.col && col < m.col + m.cols) ?? null
}

/** The box of cell (row, col): its column and row shares, or its whole merged region. */
export function tableCellRect(table: TableElement, row: number, col: number): Rect {
  const xs = tableColEdges(table)
  const ys = tableRowEdges(table)
  const merge = tableMergeAt(table, row, col)
  const [r0, c0, r1, c1] = merge ? [merge.row, merge.col, merge.row + merge.rows, merge.col + merge.cols] : [row, col, row + 1, col + 1]
  const x = xs[Math.min(c0, xs.length - 1)] ?? table.x
  const y = ys[Math.min(r0, ys.length - 1)] ?? table.y
  return { x, y, w: (xs[Math.min(c1, xs.length - 1)] ?? table.x + table.w) - x, h: (ys[Math.min(r1, ys.length - 1)] ?? table.y + table.h) - y }
}

/** The cell under `p` (a merged region's top-left cell), or null outside the table. */
export function tableCellAt(table: TableElement, p: Point): { row: number; col: number } | null {
  if (p.x < table.x || p.y < table.y || p.x > table.x + table.w || p.y > table.y + table.h) return null
  const { rows, cols } = tableSize(table)
  const xs = tableColEdges(table)
  const ys = tableRowEdges(table)
  let col = 0
  while (col < cols - 1 && p.x >= xs[col + 1]!) col++
  let row = 0
  while (row < rows - 1 && p.y >= ys[row + 1]!) row++
  const merge = tableMergeAt(table, row, col)
  return merge ? { row: merge.row, col: merge.col } : { row, col }
}

export function setTableCell(table: TableElement, row: number, col: number, value: string): TableElement {
  if (!table.rows[row] || table.rows[row][col] === undefined || table.rows[row][col] === value) return table
  return { ...table, rows: table.rows.map((cells, r) => (r === row ? cells.map((cell, c) => (c === col ? value : cell)) : cells)) }
}

/** Optional table fields after a row or column moved: weights kept in step, merges shifted (or dropped). */
function withWeights(
  table: TableElement,
  next: TableElement,
  axis: 'row' | 'col',
  change: { insert: number } | { remove: number },
): TableElement {
  const key = axis === 'row' ? 'rowHeights' : 'colWidths'
  const out: TableElement = { ...next }
  const before = table[key]
  const count = axis === 'row' ? table.rows.length : (table.rows[0]?.length ?? 0)
  if (before && before.length === count) {
    const weights = [...before]
    if ('insert' in change) {
      const mean = weights.reduce((a, b) => a + b, 0) / weights.length
      weights.splice(change.insert, 0, Math.round(mean * 1000) / 1000)
    } else weights.splice(change.remove, 1)
    out[key] = weights
  } else delete out[key]
  if (table.merges) {
    const merges = table.merges.flatMap((merge) => {
      const start = axis === 'row' ? merge.row : merge.col
      const span = axis === 'row' ? merge.rows : merge.cols
      let s = start
      let n = span
      if ('insert' in change) {
        if (change.insert <= start) s += 1
        else if (change.insert < start + span) n += 1
      } else {
        if (change.remove < start) s -= 1
        else if (change.remove < start + span) n -= 1
      }
      if (n < 1) return []
      const moved = axis === 'row' ? { ...merge, row: s, rows: n } : { ...merge, col: s, cols: n }
      return moved.rows * moved.cols >= 2 ? [moved] : []
    })
    if (merges.length) out.merges = merges
    else delete out.merges
  }
  return out
}

/** Inserts an empty row before index `at` (the end when `at` is the row count); grows the table. */
export function insertTableRow(table: TableElement, at: number): TableElement {
  const { rows, cols } = tableSize(table)
  if (rows >= MAX_TABLE_ROWS) return table
  const index = Math.max(0, Math.min(rows, at))
  const rowH = table.h / rows
  const next = [...table.rows]
  next.splice(index, 0, Array.from({ length: cols }, () => ''))
  return withWeights(table, { ...table, rows: next, h: Math.round(table.h + rowH) }, 'row', { insert: index })
}

export function insertTableColumn(table: TableElement, at: number): TableElement {
  const { cols } = tableSize(table)
  if (cols >= MAX_TABLE_COLS) return table
  const index = Math.max(0, Math.min(cols, at))
  const colW = table.w / cols
  return withWeights(
    table,
    {
      ...table,
      rows: table.rows.map((cells) => {
        const next = [...cells]
        next.splice(index, 0, '')
        return next
      }),
      w: Math.round(table.w + colW),
    },
    'col',
    { insert: index },
  )
}

/** Removes row `at` (never the last one); shrinks the table by that row's height. */
export function removeTableRow(table: TableElement, at: number): TableElement {
  const { rows } = tableSize(table)
  if (rows <= 1 || at < 0 || at >= rows) return table
  const rowH = table.h * tableShares(table.rowHeights, rows)[at]!
  return withWeights(table, { ...table, rows: table.rows.filter((_, r) => r !== at), h: Math.max(16, Math.round(table.h - rowH)) }, 'row', { remove: at })
}

export function removeTableColumn(table: TableElement, at: number): TableElement {
  const { cols } = tableSize(table)
  if (cols <= 1 || at < 0 || at >= cols) return table
  const colW = table.w * tableShares(table.colWidths, cols)[at]!
  return withWeights(
    table,
    {
      ...table,
      rows: table.rows.map((cells) => cells.filter((_, c) => c !== at)),
      w: Math.max(16, Math.round(table.w - colW)),
    },
    'col',
    { remove: at },
  )
}

/**
 * Moves the border after column (or row) `index` to `edge` (world units), trading space with the
 * next one; each keeps at least `min`. Returns the table with new weights (rounded), or itself.
 */
export function resizeTableTrack(table: TableElement, axis: 'row' | 'col', index: number, edge: number, min = 24): TableElement {
  const count = axis === 'row' ? table.rows.length : (table.rows[0]?.length ?? 0)
  if (index < 0 || index >= count - 1) return table
  const size = axis === 'row' ? table.h : table.w
  const start = axis === 'row' ? table.y : table.x
  const edges = tableEdges(start, size, tableShares(axis === 'row' ? table.rowHeights : table.colWidths, count))
  const lo = edges[index]! + min
  const hi = edges[index + 2]! - min
  if (lo > hi) return table
  const at = Math.max(lo, Math.min(hi, edge))
  const next = [...edges]
  next[index + 1] = at
  const weights = next.slice(1).map((e, i) => Math.max(0.05, Math.round(((e - next[i]!) / size) * 1000) / 10))
  const key = axis === 'row' ? 'rowHeights' : 'colWidths'
  return { ...table, [key]: weights }
}

/** Sets column (or row) `index`'s share to `weight` (a relative weight; others keep theirs). */
export function setTableTrackWeight(table: TableElement, axis: 'row' | 'col', index: number, weight: number): TableElement {
  const count = axis === 'row' ? table.rows.length : (table.rows[0]?.length ?? 0)
  if (index < 0 || index >= count || !(weight > 0)) return table
  const key = axis === 'row' ? 'rowHeights' : 'colWidths'
  const current = table[key]
  const weights = current && current.length === count ? [...current] : Array.from({ length: count }, () => 1)
  weights[index] = Math.max(0.05, Math.min(1000, weight))
  return { ...table, [key]: weights }
}

/**
 * Merges the `rows` x `cols` cells from (row, col) into one, keeping the top-left cell's text
 * (the others' text is joined onto it, so nothing typed is lost). Regions it overlaps are undone
 * first. Returns the table itself when the region is one cell or leaves the table.
 */
export function mergeTableCells(table: TableElement, row: number, col: number, rows: number, cols: number): TableElement {
  const size = tableSize(table)
  if (rows * cols < 2 || row < 0 || col < 0 || row + rows > size.rows || col + cols > size.cols) return table
  const inside = (r: number, c: number) => r >= row && r < row + rows && c >= col && c < col + cols
  const kept = (table.merges ?? []).filter((m) => {
    for (let r = m.row; r < m.row + m.rows; r++) for (let c = m.col; c < m.col + m.cols; c++) if (inside(r, c)) return false
    return true
  })
  if (kept.length >= 60) return table
  const texts: string[] = []
  for (let r = row; r < row + rows; r++) for (let c = col; c < col + cols; c++) if (table.rows[r]![c]) texts.push(table.rows[r]![c]!)
  const joined = texts.join(' ').slice(0, 500)
  const nextRows = table.rows.map((cells, r) => cells.map((cell, c) => (r === row && c === col ? joined : inside(r, c) ? '' : cell)))
  return { ...table, rows: nextRows, merges: [...kept, { row, col, rows, cols }] }
}

/** Splits the merged region covering (row, col) back into cells (its text stays top-left). */
export function unmergeTableCells(table: TableElement, row: number, col: number): TableElement {
  const merge = tableMergeAt(table, row, col)
  if (!merge || !table.merges) return table
  const merges = table.merges.filter((m) => !(m.row === merge.row && m.col === merge.col && m.rows === merge.rows && m.cols === merge.cols))
  const out: TableElement = { ...table }
  if (merges.length) out.merges = merges
  else delete out.merges
  return out
}

/** A new `rows × cols` table with a header row, at `at` (top-left). */
export function newTable(id: string, at: Point, rows = 3, cols = 3): TableElement {
  const r = Math.max(1, Math.min(MAX_TABLE_ROWS, rows))
  const c = Math.max(1, Math.min(MAX_TABLE_COLS, cols))
  return {
    type: 'table',
    id,
    x: Math.round(at.x),
    y: Math.round(at.y),
    w: c * 140,
    h: r * 40,
    rows: Array.from({ length: r }, (_, row) =>
      Array.from({ length: c }, (_, col) => (row === 0 ? `Column ${col + 1}` : '')),
    ),
    header: true,
  }
}

// ---- link cards

/** A pasted or typed link: trimmed, `https://` added to a bare host, null when it is not a web link. */
export function normalizeLinkUrl(input: string): string | null {
  const text = input.trim()
  if (!text || /\s/.test(text) || text.length > 2048) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text) ? `https://${text}` : text
  return isAllowedLinkUrl(candidate) ? new URL(candidate).toString() : null
}

/** The host a card shows under its title (`www.` dropped). */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export const LINK_SIZE = { w: 280, h: 96 } as const

export function newLinkCard(id: string, url: string, at: Point, title?: string): LinkElement {
  return {
    type: 'link',
    id,
    x: Math.round(at.x - LINK_SIZE.w / 2),
    y: Math.round(at.y - LINK_SIZE.h / 2),
    w: LINK_SIZE.w,
    h: LINK_SIZE.h,
    url,
    title: (title ?? '').trim().slice(0, 200) || linkHost(url),
  }
}

// ---- search

/** The element ids whose text contains `query` (case-insensitive), in board order. */
export function searchBoard(board: WhiteboardBoard, query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return board.elements
    .filter((element) => !element.hidden && elementText(element).toLowerCase().includes(needle))
    .map((element) => element.id)
}

/** Every piece of text an element shows, joined. */
export function elementText(element: WhiteboardElement): string {
  switch (element.type) {
    case 'note':
      return plainRichText(element.text)
    case 'text':
      return element.text
    case 'shape':
      return plainRichText(element.text ?? '')
    case 'section':
      return element.title
    case 'arrow':
      return element.label ?? ''
    case 'image':
      return element.alt
    case 'link':
      return `${element.title} ${element.url}`
    case 'table':
      return element.rows.map((row) => row.join(' ')).join(' ')
    default:
      return ''
  }
}


// ---- presenting

export type PresentationFrame = { id: string | null; title: string; rect: Rect }

/**
 * The frames a presentation steps through: every top-level section (one not inside a larger
 * section), in reading order (rows top to bottom, a row being sections whose tops are within 80
 * of each other, then left to right). A board without sections is one frame of everything.
 */
export function presentationFrames(board: WhiteboardBoard, ctx: GeometryContext): PresentationFrame[] {
  const sections = board.elements.filter((element) => element.type === 'section')
  const inside = (a: Rect, b: Rect) =>
    a.x + a.w / 2 >= b.x && a.x + a.w / 2 <= b.x + b.w && a.y + a.h / 2 >= b.y && a.y + a.h / 2 <= b.y + b.h
  const top = sections.filter(
    (section) => !sections.some((other) => other !== section && other.w * other.h > section.w * section.h && inside(section, other)),
  )
  if (top.length === 0) {
    const bounds = contentBounds(board.elements, ctx)
    return bounds ? [{ id: null, title: board.title || 'Board', rect: bounds }] : []
  }
  const sorted = [...top].sort((a, b) => a.y - b.y)
  const rows: (typeof top)[] = []
  for (const section of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(section.y - row[0].y) <= 80) row.push(section)
    else rows.push([section])
  }
  return rows
    .flatMap((row) => row.sort((a, b) => a.x - b.x))
    .map((section) => ({
      id: section.id,
      title: section.type === 'section' ? section.title || 'Untitled section' : '',
      rect: { x: section.x, y: section.y, w: section.w, h: section.h },
    }))
}
