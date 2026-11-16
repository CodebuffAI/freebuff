/**
 * Freebuff Sheets — edits to a workbook, as pure functions that return a new
 * workbook (untouched tabs and cells keep their identity, which is what lets
 * `SheetEngine.update` recompute only what changed). Plus undo history, the
 * clipboard payload, CSV in and out, and the range → chart adapter.
 */

import { formulaSafeCell } from './export-safe'
import { parseSheetRange, rectSize, toAddress, type CellPos, type CellRect } from './sheet-address'
import { parseCsv, parseTsv, toCsv, toTsv } from './sheet-delimited'
import { applyInput, formatValue, pruneCell } from './sheet-format'
import { isError, renameTabInFormula, shiftFormula, type SheetEngine } from './sheet-formula'
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  SHEET_LIMITS,
  tabCols,
  tabRows,
  type CellAlign,
  type CellFill,
  type BorderStyle,
  type CellFormat,
  type CellValign,
  type DateStyle,
  type FontSize,
  type FontFamily,
  type CellList,
  type SheetCell,
  type SheetChart,
  type SheetTab,
  type Workbook,
} from './sheet'
import type { ChartSpec } from './chart'
import type { SheetChartType } from './sheet'

/**
 * What a sheet chart draws: the shared chart spec's shape with the sheet's own types, the stack
 * flag, and the x values as numbers (a scatter's x axis; null where not a number).
 */
export type SheetChartData = Omit<ChartSpec, 'type'> & { type: SheetChartType; stacked?: boolean; xNumbers: Array<number | null> }
type DocChartSpec = SheetChartData

// ---- cells

export function tabById(workbook: Workbook, tabId: string): SheetTab | undefined {
  return workbook.tabs.find((tab) => tab.id === tabId)
}

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

/** Write several cells at once (`undefined` deletes). Unchanged when nothing differs. */
export function setCells(workbook: Workbook, tabId: string, updates: Map<string, SheetCell | undefined>): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    let cells: Record<string, SheetCell> | null = null
    for (const [address, value] of updates) {
      const old = tab.cells[address]
      const next = value ? pruneCell(value) : undefined
      if (sameCell(old, next)) continue
      cells ??= { ...tab.cells }
      if (next) cells[address] = next
      else delete cells[address]
    }
    return cells ? { ...tab, cells } : tab
  })
}

export function sameCell(a: SheetCell | undefined, b: SheetCell | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SheetCell>
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (x === y) continue
    if (typeof x === 'object' && typeof y === 'object' && x && y && JSON.stringify(x) === JSON.stringify(y)) continue
    return false
  }
  return true
}

/** Commit what someone typed into one cell. */
export function setCellInput(workbook: Workbook, tabId: string, pos: CellPos, raw: string): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab) return workbook
  const address = toAddress(pos)
  return setCells(workbook, tabId, new Map([[address, applyInput(tab.cells[address], raw, { locale: workbook.locale })]]))
}

function forEachCell(rect: CellRect, fn: (address: string, pos: CellPos) => void) {
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    for (let col = rect.left; col <= rect.right; col += 1) fn(toAddress({ row, col }), { row, col })
  }
}

/** Only the filled cells of a rect, without walking every empty one of a whole column. */
function filledIn(tab: SheetTab, rect: CellRect): string[] {
  const size = rectSize(rect)
  const out: string[] = []
  if (size.rows * size.cols <= Object.keys(tab.cells).length) {
    forEachCell(rect, (address) => {
      if (tab.cells[address]) out.push(address)
    })
    return out
  }
  for (const address of Object.keys(tab.cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(address)
    if (!match) continue
    let col = 0
    for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
    col -= 1
    const row = Number(match[2]) - 1
    if (row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right) out.push(address)
  }
  return out
}

/** Delete / Backspace: clear values and formulas in a rect, keeping the formatting. */
export function clearRange(workbook: Workbook, tabId: string, rect: CellRect): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab) return workbook
  const updates = new Map<string, SheetCell | undefined>()
  for (const address of filledIn(tab, rect)) {
    const { v: _v, f: _f, ...style } = tab.cells[address]
    updates.set(address, style)
  }
  return setCells(workbook, tabId, updates)
}

