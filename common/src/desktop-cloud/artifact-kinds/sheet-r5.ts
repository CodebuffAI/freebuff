/**
 * Freebuff Sheets, round 5 — pure edits shared by the page and the agent's ops: data cleanup
 * (trim, remove duplicates, split text to columns, text to numbers or dates), paste special
 * (values only, formats only, transposed), rows imported into a tab with typed values, person
 * cells, and `describeSheet`, the structured read of everything a tab carries besides its
 * cells (formats, rules, validations, charts, names, protections, frozen panes, tables, groups).
 *
 * Every edit returns the workbook unchanged when nothing applies, so callers can say so.
 */

import { colName, parseSheetRange, rectSize, rectToRange, toAddress, type CellPos, type CellRect } from './sheet-address'
import { parseCsv, parseTsv } from './sheet-delimited'
import { applyInput, formatValue, parseInput } from './sheet-format'
import { isError, shiftFormula, type CellValue, type SheetEngine } from './sheet-formula'
import { setCells, tabById } from './sheet-ops'
import {
  MAX_CELL_PEOPLE,
  peopleText,
  SHEET_LIMITS,
  tabCols,
  tabRows,
  type CellPerson,
  type SheetCell,
  type SheetTab,
  type Workbook,
} from './sheet'

/** Most cells one cleanup or paste-special touches (as copyCells). */
export const R5_CELL_LIMIT = 50_000

function eachAddress(rect: CellRect, fn: (address: string, pos: CellPos) => void) {
  for (let row = rect.top; row <= rect.bottom; row += 1)
    for (let col = rect.left; col <= rect.right; col += 1) fn(toAddress({ row, col }), { row, col })
}

/** The rect clipped to the tab, or why it cannot be used. */
function inside(tab: SheetTab, rect: CellRect): CellRect | string {
  const clipped = { ...rect, bottom: Math.min(rect.bottom, tabRows(tab) - 1), right: Math.min(rect.right, tabCols(tab) - 1) }
  if (clipped.bottom < clipped.top || clipped.right < clipped.left) return 'that range is outside the tab'
  const size = rectSize(clipped)
  if (size.rows * size.cols > R5_CELL_LIMIT) return `at most ${R5_CELL_LIMIT.toLocaleString('en-US')} cells at once`
  return clipped
}

const STYLE_KEYS = [
  'fmt', 'bold', 'align', 'bg', 'italic', 'underline', 'strike', 'color', 'size', 'wrap', 'valign', 'border',
  'decimals', 'dateStyle', 'currency', 'font', 'indent', 'rotate', 'pattern',
] as const satisfies ReadonlyArray<keyof SheetCell>

/** A cell's formatting alone (what "paste formats only" carries). */
export function styleOf(cell: SheetCell | undefined): Partial<SheetCell> {
  const out: Record<string, unknown> = {}
  if (!cell) return out
  for (const key of STYLE_KEYS) if (cell[key] !== undefined) out[key] = cell[key]
  return out as Partial<SheetCell>
}

const contentOf = (cell: SheetCell | undefined): Partial<SheetCell> => {
  if (!cell) return {}
  const { v, f, runs, people, list, link, note } = cell
  return { ...(v !== undefined ? { v } : {}), ...(f !== undefined ? { f } : {}), ...(runs ? { runs } : {}), ...(people ? { people } : {}), ...(list ? { list } : {}), ...(link ? { link } : {}), ...(note ? { note } : {}) }
}

// ---- cleanup

export type CleanupResult = { workbook: Workbook; changed: number }

/** Trims leading/trailing spaces and collapses runs of inner spaces in text cells (formulas untouched). */
export function trimWhitespace(workbook: Workbook, tabId: string, rect: CellRect): CleanupResult | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'no such tab'
  const area = inside(tab, rect)
  if (typeof area === 'string') return area
  const updates = new Map<string, SheetCell | undefined>()
  eachAddress(area, (address) => {
    const cell = tab.cells[address]
    if (!cell || typeof cell.v !== 'string' || cell.f !== undefined) return
    const lines = cell.v.split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    const next = lines.join('\n').trim()
    if (next === cell.v) return
    // Rich text and people no longer spell the trimmed text: they fall away (pruneCell).
    updates.set(address, next === '' ? undefined : { ...cell, v: next })
  })
  return { workbook: setCells(workbook, tabId, updates), changed: updates.size }
}

/**
 * Removes rows of the block whose values (in `columns`, default all) repeat an earlier row,
 * shifting the kept rows up inside the block (cells below the block never move). With
 * `header`, the first row is kept and never compared. Compares what the cells compute.
 */
