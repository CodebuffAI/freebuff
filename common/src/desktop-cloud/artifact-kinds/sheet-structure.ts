/**
 * Freebuff Sheets — structural edits: insert, delete and move rows or columns,
 * sort a range, hide/unhide, row heights. Pure functions over a workbook.
 *
 * Insert, delete and move are one primitive, an AXIS REMAP (old index → new
 * index, or deleted) applied to everything that names a position: cell keys,
 * formulas in EVERY tab that point at the edited tab, chart anchors and
 * ranges, column settings, row settings, frozen panes, merges, tables, rules,
 * validations and the filter range.
 *
 * Reference rules (as Excel and Google Sheets do them):
 * - A structural edit moves absolute references too ($A$1 is still "that cell").
 * - A reference to a deleted cell becomes #REF!. A range that loses only some
 *   of its rows shrinks; one that loses all of them becomes #REF!.
 * - An insert strictly inside a range grows it; an insert at or before its
 *   first row shifts it whole; one just after its last row leaves it alone.
 * - Only references that point at the edited tab change: unprefixed refs in
 *   that tab's own formulas, and `Tab!` refs naming it from anywhere.
 *
 * Sort is NOT a remap: the sorted cells move like a cut-and-paste of whole rows,
 * their own relative references shifting with them (=B2*C2 moved to row 5 reads
 * =B5*C5), and references from outside the range keep pointing at the same
 * address (they see whatever was sorted into it), as in Google Sheets.
 */

import { colIndex, colName, parseAddress, parseSheetRange, quoteTabName, toAddress, type CellRect } from './sheet-address'
import { compareValues, isError, shiftFormula, tokenize, type CellValue, type SheetEngine, type Token } from './sheet-formula'
import {
  MAX_ROW_HEIGHT,
  MIN_ROW_HEIGHT,
  SHEET_LIMITS,
  tabCols,
  tabRows,
  type SheetCell,
  type SheetTab,
  type Workbook,
} from './sheet'

export type Axis = 'row' | 'col'

/** old index → new index, or `null` when that row/column was deleted. */
export type IndexMap = (index: number) => number | null

/** A remap of one axis of one tab. `range` maps an inclusive span (it may shrink). */
export type AxisRemap = {
  kind: 'insert' | 'delete' | 'move'
  axis: Axis
  map: IndexMap
  range: (a: number, b: number) => [number, number] | null
  /** The axis length after the edit. */
  length: number
}

export function insertRemap(axis: Axis, at: number, count: number, length: number): AxisRemap {
  const map = (i: number) => (i >= at ? i + count : i)
  return { kind: 'insert', axis, map, range: (a, b) => [map(a), map(b)], length: length + count }
}

export function deleteRemap(axis: Axis, at: number, count: number, length: number): AxisRemap {
  const end = at + count // exclusive
  const map = (i: number) => (i < at ? i : i >= end ? i - count : null)
  return {
    kind: 'delete',
    axis,
    map,
    range: (a, b) => {
      // The first and last surviving index of [a, b].
      const first = a >= at && a < end ? end : a
      const last = b >= at && b < end ? at - 1 : b
      if (first > last) return null
      return [map(first)!, map(last)!]
    },
    length: length - count,
  }
}

/** Move the block [from, from + count) so it starts at `to` in the result (0 ≤ to ≤ length − count). */
export function moveRemap(axis: Axis, from: number, count: number, to: number, length: number): AxisRemap {
  const map = (i: number) => {
    if (i >= from && i < from + count) return to + (i - from)
    // Remove the block, then insert it at `to`.
    const rest = i >= from + count ? i - count : i
    return rest >= to ? rest + count : rest
  }
  return {
    kind: 'move',
    axis,
    map,
    range: (a, b) => {
      // A range follows the lines that did not move: span the images of its first and last
      // non-moved index (those keep their order). Moving a row off a range's edge therefore
      // neither shrinks nor stretches it past the rows it kept, and a moved block landing
      // inside it is simply inside. A range made only of moved lines moves with them.
      const end = from + count
      const first = a >= from && a < end ? end : a
      const last = b >= from && b < end ? from - 1 : b
      if (first > last) return [map(a), map(b)]
      return [map(first), map(last)]
    },
    length,
  }
}