export type FormatPatch = {
  fmt?: CellFormat | null
  bold?: boolean
  align?: CellAlign | null
  bg?: CellFill | null
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: CellFill | null
  size?: FontSize | null
  wrap?: boolean
  valign?: CellValign | null
  decimals?: number | null
  dateStyle?: DateStyle | null
  note?: string | null
  // Round 5.
  font?: FontFamily | null
  indent?: number | null
  rotate?: number | null
  list?: CellList | null
  pattern?: string | null
  /** Borders: `outer` draws the rect's outline, `all` every cell edge, `none` clears them. */
  border?: { preset: 'all' | 'outer' | 'none' | 'top' | 'bottom' | 'left' | 'right'; style?: BorderStyle }
  /** Clear every style (keeps values and formulas). */
  clear?: boolean
}

const BOOLEAN_STYLES = ['bold', 'italic', 'underline', 'strike', 'wrap'] as const
const VALUE_STYLES = ['fmt', 'align', 'bg', 'color', 'size', 'valign', 'decimals', 'dateStyle', 'note', 'font', 'indent', 'rotate', 'list', 'pattern'] as const

/** Formatting over a rect. `null` removes that property. Capped so a whole-sheet select cannot explode. */
export function formatRange(workbook: Workbook, tabId: string, rect: CellRect, patch: FormatPatch): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab) return workbook
  const size = rectSize(rect)
  const updates = new Map<string, SheetCell | undefined>()
  const apply = (address: string, pos: CellPos) => {
    const old = tab.cells[address]
    let cell: SheetCell = { ...(old ?? {}) }
    if (patch.clear)
      cell = {
        ...(old?.v !== undefined ? { v: old.v } : {}),
        ...(old?.f !== undefined ? { f: old.f } : {}),
        // A person cell's people and a list's items are content, not formatting.
        ...(old?.people ? { people: old.people } : {}),
        ...(old?.list ? { list: old.list } : {}),
      }
    const record = cell as Record<string, unknown>
    for (const key of BOOLEAN_STYLES) {
      if (patch[key] === undefined) continue
      if (patch[key]) record[key] = true
      else delete record[key]
    }
    for (const key of VALUE_STYLES) {
      const value = patch[key]
      if (value === undefined) continue
      if (value === null || value === '') delete record[key]
      else record[key] = value
    }
    if (patch.border) {
      const style = patch.border.style ?? 'thin'
      const border: NonNullable<SheetCell['border']> = { ...(cell.border ?? {}) }
      const preset = patch.border.preset
      if (preset === 'none') {
        delete cell.border
      } else {
        const edge = {
          top: pos.row === rect.top,
          bottom: pos.row === rect.bottom,
          left: pos.col === rect.left,
          right: pos.col === rect.right,
        }
        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          if (preset === 'all' || (preset === 'outer' && edge[side]) || (preset === side && edge[side])) border[side] = style
        }
        cell.border = border
      }
    }
    updates.set(address, cell)
  }
  // Removing formatting only touches filled cells; adding it to a huge rect stops at the cell cap.
  const removing =
    Boolean(patch.clear) ||
    patch.border?.preset === 'none' ||
    BOOLEAN_STYLES.some((key) => patch[key] === false) ||
    VALUE_STYLES.some((key) => patch[key] === null)
  if (removing || size.rows * size.cols > 20_000) {
    if (!removing) {
      // Format the filled cells plus the first screenful, so a whole-column select still shows it.
      forEachCell({ ...rect, bottom: Math.min(rect.bottom, rect.top + Math.floor(20_000 / size.cols) - 1) }, apply)
    }
    for (const address of filledIn(tab, rect)) apply(address, parseAddressFast(address))
  } else forEachCell(rect, apply)
  return setCells(workbook, tabId, updates)
}

function parseAddressFast(address: string): CellPos {
  const match = /^([A-Z]+)(\d+)$/.exec(address)!
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]) - 1, col: col - 1 }
}

export function allBold(tab: SheetTab, rect: CellRect): boolean {
  const addresses = filledIn(tab, rect)
  return addresses.length > 0 && addresses.every((address) => tab.cells[address]?.bold)
}

// ---- clipboard