export function removeDuplicates(
  workbook: Workbook,
  engine: SheetEngine,
  tabId: string,
  rect: CellRect,
  options: { columns?: number[]; header?: boolean } = {},
): CleanupResult | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'no such tab'
  const area = inside(tab, rect)
  if (typeof area === 'string') return area
  const columns = (options.columns ?? []).filter((c) => c >= area.left && c <= area.right)
  const keyCols = columns.length ? columns : Array.from({ length: area.right - area.left + 1 }, (_, i) => area.left + i)
  const start = options.header ? area.top + 1 : area.top
  const seen = new Set<string>()
  const kept: number[] = []
  for (let row = start; row <= area.bottom; row += 1) {
    const key = JSON.stringify(keyCols.map((col) => valueKey(engine.value(tabId, row, col))))
    if (keyCols.every((col) => engine.value(tabId, row, col) === null)) {
      kept.push(row)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(row)
  }
  const removed = area.bottom - start + 1 - kept.length
  if (removed === 0) return { workbook, changed: 0 }
  const updates = new Map<string, SheetCell | undefined>()
  for (let i = 0; i <= area.bottom - start; i += 1) {
    const from = kept[i]
    for (let col = area.left; col <= area.right; col += 1) {
      const to = toAddress({ row: start + i, col })
      const cell = from === undefined ? undefined : tab.cells[toAddress({ row: from, col })]
      // A kept formula moves up with its row: its relative references shift with it.
      updates.set(to, cell?.f && from !== undefined ? { ...cell, f: shiftFormula(cell.f, start + i - from, 0) } : cell)
    }
  }
  return { workbook: setCells(workbook, tabId, updates), changed: removed }
}

const valueKey = (value: CellValue) => (isError(value) ? `#${value.error}` : typeof value === 'string' ? `s:${value.trim().toLowerCase()}` : `${typeof value}:${String(value)}`)

/** The separators "Split text to columns" understands. */
export const SPLIT_DELIMITERS = { comma: ',', semicolon: ';', tab: '\t', space: ' ', pipe: '|' } as const
export type SplitDelimiter = keyof typeof SPLIT_DELIMITERS | 'auto'

function guessDelimiter(texts: string[]): string {
  const counts = Object.values(SPLIT_DELIMITERS).map((d) => ({ d, n: texts.filter((t) => t.includes(d)).length }))
  counts.sort((a, b) => b.n - a.n)
  return counts[0].n > 0 ? counts[0].d : ','
}

/**
 * Splits each text cell of ONE column on a delimiter into the cells to its right, each part
 * read as typed input (so "12" becomes a number). Refuses when a part would land on a filled
 * cell, or past the tab's last column.
 */
export function splitToColumns(workbook: Workbook, tabId: string, rect: CellRect, delimiter: SplitDelimiter = 'auto'): CleanupResult | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'no such tab'
  if (rect.left !== rect.right) return 'split one column at a time'
  const area = inside(tab, rect)
  if (typeof area === 'string') return area
  const texts: Array<{ row: number; text: string }> = []
  for (let row = area.top; row <= area.bottom; row += 1) {
    const cell = tab.cells[toAddress({ row, col: area.left })]
    if (typeof cell?.v === 'string' && cell.f === undefined) texts.push({ row, text: cell.v })
  }
  const sep = delimiter === 'auto' ? guessDelimiter(texts.map((t) => t.text)) : SPLIT_DELIMITERS[delimiter]
  const updates = new Map<string, SheetCell | undefined>()
  let changed = 0
  for (const { row, text } of texts) {
    const parts = (sep === ',' ? parseCsv(text)[0] ?? [text] : sep === '\t' ? parseTsv(text)[0] ?? [text] : text.split(sep)).map((p) => p.trim())
    if (parts.length < 2) continue
    if (area.left + parts.length - 1 >= tabCols(tab)) return `row ${row + 1} splits into ${parts.length} parts, past the tab's last column`
    for (let i = 1; i < parts.length; i += 1) {
      const address = toAddress({ row, col: area.left + i })
      const there = tab.cells[address]
      if (there && (there.v !== undefined || there.f !== undefined))
        return `${address} is not empty; make room to the right of the column first`
    }
    parts.forEach((part, i) => {
      const address = toAddress({ row, col: area.left + i })
      const base = i === 0 ? styleOf(tab.cells[address]) : styleOf(tab.cells[address])
      const cell = applyInput(base as SheetCell, part, { locale: workbook.locale, rich: false })
      updates.set(address, cell?.f ? { ...cell, f: undefined, v: cell.f, fmt: 'text' } : cell)
    })
    changed += 1
  }
  return { workbook: setCells(workbook, tabId, updates), changed }
}