// ---- formulas

type RefToken = Extract<Token, { t: 'ref' } | { t: 'colref' }>

function refPart(token: RefToken, col: number, row?: number): string {
  const c = `${token.absCol ? '$' : ''}${colName(col)}`
  if (token.t === 'colref') return c
  return `${c}${token.absRow ? '$' : ''}${(row ?? 0) + 1}${token.spill ? '#' : ''}`
}

/** A ref or a range of the form ref:ref / col:col, with where it sits in the formula body. */
type RefUnit = { start: number; end: number; sheet?: string; prefix: string; a: RefToken; b?: RefToken }

function refUnits(body: string, tokens: Token[]): RefUnit[] {
  const units: RefUnit[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.t !== 'ref' && token.t !== 'colref') continue
    const start = token.sheetSpan ? token.sheetSpan[0] : token.start
    const prefix = token.sheetSpan ? body.slice(token.sheetSpan[0], token.sheetSpan[1]) : ''
    const colon = tokens[i + 1]
    const other = tokens[i + 2]
    if (colon?.t === ':' && other && other.t === token.t) {
      units.push({ start, end: other.end, sheet: token.sheet, prefix, a: token, b: other as RefToken })
      i += 2
      continue
    }
    units.push({ start, end: token.end, sheet: token.sheet, prefix, a: token })
  }
  return units
}

/**
 * Rewrite every reference in `formula` (which lives on tab `ownName`) that points at tab
 * `targetName` through `remap`. Untokenisable formulas come back unchanged.
 */
export function remapFormula(formula: string, ownName: string, targetName: string, remap: AxisRemap): string {
  if (!formula.startsWith('=')) return formula
  const body = formula.slice(1)
  let tokens: Token[]
  try {
    tokens = tokenize(body)
  } catch {
    return formula
  }
  const target = targetName.toLowerCase()
  let out = ''
  let cursor = 0
  let changed = false
  for (const unit of refUnits(body, tokens)) {
    const pointsAt = (unit.sheet ?? ownName).toLowerCase()
    if (pointsAt !== target) continue
    const text = remapUnit(unit, remap)
    if (text === null) continue
    out += body.slice(cursor, unit.start) + text
    cursor = unit.end
    changed = true
  }
  return changed ? `=${out}${body.slice(cursor)}` : formula
}

/** The unit's new text, or `null` when it does not change. */
function remapUnit(unit: RefUnit, remap: AxisRemap): string | null {
  const { a, b } = unit
  const isRow = remap.axis === 'row'
  if (a.t === 'colref') {
    // Whole columns: only a column edit touches them.
    if (isRow) return null
    const left = Math.min(a.col, b?.col ?? a.col)
    const right = Math.max(a.col, b?.col ?? a.col)
    const span = remap.range(left, right)
    if (!span) return '#REF!'
    if (span[0] === left && span[1] === right) return null
    const [first, second] = a.col <= (b?.col ?? a.col) ? [a, b ?? a] : [b ?? a, a]
    return `${unit.prefix}${refPart(first, span[0])}:${refPart(second, span[1])}`
  }
  if (!b) {
    const index = isRow ? a.row : a.col
    const next = remap.map(index)
    if (next === null) return '#REF!'
    if (next === index) return null
    return `${unit.prefix}${isRow ? refPart(a, a.col, next) : refPart(a, next, a.row)}`
  }
  if (b.t !== 'ref') return null
  // A range: map the span on the edited axis; the other axis stays.
  const lo = isRow ? Math.min(a.row, b.row) : Math.min(a.col, b.col)
  const hi = isRow ? Math.max(a.row, b.row) : Math.max(a.col, b.col)
  const span = remap.range(lo, hi)
  if (!span) return '#REF!'
  if (span[0] === lo && span[1] === hi) return null
  // Keep which token held the low end, so `$` markers stay with their corner.
  const aLow = isRow ? a.row <= b.row : a.col <= b.col
  const at = (token: RefToken, low: boolean) => {
    const value = low ? span[0] : span[1]
    return isRow ? refPart(token, token.col, value) : refPart(token, value, token.t === 'ref' ? token.row : 0)
  }
  return `${unit.prefix}${at(a, aLow)}:${at(b, !aLow)}`
}