/** What a copy carries: TSV for other apps, the cells themselves for a paste back into a sheet. */
export type ClipboardPayload = {
  tsv: string
  origin: CellPos
  cells: Array<Array<SheetCell | undefined>>
  /** A cut pastes its formulas unshifted (they move with the cells), and only once. */
  cut?: boolean
}

/** What a copy or export shows beside `fmt`: the cell's currency and the workbook's locale (nothing more, as before). */
function displayOf(workbook: Workbook, cell: SheetCell | undefined): { currency?: SheetCell['currency']; locale?: string } {
  return { ...(cell?.currency ? { currency: cell.currency } : {}), ...(workbook.locale ? { locale: workbook.locale } : {}) }
}

/** Displayed values (so a paste into Excel or Google Sheets reads them as typed). */
export function rangeToTsv(workbook: Workbook, engine: SheetEngine, tabId: string, rect: CellRect): string {
  return toTsv(displayRows(workbook, engine, tabId, rect))
}

export function displayRows(workbook: Workbook, engine: SheetEngine, tabId: string, rect: CellRect): string[][] {
  const tab = tabById(workbook, tabId)
  if (!tab) return []
  const rows: string[][] = []
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const line: string[] = []
    for (let col = rect.left; col <= rect.right; col += 1) {
      const cell = tab.cells[toAddress({ row, col })]
      line.push(formatValue(engine.value(tabId, row, col), cell?.fmt, displayOf(workbook, cell)))
    }
    rows.push(line)
  }
  return rows
}

export function copyRange(workbook: Workbook, engine: SheetEngine, tabId: string, rect: CellRect): ClipboardPayload {
  const tab = tabById(workbook, tabId)
  const cells: ClipboardPayload['cells'] = []
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const line: Array<SheetCell | undefined> = []
    for (let col = rect.left; col <= rect.right; col += 1) line.push(tab?.cells[toAddress({ row, col })])
    cells.push(line)
  }
  return { tsv: rangeToTsv(workbook, engine, tabId, rect), origin: { row: rect.top, col: rect.left }, cells }
}

/**
 * Paste at the selection. When `internal` is the payload this page copied (its TSV
 * matches the text), cells come over whole, with relative references shifted; otherwise
 * each TSV field is read as typed input. A single value fills a multi-cell selection.
 * Returns the workbook and the rect that was written.
 */
export function pasteText(
  workbook: Workbook,
  tabId: string,
  target: CellRect,
  text: string,
  internal: ClipboardPayload | null,
): { workbook: Workbook; rect: CellRect } {
  const tab = tabById(workbook, tabId)
  if (!tab) return { workbook, rect: target }
  const rows = tabRows(tab)
  const cols = tabCols(tab)
  const useInternal = internal !== null && normaliseNewlines(internal.tsv) === normaliseNewlines(text).replace(/\n$/, '')
  const grid: Array<Array<{ raw?: string; cell?: SheetCell; from?: CellPos }>> = useInternal
    ? internal.cells.map((line, r) =>
        line.map((cell, c) => ({ cell, from: { row: internal.origin.row + r, col: internal.origin.col + c } })),
      )
    : parseTsv(text).map((line) => line.map((raw) => ({ raw })))
  if (grid.length === 0) return { workbook, rect: target }
  const height = grid.length
  const width = Math.max(...grid.map((line) => line.length))
  const single = height === 1 && width === 1
  const fill = single ? target : { top: target.top, left: target.left, bottom: target.top + height - 1, right: target.left + width - 1 }
  const rect = { ...fill, bottom: Math.min(fill.bottom, rows - 1), right: Math.min(fill.right, cols - 1) }
  const updates = new Map<string, SheetCell | undefined>()
  forEachCell(rect, (address, pos) => {
    if (updates.size >= SHEET_LIMITS.cells) return
    const source = single ? grid[0][0] : grid[pos.row - rect.top]?.[pos.col - rect.left]
    if (!source) return
    if (source.raw !== undefined) {
      const existing = tab.cells[address]
      updates.set(address, applyInput(existing, source.raw, { locale: workbook.locale, rich: false }))
      return
    }
    const cell = source.cell
    if (!cell) {
      updates.set(address, undefined)
      return
    }
    const from = source.from!
    const shift = internal?.cut ? { dRow: 0, dCol: 0 } : { dRow: pos.row - from.row, dCol: pos.col - from.col }
    updates.set(address, cell.f ? { ...cell, f: shiftFormula(cell.f, shift.dRow, shift.dCol) } : cell)
  })
  return { workbook: setCells(workbook, tabId, updates), rect }
}