export type ConvertTarget = 'number' | 'date'

/**
 * Text that reads as a number (or a date) becomes one: "1,234", "$5", "12%" → numbers with
 * their format; "2026-11-20", "Nov 20, 2026" → dates. Other text is left alone.
 */
export function convertText(workbook: Workbook, tabId: string, rect: CellRect, to: ConvertTarget): CleanupResult | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'no such tab'
  const area = inside(tab, rect)
  if (typeof area === 'string') return area
  const updates = new Map<string, SheetCell | undefined>()
  eachAddress(area, (address) => {
    const cell = tab.cells[address]
    if (!cell || typeof cell.v !== 'string' || cell.f !== undefined) return
    const parsed = parseInput(cell.v.trim(), { locale: workbook.locale, rich: false })
    const isNumber = typeof parsed.v === 'number' && parsed.fmt !== 'date' && parsed.fmt !== 'time' && parsed.fmt !== 'datetime'
    const isDate = parsed.fmt === 'date' || parsed.fmt === 'datetime'
    if ((to === 'number' && !isNumber) || (to === 'date' && !isDate)) return
    const { runs: _r, people: _p, list: _l, fmt: oldFmt, ...rest } = cell
    const fmt = parsed.fmt ?? (oldFmt === 'text' ? undefined : oldFmt)
    updates.set(address, { ...rest, v: parsed.v, ...(fmt ? { fmt } : {}), ...(parsed.currency ? { currency: parsed.currency } : {}) })
  })
  return { workbook: setCells(workbook, tabId, updates), changed: updates.size }
}

// ---- paste special

export type PasteMode = 'values' | 'formats' | 'transpose'

/** A copied block for paste special: its cells and what they computed when copied. */
export type CopiedBlock = { origin: CellPos; cells: Array<Array<SheetCell | undefined>>; values: CellValue[][] }

export function copyBlock(workbook: Workbook, engine: SheetEngine, tabId: string, rect: CellRect): CopiedBlock | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'no such tab'
  const area = inside(tab, rect)
  if (typeof area === 'string') return area
  const cells: CopiedBlock['cells'] = []
  const values: CopiedBlock['values'] = []
  for (let row = area.top; row <= area.bottom; row += 1) {
    const line: Array<SheetCell | undefined> = []
    const shown: CellValue[] = []
    for (let col = area.left; col <= area.right; col += 1) {
      line.push(tab.cells[toAddress({ row, col })])
      shown.push(engine.value(tabId, row, col))
    }
    cells.push(line)
    values.push(shown)
  }
  return { origin: { row: area.top, col: area.left }, cells, values }
}

/**
 * Pastes a copied block at `dest` on `toTabId`: `values` writes what the cells computed (no
 * formulas; the destination's formatting stays, the source's number format comes along),
 * `formats` writes only the formatting (values stay), `transpose` writes the block turned
 * (rows become columns), formulas shifting by each cell's own move. Across tabs, a formula's
 * unqualified references shift and point at the destination tab, as in Excel.
 */
export function pasteSpecial(workbook: Workbook, toTabId: string, dest: CellPos, block: CopiedBlock, mode: PasteMode): { workbook: Workbook; rect: CellRect } | string {
  const tab = tabById(workbook, toTabId)
  if (!tab) return 'no such tab'
  const height = block.cells.length
  const width = block.cells[0]?.length ?? 0
  if (!height || !width) return 'nothing was copied'
  const [h, w] = mode === 'transpose' ? [width, height] : [height, width]
  const rect = { top: dest.row, left: dest.col, bottom: dest.row + h - 1, right: dest.col + w - 1 }
  if (rect.bottom >= tabRows(tab) || rect.right >= tabCols(tab)) return `the paste needs ${h}×${w} cells from ${toAddress(dest)}, past the tab's edge`
  const updates = new Map<string, SheetCell | undefined>()
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const source = block.cells[r][c]
      const pos = mode === 'transpose' ? { row: dest.row + c, col: dest.col + r } : { row: dest.row + r, col: dest.col + c }
      const address = toAddress(pos)
      const existing = tab.cells[address]
      if (mode === 'formats') {
        updates.set(address, { ...contentOf(existing), ...styleOf(source) } as SheetCell)
        continue
      }
      if (mode === 'values') {
        const value = block.values[r][c]
        const literal = value === null || isError(value) ? undefined : value
        const fmt = source?.fmt
        const base = styleOf(existing)
        updates.set(
          address,
          literal === undefined
            ? Object.keys(base).length ? (base as SheetCell) : undefined
            : ({ ...base, v: literal, ...(fmt ? { fmt } : {}), ...(source?.currency ? { currency: source.currency } : {}) } as SheetCell),
        )
        continue
      }
      // transpose
      const from = { row: block.origin.row + r, col: block.origin.col + c }
      updates.set(address, source?.f ? { ...source, f: shiftFormula(source.f, pos.row - from.row, pos.col - from.col) } : source)
    }
  }
  return { workbook: setCells(workbook, toTabId, updates), rect }
}