// ---- rects and ranges

function remapRect(rect: CellRect, remap: AxisRemap): CellRect | null {
  if (remap.axis === 'row') {
    const span = remap.range(rect.top, rect.bottom)
    return span ? { ...rect, top: span[0], bottom: span[1] } : null
  }
  const span = remap.range(rect.left, rect.right)
  return span ? { ...rect, left: span[0], right: span[1] } : null
}

const rectText = (rect: CellRect) =>
  `${toAddress({ row: rect.top, col: rect.left })}:${toAddress({ row: rect.bottom, col: rect.right })}`

/** A tab-local range string (no `!`) through the remap; `null` when all of it was deleted. */
function remapLocalRange(range: string, remap: AxisRemap): string | null {
  const parsed = parseSheetRange(range)
  if (!parsed) return null
  const rect = remapRect(parsed.rect, remap)
  if (!rect) return null
  const single = rect.top === rect.bottom && rect.left === rect.right && !range.includes(':')
  return single ? toAddress({ row: rect.top, col: rect.left }) : rectText(rect)
}

// ---- the whole tab

/** Apply one axis remap of tab `tabId` to the whole workbook. */
export function applyRemap(workbook: Workbook, tabId: string, remap: AxisRemap): Workbook {
  const edited = workbook.tabs.find((tab) => tab.id === tabId)
  if (!edited) return workbook
  const targetName = edited.name
  const isRow = remap.axis === 'row'
  const tabs = workbook.tabs.map((tab) => {
    const own = tab.id === tabId
    // Formulas: every tab may point at the edited one.
    let cells: Record<string, SheetCell> = tab.cells
    if (own) {
      cells = {}
      for (const [address, cell] of Object.entries(tab.cells)) {
        const pos = parseAddress(address)
        if (!pos) continue
        const index = isRow ? pos.row : pos.col
        const next = remap.map(index)
        if (next === null) continue
        const key = toAddress(isRow ? { row: next, col: pos.col } : { row: pos.row, col: next })
        cells[key] = cell.f ? withFormula(cell, remapFormula(cell.f, tab.name, targetName, remap)) : cell
      }
    } else {
      let copy: Record<string, SheetCell> | null = null
      for (const [address, cell] of Object.entries(tab.cells)) {
        if (!cell.f) continue
        const f = remapFormula(cell.f, tab.name, targetName, remap)
        if (f === cell.f) continue
        copy ??= { ...tab.cells }
        copy[address] = withFormula(cell, f)
      }
      if (copy) cells = copy
    }
    let next: SheetTab = cells === tab.cells ? tab : { ...tab, cells }
    // Charts anywhere may draw a range on the edited tab.
    if (tab.charts?.length) {
      const charts = tab.charts.flatMap((chart) => {
        let { anchor } = chart
        if (own) {
          const pos = parseAddress(anchor)
          if (pos) {
            const index = isRow ? pos.row : pos.col
            // A deleted anchor sits at the first surviving row/column after it.
            let mapped = remap.map(index)
            for (let i = index + 1; mapped === null && i < index + 50_000; i += 1) mapped = remap.map(i)
            const value = Math.max(0, Math.min(remap.length - 1, mapped ?? remap.length - 1))
            anchor = toAddress(isRow ? { row: value, col: pos.col } : { row: pos.row, col: value })
          }
        }
        const f = remapFormula(`=${chart.spec.range}`, tab.name, targetName, remap)
        if (f.includes('#REF!')) return []
        const range = f.slice(1)
        if (anchor === chart.anchor && range === chart.spec.range) return [chart]
        return [{ ...chart, anchor, spec: { ...chart.spec, range } }]
      })
      if (charts.length !== tab.charts.length || charts.some((c, i) => c !== tab.charts![i])) {
        const { charts: _old, ...rest } = next
        next = charts.length ? { ...rest, charts } : rest
      }
    }
    return own ? remapTabSettings(next, remap) : next
  })
  const result: Workbook = { ...workbook, tabs }
  // Defined names on the edited tab follow it; a name whose whole range was deleted goes.
  if (workbook.names?.some((def) => def.tab === tabId)) {
    const names = workbook.names.flatMap((def) => {
      if (def.tab !== tabId) return [def]
      const range = remapLocalRange(def.range, remap)
      return range ? [range === def.range ? def : { ...def, range }] : []
    })
    if (names.length) result.names = names
    else delete result.names
  }
  return result
}