const normaliseNewlines = (text: string) => text.replace(/\r\n?/g, '\n')

// ---- tabs

const TAB_NAME_FORBIDDEN = /[\\/?*[\]:]/

/** Why `name` cannot name a tab, or `null` when it can. */
export function tabNameProblem(workbook: Workbook, name: string, exceptId?: string): string | null {
  if (name.length === 0) return 'A tab needs a name.'
  if (name.length > 31) return 'Tab names are at most 31 characters.'
  if (name.trim() !== name) return 'Tab names cannot start or end with a space.'
  if (TAB_NAME_FORBIDDEN.test(name)) return 'Tab names cannot use \\ / ? * [ ] :'
  if (name.startsWith("'") || name.endsWith("'")) return "Tab names cannot start or end with '."
  const lower = name.toLowerCase()
  if (workbook.tabs.some((tab) => tab.id !== exceptId && tab.name.toLowerCase() === lower)) {
    return 'Another tab has that name.'
  }
  return null
}

function freshId(workbook: Workbook, base: string): string {
  // Not a trashed tab's id either: a live tab sharing it would shadow it when it is restored.
  const ids = new Set([...workbook.tabs, ...(workbook.deletedTabs ?? []).map((entry) => entry.tab)].map((tab) => tab.id))
  for (let n = workbook.tabs.length + 1; ; n += 1) {
    const id = `${base}-${n}`
    if (!ids.has(id)) return id
  }
}

function freshName(workbook: Workbook, base: string): string {
  for (let n = 1; ; n += 1) {
    const name = n === 1 && base !== 'Sheet' ? base : `${base} ${n === 1 ? workbook.tabs.length + 1 : n}`
    if (tabNameProblem(workbook, name) === null) return name
  }
}

export function addTab(workbook: Workbook, init: Partial<SheetTab> = {}): { workbook: Workbook; tabId: string } {
  if (workbook.tabs.length >= SHEET_LIMITS.tabs) return { workbook, tabId: workbook.tabs[0].id }
  const tabId = freshId(workbook, 'sheet')
  const tab: SheetTab = { name: init.name ?? freshName(workbook, 'Sheet'), cells: {}, ...init, id: tabId }
  if (tabNameProblem(workbook, tab.name) !== null) tab.name = freshName(workbook, 'Sheet')
  return { workbook: { ...workbook, tabs: [...workbook.tabs, tab] }, tabId }
}

/** Rename a tab and every formula that points at it. */
export function renameTab(workbook: Workbook, tabId: string, name: string): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab || tab.name === name || tabNameProblem(workbook, name, tabId) !== null) return workbook
  const from = tab.name
  return {
    ...workbook,
    tabs: workbook.tabs.map((t) => {
      let cells: Record<string, SheetCell> | null = null
      for (const [address, cell] of Object.entries(t.cells)) {
        if (!cell.f) continue
        const f = renameTabInFormula(cell.f, from, name)
        if (f === cell.f) continue
        cells ??= { ...t.cells }
        cells[address] = { ...cell, f }
      }
      let charts = t.charts
      if (charts?.some((chart) => parseSheetRange(chart.spec.range)?.tab?.toLowerCase() === from.toLowerCase())) {
        charts = charts.map((chart) => {
          const f = renameTabInFormula(`=${chart.spec.range}`, from, name)
          return { ...chart, spec: { ...chart.spec, range: f.slice(1) } }
        })
      }
      const next = cells || charts !== t.charts ? { ...t, ...(cells ? { cells } : {}), ...(charts ? { charts } : {}) } : t
      return t.id === tabId ? { ...next, name } : next
    }),
  }
}

/**
 * Delete a tab (never the last). References to it read `#REF!` until a tab of that name exists
 * again. The tab goes to `deletedTabs` (the last five), so `restoreTab` can bring it back.
 */
