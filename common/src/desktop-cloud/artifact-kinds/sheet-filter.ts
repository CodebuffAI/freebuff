/**
 * Freebuff Sheets — column filters, shared by the page and the server.
 *
 * A tab's filter row (`tab.filter`) may carry a SAVED filter (`columns`, by column
 * letter) that everyone sees. A viewer may also keep a private filter view on
 * top (page state, never stored); when they have one for a filter, it replaces
 * the saved one for them until they reset it.
 */

import { colIndex, colName } from './sheet-address'
import { dateToSerial, isError, isoToSerial, type CellValue } from './sheet-formula'
import type { ColumnFilter, DatePreset, SheetTab, Workbook } from './sheet'

export type { ColumnFilter, DatePreset }

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisWeek: 'This week',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisYear: 'This year',
}

export function columnFilterActive(filter: ColumnFilter | undefined): boolean {
  return Boolean(filter && (filter.values || filter.contains || filter.op || filter.date))
}

const serialParts = (serial: number) => {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000)
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), weekday: date.getUTCDay() }
}

/** The inclusive day serials a date filter keeps, given today's serial. */
export function dateWindow(date: NonNullable<ColumnFilter['date']>, today: number): [number, number] {
  let from = -Infinity
  let to = Infinity
  if (date.preset) {
    const { y, m, weekday } = serialParts(today)
    switch (date.preset) {
      case 'today':
        ;[from, to] = [today, today]
        break
      case 'yesterday':
        ;[from, to] = [today - 1, today - 1]
        break
      case 'last7':
        ;[from, to] = [today - 6, today]
        break
      case 'last30':
        ;[from, to] = [today - 29, today]
        break
      case 'thisWeek':
        // Weeks start on Monday.
        from = today - ((weekday + 6) % 7)
        to = from + 6
        break
      case 'thisMonth':
        ;[from, to] = [dateToSerial(y, m, 1), dateToSerial(y, m + 1, 1) - 1]
        break
      case 'lastMonth':
        ;[from, to] = [dateToSerial(y, m - 1, 1), dateToSerial(y, m, 1) - 1]
        break
      case 'thisYear':
        ;[from, to] = [dateToSerial(y, 1, 1), dateToSerial(y + 1, 1, 1) - 1]
        break
    }
  }
  const a = date.from ? isoToSerial(date.from) : null
  const b = date.to ? isoToSerial(date.to) : null
  if (a !== null) from = Math.max(from, a)
  if (b !== null) to = Math.min(to, b)
  return [from, to]
}

const filterNumber = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null
  const iso = isoToSerial(raw.trim())
  if (iso !== null) return iso
  const n = Number(raw.replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? (raw.trim().endsWith('%') ? n / 100 : n) : null
}

/** Whether a cell (its value and shown text) passes one column filter. */
export function passesFilter(filter: ColumnFilter, value: CellValue, text: string, today: number): boolean {
  if (filter.values && !filter.values.includes(text)) return false
  if (filter.contains && !text.toLowerCase().includes(filter.contains.toLowerCase())) return false
  if (filter.op) {
    const a = filterNumber(filter.a)
    const b = filterNumber(filter.b)
    if (typeof value !== 'number' || a === null) return false
    if (filter.op === 'gt' && !(value > a)) return false
    if (filter.op === 'lt' && !(value < a)) return false
    if (filter.op === 'eq' && value !== a) return false
    if (filter.op === 'between' && (b === null || value < Math.min(a, b) || value > Math.max(a, b))) return false
  }
  if (filter.date) {
    // Dates are day serials; an ISO text date counts too.
    const serial = typeof value === 'number' ? value : typeof value === 'string' ? isoToSerial(value) : null
    if (serial === null || isError(value)) return false
    const [from, to] = dateWindow(filter.date, today)
    const day = Math.floor(serial)
    if (day < from || day > to) return false
  }
  return true
}

/** A tab's saved filter as absolute column index → filter. */
export function savedColumns(tab: SheetTab): Record<number, ColumnFilter> {
  const out: Record<number, ColumnFilter> = {}
  for (const [letters, filter] of Object.entries(tab.filter?.columns ?? {})) out[colIndex(letters)] = filter
  return out
}

/** Save `columns` (absolute column index → filter) on the tab's filter for everyone; null clears it. */
export function saveFilter(workbook: Workbook, tabId: string, columns: Record<number, ColumnFilter> | null): Workbook {
  const tabs = workbook.tabs.map((tab) => {
    if (tab.id !== tabId || !tab.filter) return tab
    const saved: Record<string, ColumnFilter> = {}
    for (const [col, filter] of Object.entries(columns ?? {})) if (columnFilterActive(filter)) saved[colName(Number(col))] = filter
    const { columns: _old, ...rest } = tab.filter
    const filter = Object.keys(saved).length ? { ...rest, columns: saved } : rest
    return JSON.stringify(filter) === JSON.stringify(tab.filter) ? tab : { ...tab, filter }
  })
  return tabs.some((tab, i) => tab !== workbook.tabs[i]) ? { ...workbook, tabs } : workbook
}

/** Remember the filter's sort (shown on its column's button). */
export function setFilterSort(workbook: Workbook, tabId: string, sort: { col: number; desc?: boolean } | null): Workbook {
  const tabs = workbook.tabs.map((tab) => {
    if (tab.id !== tabId || !tab.filter) return tab
    const { sort: _old, ...rest } = tab.filter
    return { ...tab, filter: sort ? { ...rest, sort: { col: colName(sort.col), ...(sort.desc ? { desc: true } : {}) } } : rest }
  })
  return { ...workbook, tabs }
}