function withFormula(cell: SheetCell, f: string): SheetCell {
  return f === cell.f ? cell : { ...cell, f }
}

function remapTabSettings(tab: SheetTab, remap: AxisRemap): SheetTab {
  const next: SheetTab = { ...tab }
  if (remap.axis === 'row') {
    next.rows = remap.length
    if (tab.rowMeta) {
      const rowMeta: NonNullable<SheetTab['rowMeta']> = {}
      for (const [key, meta] of Object.entries(tab.rowMeta)) {
        const mapped = remap.map(Number(key) - 1)
        if (mapped !== null && mapped < remap.length) rowMeta[String(mapped + 1)] = meta
      }
      if (Object.keys(rowMeta).length) next.rowMeta = rowMeta
      else delete next.rowMeta
    }
    if (tab.frozenRows) {
      const frozen = countSurviving(remap, tab.frozenRows)
      if (frozen > 0) next.frozenRows = Math.min(SHEET_LIMITS.frozenRows, frozen)
      else delete next.frozenRows
    }
  } else {
    next.cols = remap.length
    if (tab.columns) {
      const columns: NonNullable<SheetTab['columns']> = []
      const old = tabCols(tab)
      for (let col = 0; col < old; col += 1) {
        const mapped = remap.map(col)
        if (mapped === null || mapped >= remap.length) continue
        columns[mapped] = tab.columns[col] ?? {}
      }
      for (let i = 0; i < columns.length; i += 1) columns[i] ??= {}
      while (columns.length && Object.keys(columns[columns.length - 1]).length === 0) columns.pop()
      if (columns.length) next.columns = columns
      else delete next.columns
    }
    if (tab.frozenCols) {
      const frozen = countSurviving(remap, tab.frozenCols)
      if (frozen > 0) next.frozenCols = Math.min(SHEET_LIMITS.frozenCols, frozen)
      else delete next.frozenCols
    }
  }
  const ranges = <T extends { range: string }>(list: T[] | undefined): T[] | undefined => {
    if (!list) return undefined
    const out = list.flatMap((item) => {
      const range = remapLocalRange(item.range, remap)
      return range ? [range === item.range ? item : { ...item, range }] : []
    })
    return out.length ? out : undefined
  }
  const set = <K extends 'tables' | 'rules' | 'validations' | 'protected'>(key: K) => {
    if (!tab[key]) return
    const value = ranges(tab[key] as Array<{ range: string }>)
    if (value) (next as Record<string, unknown>)[key] = value
    else delete next[key]
  }
  set('tables')
  set('rules')
  set('validations')
  set('protected')
  if (tab.merges) {
    const merges = tab.merges.flatMap((range) => {
      const mapped = remapLocalRange(range, remap)
      const rect = mapped ? parseSheetRange(mapped)?.rect : null
      // A merge shrunk to one cell is no merge.
      return rect && (rect.top !== rect.bottom || rect.left !== rect.right) ? [mapped!] : []
    })
    if (merges.length) next.merges = merges
    else delete next.merges
  }
  if (tab.filter) {
    const range = remapLocalRange(tab.filter.range, remap)
    if (range) next.filter = remapFilter(tab.filter, range, remap)
    else delete next.filter
  }
  // Groups follow their lines like any range; one that loses every line goes, and an overlap a move makes drops the later one.
  const groups = <T extends { from: number; to: number; collapsed?: boolean }>(list: T[] | undefined): T[] | undefined => {
    if (!list) return undefined
    const out: T[] = []
    for (const group of list) {
      const span = remap.range(group.from - 1, group.to - 1)
      if (!span || span[1] >= remap.length) continue
      const moved = { ...group, from: span[0] + 1, to: span[1] + 1 }
      if (out.some((g) => g.from <= moved.to && moved.from <= g.to)) continue
      out.push(moved)
    }
    return out.length ? out : undefined
  }
  if (remap.axis === 'row' && tab.rowGroups) {
    const rowGroups = groups(tab.rowGroups)
    if (rowGroups) next.rowGroups = rowGroups
    else delete next.rowGroups
  }
  if (remap.axis === 'col' && tab.colGroups) {
    const colGroups = groups(tab.colGroups.map((g) => ({ ...g, from: colIndex(g.from) + 1, to: colIndex(g.to) + 1 })))
    if (colGroups) next.colGroups = colGroups.map((g) => ({ ...g, from: colName(g.from - 1), to: colName(g.to - 1) }))
    else delete next.colGroups
  }
  return next
}