export function deleteTab(workbook: Workbook, tabId: string): Workbook {
  const index = workbook.tabs.findIndex((tab) => tab.id === tabId)
  if (workbook.tabs.length <= 1 || index === -1) return workbook
  const names = workbook.names?.filter((def) => def.tab === tabId) ?? []
  const entry = { tab: workbook.tabs[index], index, ...(names.length ? { names } : {}) }
  // The trash keeps the newest few within its own cell budget; a tab too big for it is not kept.
  const size = (e: { tab: SheetTab }) => Object.keys(e.tab.cells).length
  const trash = size(entry) > SHEET_LIMITS.deletedCells ? [...(workbook.deletedTabs ?? [])] : [...(workbook.deletedTabs ?? []), entry]
  while (trash.length > SHEET_LIMITS.deletedTabs || trash.reduce((n, e) => n + size(e), 0) > SHEET_LIMITS.deletedCells) trash.shift()
  const { deletedTabs: _old, ...rest } = workbook
  const next: Workbook = { ...rest, tabs: workbook.tabs.filter((tab) => tab.id !== tabId), ...(trash.length ? { deletedTabs: trash } : {}) }
  // A name on the deleted tab goes with it (its formulas then show #NAME?).
  if (workbook.names?.some((def) => def.tab === tabId)) {
    const names = workbook.names.filter((def) => def.tab !== tabId)
    if (names.length) next.names = names
    else delete next.names
  }
  return next
}

/**
 * Bring back a deleted tab (`at` indexes `deletedTabs`; default the newest) where it was. Its
 * name gets a number when another tab took it meanwhile, its id when that is taken.
 */
export function restoreTab(workbook: Workbook, at?: number): { workbook: Workbook; tabId: string } | { error: string } {
  const trash = workbook.deletedTabs ?? []
  if (!trash.length) return { error: 'No deleted tab to restore.' }
  const i = at ?? trash.length - 1
  const entry = trash[i]
  if (!entry) return { error: `There are ${trash.length} deleted tabs; restore one of 0-${trash.length - 1}.` }
  if (workbook.tabs.length >= SHEET_LIMITS.tabs) return { error: tabLimitMessage }
  const ids = new Set(workbook.tabs.map((tab) => tab.id))
  const id = ids.has(entry.tab.id) ? freshId(workbook, entry.tab.id) : entry.tab.id
  let name = entry.tab.name
  for (let n = 2; tabNameProblem(workbook, name) !== null; n += 1) name = `${entry.tab.name.slice(0, 26)} (${n})`
  const tabs = [...workbook.tabs]
  tabs.splice(Math.min(entry.index, tabs.length), 0, { ...entry.tab, id, name })
  const rest = trash.filter((_, j) => j !== i)
  const { deletedTabs: _trash, ...base } = workbook
  // Its names come back unless another name took them meanwhile.
  const taken = new Set((workbook.names ?? []).map((def) => def.name.toLowerCase()))
  const back = (entry.names ?? []).filter((def) => !taken.has(def.name.toLowerCase())).map((def) => ({ ...def, tab: id }))
  const names = [...(workbook.names ?? []), ...back]
  const next: Workbook = { ...base, tabs, ...(names.length ? { names } : {}) }
  return { workbook: rest.length ? { ...next, deletedTabs: rest } : next, tabId: id }
}

/** Why no tab can be added. */
export const tabLimitMessage = `A workbook holds at most ${SHEET_LIMITS.tabs} tabs; delete one first.`

export function duplicateTab(workbook: Workbook, tabId: string): { workbook: Workbook; tabId: string } {
  const tab = tabById(workbook, tabId)
  if (!tab || workbook.tabs.length >= SHEET_LIMITS.tabs) return { workbook, tabId }
  const id = freshId(workbook, tab.id)
  let name = `${tab.name} copy`.slice(0, 31)
  for (let n = 2; tabNameProblem(workbook, name) !== null; n += 1) name = `${tab.name.slice(0, 24)} copy ${n}`
  const copy: SheetTab = { ...tab, id, name }
  const index = workbook.tabs.indexOf(tab)
  const tabs = [...workbook.tabs]
  tabs.splice(index + 1, 0, copy)
  return { workbook: { ...workbook, tabs }, tabId: id }
}