// ---- import rows into a tab

/**
 * Delimited text (CSV, or TSV when it holds tabs and no commas on the first line) written into
 * a tab from `at` (default A1), each field read as typed input: numbers, percents, currency,
 * dates and booleans get their types. A field starting with "=" stays text. Grows the tab's
 * rows or columns when the data needs more (within the limits).
 */
export function importRows(
  workbook: Workbook,
  tabId: string,
  text: string,
  options: { at?: CellPos; delimiter?: 'comma' | 'tab' } = {},
): { workbook: Workbook; rect: CellRect; cells: number } | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'no such tab'
  const first = text.split('\n', 1)[0] ?? ''
  const tsv = options.delimiter ? options.delimiter === 'tab' : first.includes('\t') && !first.includes(',')
  const lines = (tsv ? parseTsv(text) : parseCsv(text)).filter((line, i, all) => i < all.length - 1 || line.some((f) => f !== ''))
  if (!lines.length) return 'the text has no rows'
  const at = options.at ?? { row: 0, col: 0 }
  const height = lines.length
  const width = Math.max(...lines.map((line) => line.length))
  if (at.row + height > SHEET_LIMITS.rows) return `that is ${height} rows; a tab holds at most ${SHEET_LIMITS.rows}`
  if (at.col + width > SHEET_LIMITS.cols) return `that is ${width} columns; a tab holds at most ${SHEET_LIMITS.cols}`
  if (height * width > R5_CELL_LIMIT) return `at most ${R5_CELL_LIMIT.toLocaleString('en-US')} cells per import; split the text`
  let next = workbook
  const rows = Math.max(tabRows(tab), at.row + height)
  const cols = Math.max(tabCols(tab), at.col + width)
  if (rows !== tabRows(tab) || cols !== tabCols(tab)) {
    next = { ...next, tabs: next.tabs.map((t) => (t.id === tabId ? { ...t, rows, cols } : t)) }
  }
  const updates = new Map<string, SheetCell | undefined>()
  lines.forEach((line, r) =>
    line.forEach((field, c) => {
      const address = toAddress({ row: at.row + r, col: at.col + c })
      const cell = applyInput(tab.cells[address], field, { locale: workbook.locale, rich: false })
      updates.set(address, cell?.f ? { ...cell, f: undefined, v: cell.f, fmt: 'text' } : cell)
    }),
  )
  return { workbook: setCells(next, tabId, updates), rect: { top: at.row, left: at.col, bottom: at.row + height - 1, right: at.col + width - 1 }, cells: updates.size }
}

// ---- people

/** A person cell holding `people` (display names), keeping the cell's formatting. */
export function personCell(old: SheetCell | undefined, people: CellPerson[]): SheetCell | undefined {
  const { v: _v, f: _f, runs: _r, people: _p, list: _l, fmt: _fmt, ...style } = old ?? {}
  const unique = people.filter((p, i) => people.findIndex((q) => q.name.toLowerCase() === p.name.toLowerCase()) === i).slice(0, MAX_CELL_PEOPLE)
  if (!unique.length) return Object.keys(style).length ? (style as SheetCell) : undefined
  return { ...style, v: peopleText(unique), people: unique }
}

/** A display name made safe for a person cell (no commas, trimmed, ≤ 80 chars, never an email), or null. */
export function personName(raw: string): string | null {
  const name = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim()
  // Bodies are readable by link viewers and the agent: a person cell never holds an email.
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(name)) return null
  return name ? name : null
}

// ---- describeSheet: the structured read

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/**
 * Everything one tab carries besides cell values, as short lines for the agent: frozen panes,
 * hidden lines and row heights, groups, tables, the filter, merges, conditional formatting
 * rules, validations (dropdown options with colours), protections, charts, the formats in use
 * (by range), person and list cells, and the workbook's defined names. Never throws.
 */