/** A filter at its remapped range; on a column edit its saved columns (and sort) follow their letters. */
function remapFilter(filter: NonNullable<SheetTab['filter']>, range: string, remap: AxisRemap): NonNullable<SheetTab['filter']> {
  const next: NonNullable<SheetTab['filter']> = { ...filter, range }
  if (remap.axis !== 'col') return next
  const moved = (letters: string) => {
    const index = remap.map(colIndex(letters))
    return index === null ? null : colName(index)
  }
  if (filter.columns) {
    const columns: NonNullable<typeof filter.columns> = {}
    for (const [letters, column] of Object.entries(filter.columns)) {
      const to = moved(letters)
      if (to) columns[to] = column
    }
    if (Object.keys(columns).length) next.columns = columns
    else delete next.columns
  }
  if (filter.sort) {
    const to = moved(filter.sort.col)
    if (to) next.sort = { ...filter.sort, col: to }
    else delete next.sort
  }
  return next
}

/** How many of the first `n` indices survive and stay in the first block (frozen panes). */
function countSurviving(remap: AxisRemap, n: number): number {
  // Frozen panes grow when something is inserted inside them and shrink on delete; a move keeps them.
  if (remap.kind === 'move') return n
  const last = remap.range(0, n - 1)
  return last ? last[1] + 1 : 0
}

// ---- the commands

const axisLength = (tab: SheetTab, axis: Axis) => (axis === 'row' ? tabRows(tab) : tabCols(tab))
const axisMax = (axis: Axis) => (axis === 'row' ? SHEET_LIMITS.rows : SHEET_LIMITS.cols)

/** Insert `count` blank rows/columns before index `at`. Unchanged past the tab size limit. */
export function insertLines(workbook: Workbook, tabId: string, axis: Axis, at: number, count = 1): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab || count < 1) return workbook
  const length = axisLength(tab, axis)
  if (at < 0 || at > length || length + count > axisMax(axis)) return workbook
  return applyRemap(workbook, tabId, insertRemap(axis, at, count, length))
}