export function moveTab(workbook: Workbook, tabId: string, toIndex: number): Workbook {
  const from = workbook.tabs.findIndex((tab) => tab.id === tabId)
  if (from === -1) return workbook
  const to = Math.max(0, Math.min(workbook.tabs.length - 1, toIndex))
  if (from === to) return workbook
  const tabs = [...workbook.tabs]
  const [tab] = tabs.splice(from, 1)
  tabs.splice(to, 0, tab)
  return { ...workbook, tabs }
}

export function setColumnWidth(workbook: Workbook, tabId: string, col: number, width: number): Workbook {
  const w = Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, width)))
  return replaceTab(workbook, tabId, (tab) => {
    if (col >= tabCols(tab) || (tab.columns?.[col]?.width ?? null) === w) return tab
    const columns = [...(tab.columns ?? [])]
    while (columns.length <= col) columns.push({})
    columns[col] = { ...columns[col], width: w }
    return { ...tab, columns }
  })
}

export function setFrozen(workbook: Workbook, tabId: string, frozen: { rows?: number; cols?: number }): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    const next = { ...tab }
    if (frozen.rows !== undefined) {
      const rows = Math.max(0, Math.min(SHEET_LIMITS.frozenRows, frozen.rows))
      if (rows === 0) delete next.frozenRows
      else next.frozenRows = rows
    }
    if (frozen.cols !== undefined) {
      const cols = Math.max(0, Math.min(SHEET_LIMITS.frozenCols, frozen.cols))
      if (cols === 0) delete next.frozenCols
      else next.frozenCols = cols
    }
    return next.frozenRows === tab.frozenRows && next.frozenCols === tab.frozenCols ? tab : next
  })
}

export function setTitle(workbook: Workbook, title: string): Workbook {
  const t = title.trim().slice(0, 200)
  return t && t !== workbook.title ? { ...workbook, title: t } : workbook
}

// ---- extent, CSV

