/**
 * Freebuff Sheets — "Summarise": a pivot-style summary of a range on a new tab,
 * written as LIVE formulas, never a static copy. The group keys are one spilled
 * formula (`SORT(UNIQUE(FILTER(...)))`) and each measure one spilled *IFS
 * formula whose criteria are the key spill (`SUMIFS(..., A2#)`), so editing the
 * source updates the summary, and new keys appear on their own.
 *
 * As in Excel, a text key that reads as a criterion (">5", "a*") matches by
 * that criterion.
 */

import { colName, quoteTabName, toAddress, type CellRect } from './sheet-address'
import { addTab, tabNameProblem } from './sheet-ops'
import { SHEET_LIMITS, type SheetCell, type Workbook } from './sheet'
import type { SheetEngine } from './sheet-formula'

export const SUMMARY_AGGS = ['sum', 'count', 'average', 'min', 'max'] as const
export type SummaryAgg = (typeof SUMMARY_AGGS)[number]

export const SUMMARY_AGG_LABEL: Record<SummaryAgg, string> = {
  sum: 'Sum',
  count: 'Count',
  average: 'Average',
  min: 'Min',
  max: 'Max',
}

const AGG_FUNCTION: Record<SummaryAgg, string> = {
  sum: 'SUMIFS',
  count: 'COUNTIFS',
  average: 'AVERAGEIFS',
  min: 'MINIFS',
  max: 'MAXIFS',
}

export type SummarySpec = {
  /** The source tab and block, header row included. */
  tabId: string
  rect: CellRect
  /** One or two absolute column indexes to group by. */
  groupBy: number[]
  /** What to compute per group; `count` ignores its column's values. */
  values: Array<{ col: number; agg: SummaryAgg }>
  /** The new tab's name (default "Summary of <tab>"). */
  name?: string
}

export type SummaryResult = { ok: true; workbook: Workbook; tabId: string } | { ok: false; error: string }

/** The header text of a source column, else its letter. */
function headerOf(workbook: Workbook, engine: SheetEngine | null, tabId: string, row: number, col: number): string {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  const cell = tab?.cells[toAddress({ row, col })]
  const shown = engine?.value(tabId, row, col)
  const text = typeof shown === 'string' || typeof shown === 'number' ? String(shown) : typeof cell?.v === 'string' ? cell.v : ''
  return text.trim() || `Column ${colName(col)}`
}

/** The formulas of a summary, by address on the new tab (exported for tests and the panel preview). */
export function summaryCells(workbook: Workbook, spec: SummarySpec, engine: SheetEngine | null = null): Record<string, SheetCell> | string {
  const tab = workbook.tabs.find((t) => t.id === spec.tabId)
  if (!tab) return 'no such tab'
  const { rect } = spec
  if (rect.bottom - rect.top < 1) return 'select a header row and at least one row of data'
  const groups = [...new Set(spec.groupBy)]
  if (groups.length < 1 || groups.length > 2) return 'group by one or two columns'
  if (!spec.values.length) return 'add at least one value to compute'
  if (spec.values.length > 20) return 'at most 20 values'
  const inside = (col: number) => col >= rect.left && col <= rect.right
  if (![...groups, ...spec.values.map((v) => v.col)].every(inside)) return 'every column must be inside the range'

  const prefix = `${quoteTabName(tab.name)}!`
  const column = (col: number) =>
    `${prefix}${toAddress({ row: rect.top + 1, col })}:${toAddress({ row: rect.bottom, col })}`
  const keyCol = column(groups[0])
  // The keys: distinct (non-blank) rows of the group columns, sorted.
  const source =
    groups.length === 1
      ? keyCol
      : `CHOOSECOLS(${prefix}${toAddress({ row: rect.top + 1, col: Math.min(...groups) })}:${toAddress({ row: rect.bottom, col: Math.max(...groups) })}, ${groups
          .map((g) => g - Math.min(...groups) + 1)
          .join(', ')})`
  const cells: Record<string, SheetCell> = {}
  groups.forEach((g, i) => {
    cells[toAddress({ row: 0, col: i })] = { v: headerOf(workbook, engine, tab.id, rect.top, g), bold: true, bg: 'gray' }
  })
  cells.A2 = { f: `=SORT(UNIQUE(FILTER(${source}, ${keyCol}<>"")))` }
  const criteria =
    groups.length === 1
      ? `${keyCol}, A2#`
      : groups.map((g, i) => `${column(g)}, INDEX(A2#, 0, ${i + 1})`).join(', ')
  spec.values.forEach((value, i) => {
    const col = groups.length + i
    const label = `${SUMMARY_AGG_LABEL[value.agg]} of ${headerOf(workbook, engine, tab.id, rect.top, value.col)}`
    cells[toAddress({ row: 0, col })] = { v: label.slice(0, 200), bold: true, bg: 'gray' }
    const fn = AGG_FUNCTION[value.agg]
    const formula = value.agg === 'count' ? `=${fn}(${criteria})` : `=${fn}(${column(value.col)}, ${criteria})`
    cells[toAddress({ row: 1, col })] = { f: formula, ...(value.agg === 'count' ? {} : { fmt: 'number' as const }) }
  })
  return cells
}

/** Add the summary as a new tab after the others. */
export function summarise(workbook: Workbook, spec: SummarySpec, engine: SheetEngine | null = null): SummaryResult {
  if (workbook.tabs.length >= SHEET_LIMITS.tabs) return { ok: false, error: `a workbook has at most ${SHEET_LIMITS.tabs} tabs` }
  const cells = summaryCells(workbook, spec, engine)
  if (typeof cells === 'string') return { ok: false, error: cells }
  const source = workbook.tabs.find((t) => t.id === spec.tabId)!
  let name = (spec.name?.trim() || `Summary of ${source.name}`).slice(0, 31).trim()
  if (tabNameProblem(workbook, name) !== null) {
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${name.slice(0, 27)} ${n}`
      if (tabNameProblem(workbook, candidate) === null) {
        name = candidate
        break
      }
    }
  }
  const width = spec.groupBy.length + spec.values.length
  const result = addTab(workbook, {
    name,
    cells,
    frozenRows: 1,
    columns: Array.from({ length: width }, () => ({ width: 150 })),
  })
  return { ok: true, workbook: result.workbook, tabId: result.tabId }
}