/** Delete `count` rows/columns starting at `at`. A tab keeps at least one of each. */
export function deleteLines(workbook: Workbook, tabId: string, axis: Axis, at: number, count = 1): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab) return workbook
  const length = axisLength(tab, axis)
  const n = Math.min(count, length - at)
  if (at < 0 || n < 1 || length - n < 1) return workbook
  return applyRemap(workbook, tabId, deleteRemap(axis, at, n, length))
}

/** Move the block [from, from + count) so it starts at `to` (an index of the result). */
export function moveLines(workbook: Workbook, tabId: string, axis: Axis, from: number, count: number, to: number): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab) return workbook
  const length = axisLength(tab, axis)
  if (count < 1 || from < 0 || from + count > length) return workbook
  const target = Math.max(0, Math.min(length - count, to))
  if (target === from) return workbook
  return applyRemap(workbook, tabId, moveRemap(axis, from, count, target, length))
}

// ---- hide, heights

function replaceTab(workbook: Workbook, tabId: string, update: (tab: SheetTab) => SheetTab): Workbook {
  let changed = false
  const tabs = workbook.tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    const next = update(tab)
    if (next !== tab) changed = true
    return next
  })
  return changed ? { ...workbook, tabs } : workbook
}

/** Hide or show rows/columns [from, to]. Hiding every one of them is refused. */
export function setLinesHidden(workbook: Workbook, tabId: string, axis: Axis, from: number, to: number, hidden: boolean): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    const length = axisLength(tab, axis)
    const lo = Math.max(0, Math.min(from, to))
    const hi = Math.min(length - 1, Math.max(from, to))
    if (lo > hi) return tab
    if (hidden && lo === 0 && hi === length - 1) return tab
    if (axis === 'col') {
      const columns = [...(tab.columns ?? [])]
      let changed = false
      for (let col = lo; col <= hi; col += 1) {
        const current = columns[col] ?? {}
        if (Boolean(current.hidden) === hidden) continue
        changed = true
        while (columns.length <= col) columns.push({})
        const { hidden: _h, ...rest } = current
        columns[col] = hidden ? { ...rest, hidden: true } : rest
      }
      if (!changed) return tab
      while (columns.length && Object.keys(columns[columns.length - 1]).length === 0) columns.pop()
      const { columns: _c, ...rest } = tab
      return columns.length ? { ...rest, columns } : rest
    }
    const rowMeta = { ...(tab.rowMeta ?? {}) }
    let changed = false
    // Showing rows only walks the rows that have settings.
    const keys = hidden ? range(lo, hi).map((r) => String(r + 1)) : Object.keys(rowMeta).filter((k) => Number(k) - 1 >= lo && Number(k) - 1 <= hi)
    for (const key of keys) {
      const current = rowMeta[key] ?? {}
      if (Boolean(current.hidden) === hidden) continue
      changed = true
      const { hidden: _h, ...rest } = current
      if (hidden) rowMeta[key] = { ...rest, hidden: true }
      else if (Object.keys(rest).length) rowMeta[key] = rest
      else delete rowMeta[key]
    }
    if (!changed) return tab
    const { rowMeta: _m, ...rest } = tab
    return Object.keys(rowMeta).length ? { ...rest, rowMeta } : rest
  })
}

function range(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let i = lo; i <= hi && out.length < SHEET_LIMITS.rows; i += 1) out.push(i)
  return out
}

/** Row heights for rows [from, to]; `null` puts the default back. */
export function setRowHeight(workbook: Workbook, tabId: string, from: number, to: number, height: number | null): Workbook {
  const h = height === null ? null : Math.round(Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, height)))
  return replaceTab(workbook, tabId, (tab) => {
    const rows = tabRows(tab)
    const lo = Math.max(0, Math.min(from, to))
    const hi = Math.min(rows - 1, Math.max(from, to), lo + 5_000)
    const rowMeta = { ...(tab.rowMeta ?? {}) }
    let changed = false
    for (let row = lo; row <= hi; row += 1) {
      const key = String(row + 1)
      const current = rowMeta[key] ?? {}
      if ((current.height ?? null) === h) continue
      changed = true
      const { height: _h, ...rest } = current
      if (h !== null) rowMeta[key] = { ...rest, height: h }
      else if (Object.keys(rest).length) rowMeta[key] = rest
      else delete rowMeta[key]
    }
    if (!changed) return tab
    const { rowMeta: _m, ...rest } = tab
    return Object.keys(rowMeta).length ? { ...rest, rowMeta } : rest
  })
}