/** The smallest block from A1 holding every filled cell (at least 1×1). */
/** The block from A1 that holds content; with an engine, spilled values count too. */
export function usedExtent(tab: SheetTab, engine?: SheetEngine): { rows: number; cols: number } {
  const spilled = engine?.spillExtent(tab.id)
  let rows = spilled?.rows ?? 0
  let cols = spilled?.cols ?? 0
  for (const address of Object.keys(tab.cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(address)
    if (!match) continue
    let col = 0
    for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
    rows = Math.max(rows, Number(match[2]))
    cols = Math.max(cols, col)
  }
  return { rows: Math.max(rows, 1), cols: Math.max(cols, 1) }
}

/**
 * One tab as CSV of what each cell shows (as Google Sheets exports). A TEXT cell a spreadsheet
 * would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a CR: CSV/DDE injection)
 * gets a leading `'`, as the data kind's CSV does. Only in this exported file: the clipboard's
 * TSV (`rangeToTsv`) carries what the cell shows, unchanged, so a copy pasted back into a grid
 * round-trips losslessly. Numbers (`-5`) are never prefixed.
 */
export function tabToCsv(workbook: Workbook, engine: SheetEngine, tabId: string): string {
  const tab = tabById(workbook, tabId)
  if (!tab) return ''
  const { rows, cols } = usedExtent(tab, engine)
  const shown = displayRows(workbook, engine, tabId, { top: 0, left: 0, bottom: rows - 1, right: cols - 1 })
  shown.forEach((line, row) =>
    line.forEach((text, col) => {
      if (typeof engine.value(tabId, row, col) === 'string') line[col] = formulaSafeCell(text)
    }),
  )
  return toCsv(shown)
}

/** A CSV file as a new tab, each field read as typed input. */
export function importCsv(workbook: Workbook, text: string, name: string): { workbook: Workbook; tabId: string } {
  const lines = parseCsv(text)
  const height = Math.min(lines.length, SHEET_LIMITS.rows)
  const width = Math.min(Math.max(1, ...lines.map((line) => line.length)), SHEET_LIMITS.cols)
  const cells: Record<string, SheetCell> = {}
  let count = 0
  for (let row = 0; row < height && count < SHEET_LIMITS.cells; row += 1) {
    for (let col = 0; col < width && col < lines[row].length; col += 1) {
      const cell = applyInput(undefined, lines[row][col], { locale: workbook.locale, rich: false })
      if (!cell) continue
      // An imported "=…" field is text, not a formula someone meant to run.
      cells[toAddress({ row, col })] = cell.f ? { v: cell.f, fmt: 'text' } : cell
      count += 1
    }
  }
  const base = name.replace(/\.[^.]+$/, '').replace(/[\\/?*[\]:']/g, ' ').trim().slice(0, 31) || 'Imported'
  let tabName = base
  for (let n = 2; tabNameProblem(workbook, tabName) !== null; n += 1) tabName = `${base.slice(0, 27)} ${n}`
  return addTab(workbook, {
    name: tabName,
    rows: Math.max(DEFAULT_ROWS, height + 100) > SHEET_LIMITS.rows ? SHEET_LIMITS.rows : Math.max(DEFAULT_ROWS, height + 100),
    cols: Math.max(DEFAULT_COLS, width),
    frozenRows: 1,
    cells,
  })
}

// ---- charts

const MAX_CHART_SERIES = 8
const MAX_CHART_ROWS = 500

/**
 * A chart's range as the spec DocChart draws: the first row names the series, the
 * first column labels the x axis, the other columns are numbers. `null` when the
 * range is missing, off-sheet, or too small to draw.
 */
export function chartSpecFor(
  workbook: Workbook,
  engine: SheetEngine,
  tabId: string,
  chart: SheetChart,
): DocChartSpec | null {
  const parsed = parseSheetRange(chart.spec.range)
  if (!parsed) return null
  const tab = parsed.tab
    ? workbook.tabs.find((t) => t.name.toLowerCase() === parsed.tab!.toLowerCase())
    : tabById(workbook, tabId)
  if (!tab) return null
  const rect = {
    ...parsed.rect,
    bottom: Math.min(parsed.rect.bottom, tabRows(tab) - 1, parsed.rect.top + MAX_CHART_ROWS),
    // Either axis may hold the series (seriesIn), so clip both to the row cap; the loops cap series.
    right: Math.min(parsed.rect.right, tabCols(tab) - 1, parsed.rect.left + MAX_CHART_ROWS),
  }
  if (rect.bottom <= rect.top && rect.right <= rect.left) return null
  // Read the block as a grid, turned so that each series is a column of it.
  const byRows = chart.spec.seriesIn === 'rows'
  const hasHeader = chart.spec.header !== false
  const height = byRows ? rect.right - rect.left + 1 : rect.bottom - rect.top + 1
  const width = byRows ? rect.bottom - rect.top + 1 : rect.right - rect.left + 1
  const at = (r: number, c: number) => (byRows ? { row: rect.top + c, col: rect.left + r } : { row: rect.top + r, col: rect.left + c })
  const value = (r: number, c: number) => {
    const p = at(r, c)
    return engine.value(tab.id, p.row, p.col)
  }
  if (width < 2 || height < (hasHeader ? 2 : 1)) return null
  const header = (c: number) => {
    const v = hasHeader ? value(0, c) : null
    return v === null || isError(v) ? `Series ${c}` : String(v)
  }
  const series = []
  for (let c = 1; c < Math.min(width, MAX_CHART_SERIES + 1); c += 1) series.push({ key: `s${c}`, label: header(c) })
  const data: DocChartSpec['data'] = []
  const xNumbers: Array<number | null> = []
  for (let r = hasHeader ? 1 : 0; r < Math.min(height, MAX_CHART_ROWS + 1); r += 1) {
    const xValue = value(r, 0)
    if (xValue === null) continue
    const p = at(r, 0)
    const xCell = tab.cells[toAddress(p)]
    const entry: Record<string, string | number> = { x: formatValue(xValue, xCell?.fmt, displayOf(workbook, xCell)) }
    xNumbers.push(typeof xValue === 'number' && Number.isFinite(xValue) ? xValue : null)
    for (let c = 1; c < Math.min(width, MAX_CHART_SERIES + 1); c += 1) {
      const v = value(r, c)
      if (typeof v === 'number' && Number.isFinite(v)) entry[`s${c}`] = v
    }
    data.push(entry)
  }
  if (data.length === 0) return null
  return {
    type: chart.spec.type,
    ...(chart.spec.title ? { title: chart.spec.title } : {}),
    ...(chart.spec.stacked ? { stacked: true } : {}),
    x: 'x',
    series,
    data,
    xNumbers,
  }
}

export function addChart(workbook: Workbook, tabId: string, chart: Omit<SheetChart, 'id'>): { workbook: Workbook; chartId: string } {
  let chartId = ''
  const next = replaceTab(workbook, tabId, (tab) => {
    const charts = tab.charts ?? []
    if (charts.length >= SHEET_LIMITS.chartsPerTab) return tab
    const ids = new Set(charts.map((c) => c.id))
    let n = charts.length + 1
    while (ids.has(`chart-${n}`)) n += 1
    chartId = `chart-${n}`
    return { ...tab, charts: [...charts, { ...chart, id: chartId }] }
  })
  return { workbook: next, chartId }
}

export function updateChart(
  workbook: Workbook,
  tabId: string,
  chartId: string,
  update: (chart: SheetChart) => SheetChart | null,
): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    if (!tab.charts?.some((c) => c.id === chartId)) return tab
    const charts = tab.charts.flatMap((c) => {
      if (c.id !== chartId) return [c]
      const next = update(c)
      return next ? [next] : []
    })
    const { charts: _old, ...rest } = tab
    return charts.length ? { ...rest, charts } : rest
  })
}