export function describeSheet(workbook: Workbook, tabRef?: string): string {
  const tabs = tabRef ? workbook.tabs.filter((t) => t.id === tabRef || t.name.toLowerCase() === tabRef.toLowerCase()) : workbook.tabs
  const out: string[] = []
  for (const tab of tabs) {
    const lines: string[] = []
    const frozen = [tab.frozenRows ? `${tab.frozenRows} row${tab.frozenRows > 1 ? 's' : ''}` : '', tab.frozenCols ? `${tab.frozenCols} column${tab.frozenCols > 1 ? 's' : ''}` : ''].filter(Boolean)
    if (frozen.length) lines.push(`frozen: ${frozen.join(', ')}`)
    if (tab.gridlines === false) lines.push('grid lines hidden')
    const hiddenRows = Object.entries(tab.rowMeta ?? {}).filter(([, m]) => m.hidden).map(([r]) => r)
    const tallRows = Object.entries(tab.rowMeta ?? {}).filter(([, m]) => m.height).map(([r, m]) => `${r}=${m.height}px`)
    const hiddenCols = (tab.columns ?? []).flatMap((c, i) => (c?.hidden ? [colName(i)] : []))
    if (hiddenRows.length) lines.push(`hidden rows: ${hiddenRows.slice(0, 30).join(', ')}${hiddenRows.length > 30 ? ', …' : ''}`)
    if (hiddenCols.length) lines.push(`hidden columns: ${hiddenCols.join(', ')}`)
    if (tallRows.length) lines.push(`row heights: ${tallRows.slice(0, 20).join(', ')}${tallRows.length > 20 ? ', …' : ''}`)
    const widths = (tab.columns ?? []).flatMap((c, i) => (c?.width ? [`${colName(i)}=${c.width}px`] : []))
    if (widths.length) lines.push(`column widths: ${widths.slice(0, 26).join(', ')}`)
    if (tab.rowGroups?.length) lines.push(`row groups: ${tab.rowGroups.map((g) => `${g.from}:${g.to}${g.collapsed ? ' collapsed' : ''}`).join(', ')}`)
    if (tab.colGroups?.length) lines.push(`column groups: ${tab.colGroups.map((g) => `${g.from}:${g.to}${g.collapsed ? ' collapsed' : ''}`).join(', ')}`)
    for (const t of tab.tables ?? []) lines.push(`table ${t.id} ${t.range}${t.header === false ? ' (no header)' : ''}${t.banded === false ? ' (not banded)' : ''}${t.color ? ` ${t.color}` : ''}`)
    if (tab.filter) {
      const saved = Object.entries(tab.filter.columns ?? {}).map(([col, f]) => `${col} ${JSON.stringify(f)}`)
      lines.push(`filter on ${tab.filter.range}${saved.length ? `, saved: ${saved.join('; ')}` : ''}${tab.filter.sort ? `, sorted by ${tab.filter.sort.col}${tab.filter.sort.desc ? ' desc' : ''}` : ''}`)
    }
    if (tab.merges?.length) lines.push(`merges: ${tab.merges.slice(0, 30).join(', ')}${tab.merges.length > 30 ? ', …' : ''}`)
    for (const rule of tab.rules ?? []) {
      const what =
        rule.type === 'scale'
          ? `colour scale ${(rule.scale ?? ['red', 'yellow', 'green']).join('→')}`
          : rule.type === 'bars'
            ? `data bars${rule.style?.bg ? ` ${rule.style.bg}` : ''}`
            : rule.type === 'icons'
              ? `icon set ${rule.icons ?? 'arrows'}`
              : `${rule.type}${rule.value !== undefined ? ` ${JSON.stringify(rule.value)}` : ''}${rule.value2 !== undefined ? ` and ${rule.value2}` : ''} → ${JSON.stringify(rule.style ?? {})}`
      lines.push(`rule ${rule.id} on ${rule.range}: ${what}`)
    }
    for (const v of tab.validations ?? []) {
      const detail =
        v.kind === 'list'
          ? `options ${v.options.map((o) => (o.color ? `${o.value} (${o.color})` : o.value)).slice(0, 20).join(', ')}`
          : v.kind === 'number'
            ? `${v.min ?? '-∞'}..${v.max ?? '∞'}${v.integer ? ' whole' : ''}`
            : v.kind === 'date'
              ? `${v.from ?? '…'}..${v.to ?? '…'}`
              : v.kind === 'custom'
                ? v.formula
                : ''
      const mode = 'mode' in v && v.mode ? ` (${v.mode})` : ''
      lines.push(`validation on ${v.range}: ${v.kind}${detail ? ` ${detail}` : ''}${mode}`)
    }
    for (const p of tab.protected ?? []) lines.push(`protected ${p.range} (id ${p.id})${p.note ? `: ${clip(p.note, 80)}` : ''} — only the owner may change it`)
    for (const chart of tab.charts ?? []) {
      const s = chart.spec
      lines.push(
        `chart ${chart.id} at ${chart.anchor}${chart.width ? ` ${chart.width}×${chart.height ?? 300}` : ''}: ${s.stacked ? 'stacked ' : ''}${s.type} of ${s.range}${s.title ? ` "${clip(s.title, 60)}"` : ''}${s.seriesIn === 'rows' ? ', series in rows' : ''}${s.header === false ? ', no header' : ''}${s.legend === false ? ', no legend' : ''}`,
      )
    }
    lines.push(...formatLines(tab))
    if (lines.length) out.push(`${tab.name} (id ${tab.id}):\n${lines.map((l) => `  - ${l}`).join('\n')}`)
    else out.push(`${tab.name} (id ${tab.id}): no formats, rules, validations, charts or protections`)
  }
  const names = (workbook.names ?? []).map((n) => `${n.name} = ${workbook.tabs.find((t) => t.id === n.tab)?.name ?? n.tab}!${n.range}${n.comment ? ` (${clip(n.comment, 60)})` : ''}`)
  if (names.length && (!tabRef || tabs.length)) out.push(`Defined names: ${names.join('; ')}`)
  return out.join('\n')
}