// ---- sort

export type SortKey = { col: number; desc?: boolean }

/**
 * Sort the rows of `rect` by one or more columns (absolute column indexes). With `header` the
 * first row stays put. Blanks sort last either way; ties keep their order. Needs the engine
 * because a formula sorts by what it shows.
 */
export function sortRange(
  workbook: Workbook,
  engine: SheetEngine,
  tabId: string,
  rect: CellRect,
  keys: SortKey[],
  options: { header?: boolean } = {},
): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab || keys.length === 0) return workbook
  const top = rect.top + (options.header ? 1 : 0)
  // Rows past the last filled one would only sort blanks to the end, so stop there.
  let bottom = top - 1
  for (const address of Object.keys(tab.cells)) {
    const pos = parseAddress(address)
    if (pos && pos.col >= rect.left && pos.col <= rect.right && pos.row >= top && pos.row <= rect.bottom) {
      bottom = Math.max(bottom, pos.row)
    }
  }
  if (bottom - top < 1) return workbook
  const order: number[] = []
  for (let row = top; row <= bottom; row += 1) order.push(row)
  const valueOf = (row: number, col: number): CellValue => engine.value(tabId, row, col)
  const sorted = [...order].sort((a, b) => {
    for (const key of keys) {
      const x = valueOf(a, key.col)
      const y = valueOf(b, key.col)
      const xBlank = x === null || x === ''
      const yBlank = y === null || y === ''
      if (xBlank || yBlank) {
        if (xBlank && yBlank) continue
        return xBlank ? 1 : -1
      }
      const xs = isError(x) ? null : x
      const ys = isError(y) ? null : y
      if (xs === null || ys === null) {
        if (xs === ys) continue
        return xs === null ? 1 : -1
      }
      const c = compareValues(xs, ys)
      if (c !== 0) return key.desc ? -c : c
    }
    return a - b
  })
  if (sorted.every((row, i) => row === order[i])) return workbook
  const cells = { ...tab.cells }
  // Clear the block, then write each source row into its new place.
  const moved: Array<[string, SheetCell]> = []
  sorted.forEach((source, i) => {
    const target = top + i
    for (let col = rect.left; col <= rect.right; col += 1) {
      const from = toAddress({ row: source, col })
      const cell = tab.cells[from]
      delete cells[from]
      if (!cell) continue
      const dRow = target - source
      moved.push([toAddress({ row: target, col }), cell.f && dRow ? { ...cell, f: shiftFormula(cell.f, dRow, 0) } : cell])
    }
  })
  for (const [address, cell] of moved) cells[address] = cell
  return { ...workbook, tabs: workbook.tabs.map((t) => (t.id === tabId ? { ...t, cells } : t)) }
}

/** `Tab!A1:B2` text for messages and ops. */
export const qualifiedRange = (tab: SheetTab, rect: CellRect) => `${quoteTabName(tab.name)}!${rectText(rect)}`

// ---- fill

/**
 * Fill `target` from `source` (target contains source and extends it in one direction), as the
 * fill handle does. Per line along the fill: two or more numbers (or dates) continue their
 * step; text ending in a number counts on ("Week 1" → "Week 2"); a single date counts days;
 * anything else repeats, formulas shifting their relative references like a paste. With
 * `series: false` (Cmd+D / Cmd+R) everything is copied as is. Formatting comes along.
 */