/** The rect clipped to the block that holds data, so a whole-column select stays cheap. */
export function clipToUsed(tab: SheetTab, rect: CellRect, engine?: SheetEngine): CellRect {
  const used = usedExtent(tab, engine)
  return {
    top: rect.top,
    left: rect.left,
    bottom: Math.max(rect.top, Math.min(rect.bottom, used.rows - 1)),
    right: Math.max(rect.left, Math.min(rect.right, used.cols - 1)),
  }
}

// ---- history

export type History = { past: Workbook[]; present: Workbook; future: Workbook[] }

const HISTORY_LIMIT = 100

export const historyOf = (present: Workbook): History => ({ past: [], present, future: [] })

export function commit(history: History, next: Workbook): History {
  if (next === history.present) return history
  const past = [...history.past, history.present]
  if (past.length > HISTORY_LIMIT) past.shift()
  return { past, present: next, future: [] }
}

export function undo(history: History): History {
  if (history.past.length === 0) return history
  const past = history.past.slice(0, -1)
  return { past, present: history.past[history.past.length - 1], future: [history.present, ...history.future] }
}

export function redo(history: History): History {
  if (history.future.length === 0) return history
  const [present, ...future] = history.future
  return { past: [...history.past, history.present], present, future }
}

// ---- the tab trash outside the editor

/**
 * A sheet body without its tab trash (`deletedTabs`), for readers who cannot restore a tab: link
 * viewers and commenters, and the agent's `read_artifact` unless it asks. Deleted tabs are not
 * part of the sheet anyone sees. A body that is not a JSON object is returned as it is.
 */
export function withoutDeletedTabs(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('deletedTabs' in parsed)) return body
    const { deletedTabs: _trash, ...rest } = parsed as Record<string, unknown>
    return JSON.stringify(rest)
  } catch {
    return body
  }
}

/**
 * `next` with the stored trash carried over when `next` has no `deletedTabs` key at all: a writer
 * that read the sheet without its trash (`withoutDeletedTabs`) and wrote the whole body back must
 * not empty it. A trashed tab that is live in `next` (restored) is not carried. Bodies that are
 * not JSON objects, or that name `deletedTabs` themselves, are returned as they are.
 */
export function carryDeletedTabs(stored: string, next: string): string {
  try {
    const before = JSON.parse(stored) as { deletedTabs?: Array<{ tab?: { id?: unknown } }> } | null
    const after = JSON.parse(next) as { tabs?: Array<{ id?: unknown }>; deletedTabs?: unknown } | null
    if (!before?.deletedTabs?.length || !after || typeof after !== 'object' || Array.isArray(after) || 'deletedTabs' in after)
      return next
    const live = new Set((Array.isArray(after.tabs) ? after.tabs : []).map((tab) => tab?.id))
    const kept = before.deletedTabs.filter((entry) => !live.has(entry?.tab?.id))
    return kept.length ? JSON.stringify({ ...after, deletedTabs: kept }) : next
  } catch {
    return next
  }
}