/**
 * The formats in use on a tab, grouped: each distinct format (number format, pattern, style)
 * with the ranges that carry it, merged into column runs so a formatted column is one range.
 */
function formatLines(tab: SheetTab): string[] {
  const groups = new Map<string, Array<{ row: number; col: number }>>()
  const special: string[] = []
  for (const [address, cell] of Object.entries(tab.cells)) {
    const style = styleOf(cell)
    const pos = parseSheetRange(address)?.rect
    if (!pos) continue
    if (Object.keys(style).length) {
      const key = JSON.stringify(style)
      let list = groups.get(key)
      if (!list) groups.set(key, (list = []))
      list.push({ row: pos.top, col: pos.left })
    }
    if (cell.people) special.push(`${address} person: ${cell.people.map((p) => p.name).join(', ')}`)
    if (cell.list) special.push(`${address} ${cell.list} list`)
    if (cell.link) special.push(`${address} links ${clip(cell.link, 80)}`)
    if (cell.note) special.push(`${address} note "${clip(cell.note, 60)}"`)
  }
  const lines: string[] = []
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 30)
  for (const [key, cells] of sorted) lines.push(`format ${key} on ${ranges(cells).slice(0, 12).join(', ')}${ranges(cells).length > 12 ? ', …' : ''}`)
  if (groups.size > 30) lines.push(`… ${groups.size - 30} more distinct formats`)
  lines.push(...special.slice(0, 40))
  if (special.length > 40) lines.push(`… ${special.length - 40} more person, list, link or note cells`)
  return lines
}

/** Cells as ranges: vertical runs in each column, then side-by-side runs with the same rows joined. */
function ranges(cells: Array<{ row: number; col: number }>): string[] {
  const byCol = new Map<number, number[]>()
  for (const { row, col } of cells) {
    let list = byCol.get(col)
    if (!list) byCol.set(col, (list = []))
    list.push(row)
  }
  const runs: CellRect[] = []
  for (const [col, rows] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a - b)
    let start = rows[0]
    for (let i = 1; i <= rows.length; i += 1) {
      if (i < rows.length && rows[i] === rows[i - 1] + 1) continue
      const run = { top: start, bottom: rows[i - 1], left: col, right: col }
      const prev = runs[runs.length - 1]
      if (prev && prev.top === run.top && prev.bottom === run.bottom && prev.right === col - 1) prev.right = col
      else runs.push(run)
      start = rows[i]
    }
  }
  return runs.map(rectToRange)
}

/** The display text of a value under a cell's formats (re-exported for the page's chips). */
export const shownText = (value: CellValue, cell: SheetCell | undefined, locale?: string) => formatValue(value, cell?.fmt, { ...(cell ?? {}), ...(locale ? { locale } : {}) })