export function fillRange(
  workbook: Workbook,
  tabId: string,
  source: CellRect,
  target: CellRect,
  options: { series?: boolean } = {},
): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab) return workbook
  const series = options.series ?? true
  const vertical = target.top !== source.top || target.bottom !== source.bottom
  const lines = vertical ? [source.left, source.right] : [source.top, source.bottom]
  const start = vertical ? source.top : source.left
  const n = vertical ? source.bottom - source.top + 1 : source.right - source.left + 1
  const from = vertical ? target.top : target.left
  const to = vertical ? target.bottom : target.right
  if (to - from + 1 > 50_000) return workbook
  const cells = { ...tab.cells }
  let changed = false
  for (let line = lines[0]; line <= lines[1]; line += 1) {
    const at = (i: number) => (vertical ? { row: i, col: line } : { row: line, col: i })
    const sources: Array<SheetCell | undefined> = []
    for (let i = 0; i < n; i += 1) sources.push(tab.cells[toAddress(at(start + i))])
    const step = series ? seriesOf(sources) : null
    for (let p = from; p <= to; p += 1) {
      const k = p - start
      if (k >= 0 && k < n) continue
      const address = toAddress(at(p))
      let next: SheetCell | undefined
      if (step) next = step(k)
      else {
        const index = ((k % n) + n) % n
        const cell = sources[index]
        const offset = k - index
        next = cell?.f && offset ? { ...cell, f: shiftFormula(cell.f, vertical ? offset : 0, vertical ? 0 : offset) } : cell
      }
      if (next) cells[address] = next
      else if (cells[address]) delete cells[address]
      else continue
      changed = true
    }
  }
  return changed ? { ...workbook, tabs: workbook.tabs.map((t) => (t.id === tabId ? { ...t, cells } : t)) } : workbook
}

const TRAILING_NUMBER = /^(.*?)(\d+)$/

/** A function from offset k (0 = the first source cell) to the cell, when the sources form a series. */
function seriesOf(sources: Array<SheetCell | undefined>): ((k: number) => SheetCell) | null {
  if (sources.some((cell) => !cell || cell.f !== undefined || cell.v === undefined)) return null
  const all = sources as SheetCell[]
  const style = (k: number) => {
    const { v: _v, ...rest } = all[((k % all.length) + all.length) % all.length]
    return rest
  }
  const linear = (values: number[]) => {
    const step = values.length === 1 ? 1 : (values[values.length - 1] - values[0]) / (values.length - 1)
    return (k: number) => Number((values[0] + step * k).toPrecision(15))
  }
  if (all.every((cell) => typeof cell.v === 'number')) {
    if (all.length < 2) return null
    const f = linear(all.map((cell) => cell.v as number))
    return (k) => ({ ...style(k), v: f(k) })
  }
  if (all.every((cell) => cell.fmt === 'date' && typeof cell.v === 'string' && isoSerial(cell.v) !== null)) {
    const f = linear(all.map((cell) => isoSerial(cell.v as string)!))
    return (k) => ({ ...style(k), v: serialIso(Math.round(f(k))) })
  }
  if (all.every((cell) => typeof cell.v === 'string' && cell.fmt !== 'date' && TRAILING_NUMBER.test(cell.v))) {
    const parts = all.map((cell) => TRAILING_NUMBER.exec(cell.v as string)!)
    if (parts.some((m) => m[1] !== parts[0][1])) return null
    const width = parts[0][2].length
    const f = linear(parts.map((m) => Number(m[2])))
    return (k) => {
      const value = Math.round(f(k))
      const digits = value < 0 ? String(value) : String(value).padStart(parts[0][2].startsWith('0') ? width : 1, '0')
      return { ...style(k), v: `${parts[0][1]}${digits}` }
    }
  }
  return null
}

const DAY = 86_400_000
const EPOCH_MS = Date.UTC(1899, 11, 30)
function isoSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const date = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.round((date - EPOCH_MS) / DAY)
}
function serialIso(serial: number): string {
  return new Date(EPOCH_MS + serial * DAY).toISOString().slice(0, 10)
}
