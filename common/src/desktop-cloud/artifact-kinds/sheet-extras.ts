/**
 * Freebuff Sheets — round-4 edits shared by the page and the agent's ops: copy a block with
 * relative references, fold rows/columns into groups, grid lines, the workbook's locale and
 * time zone, and fitting a column to its text. Pure; each returns its input unchanged (or an
 * error) when it cannot apply.
 */

import { colIndex, colName, rectSize, toAddress, type CellPos, type CellRect } from './sheet-address'
import { formatValue } from './sheet-format'
import { shiftFormula, type SheetEngine } from './sheet-formula'
import { setCells, tabById } from './sheet-ops'
import {
  isTimeZone,
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  SHEET_LIMITS,
  SHEET_LOCALES,
  tabCols,
  tabRows,
  type SheetCell,
  type SheetLocale,
  type SheetTab,
  type Workbook,
} from './sheet'

/** Most cells one copy writes. */
export const COPY_LIMIT = 50_000

/**
 * Copy `rect` of one tab to `dest` (its top-left) on the same or another tab, as a paste of the
 * cells themselves: relative references shift by the move, absolute ones stay, an empty source
 * cell clears its target. Formatting comes along.
 */
export function copyCells(
  workbook: Workbook,
  fromTabId: string,
  rect: CellRect,
  toTabId: string,
  dest: CellPos,
): { workbook: Workbook; rect: CellRect } | { error: string } {
  const from = tabById(workbook, fromTabId)
  const to = tabById(workbook, toTabId)
  if (!from || !to) return { error: 'No such tab.' }
  const size = rectSize(rect)
  if (size.rows * size.cols > COPY_LIMIT) return { error: `Copy at most ${COPY_LIMIT.toLocaleString('en-US')} cells at once.` }
  const target = { top: dest.row, left: dest.col, bottom: dest.row + size.rows - 1, right: dest.col + size.cols - 1 }
  if (target.bottom >= tabRows(to) || target.right >= tabCols(to)) {
    return { error: `The copy would run past ${to.name}'s ${tabRows(to)}×${tabCols(to)}.` }
  }
  const dRow = dest.row - rect.top
  const dCol = dest.col - rect.left
  const updates = new Map<string, SheetCell | undefined>()
  for (let r = 0; r < size.rows; r += 1) {
    for (let c = 0; c < size.cols; c += 1) {
      const cell = from.cells[toAddress({ row: rect.top + r, col: rect.left + c })]
      const address = toAddress({ row: dest.row + r, col: dest.col + c })
      updates.set(address, cell?.f ? { ...cell, f: shiftFormula(cell.f, dRow, dCol) } : cell)
    }
  }
  return { workbook: setCells(workbook, toTabId, updates), rect: target }
}

// ---- groups

export type GroupAxis = 'row' | 'col'
/** A group as 0-based inclusive line indexes. */
export type LineGroup = { from: number; to: number; collapsed: boolean }

export function groupsOf(tab: SheetTab, axis: GroupAxis): LineGroup[] {
  if (axis === 'row') return (tab.rowGroups ?? []).map((g) => ({ from: g.from - 1, to: g.to - 1, collapsed: Boolean(g.collapsed) }))
  return (tab.colGroups ?? []).map((g) => ({ from: colIndex(g.from), to: colIndex(g.to), collapsed: Boolean(g.collapsed) }))
}

function withGroups(tab: SheetTab, axis: GroupAxis, groups: LineGroup[]): SheetTab {
  const sorted = [...groups].sort((a, b) => a.from - b.from)
  if (axis === 'row') {
    const { rowGroups: _old, ...rest } = tab
    return sorted.length
      ? { ...rest, rowGroups: sorted.map((g) => ({ from: g.from + 1, to: g.to + 1, ...(g.collapsed ? { collapsed: true } : {}) })) }
      : rest
  }
  const { colGroups: _old, ...rest } = tab
  return sorted.length
    ? { ...rest, colGroups: sorted.map((g) => ({ from: colName(g.from), to: colName(g.to), ...(g.collapsed ? { collapsed: true } : {}) })) }
    : rest
}

function replaceTab(workbook: Workbook, tabId: string, next: SheetTab): Workbook {
  return { ...workbook, tabs: workbook.tabs.map((tab) => (tab.id === tabId ? next : tab)) }
}

/** The line that carries a group's +/−: the one after it, or the one before when it ends the tab. */
export function toggleLine(group: LineGroup, length: number): number {
  return group.to + 1 < length ? group.to + 1 : group.from - 1
}

/**
 * The group a line sits in, or (with `length`) the group whose +/− that line carries, so a
 * folded group can be found from the visible line beside it.
 */
export function groupAt(tab: SheetTab, axis: GroupAxis, line: number, length?: number): LineGroup | undefined {
  const groups = groupsOf(tab, axis)
  return groups.find((g) => line >= g.from && line <= g.to) ?? (length === undefined ? undefined : groups.find((g) => toggleLine(g, length) === line))
}

/** Group lines [from, to] (0-based). Refused when it overlaps a group or passes the tab. */
export function addGroup(workbook: Workbook, tabId: string, axis: GroupAxis, from: number, to: number): Workbook | string {
  const tab = tabById(workbook, tabId)
  if (!tab) return 'No such tab.'
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const length = axis === 'row' ? tabRows(tab) : tabCols(tab)
  if (lo < 0 || hi >= length) return `The tab has ${length} ${axis === 'row' ? 'rows' : 'columns'}.`
  if (lo === 0 && hi === length - 1) return `A group leaves at least one ${axis === 'row' ? 'row' : 'column'} outside it.`
  const groups = groupsOf(tab, axis)
  if (groups.some((g) => g.from <= hi && lo <= g.to)) return 'Those lines overlap a group; ungroup it first.'
  if (groups.length >= SHEET_LIMITS.groups) return `A tab has at most ${SHEET_LIMITS.groups} ${axis} groups.`
  return replaceTab(workbook, tabId, withGroups(tab, axis, [...groups, { from: lo, to: hi, collapsed: false }]))
}

/** Remove every group that touches [from, to]; unchanged when none does. */
export function removeGroups(workbook: Workbook, tabId: string, axis: GroupAxis, from: number, to: number): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab) return workbook
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const groups = groupsOf(tab, axis)
  const kept = groups.filter((g) => !(g.from <= hi && lo <= g.to))
  return kept.length === groups.length ? workbook : replaceTab(workbook, tabId, withGroups(tab, axis, kept))
}

/** Fold or unfold the group holding `line`; unchanged when there is none or it already is. */
export function setGroupCollapsed(workbook: Workbook, tabId: string, axis: GroupAxis, line: number, collapsed: boolean): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab) return workbook
  const groups = groupsOf(tab, axis)
  const length = axis === 'row' ? tabRows(tab) : tabCols(tab)
  let index = groups.findIndex((g) => line >= g.from && line <= g.to)
  if (index === -1) index = groups.findIndex((g) => toggleLine(g, length) === line)
  if (index === -1 || groups[index].collapsed === collapsed) return workbook
  const next = groups.map((g, i) => (i === index ? { ...g, collapsed } : g))
  return replaceTab(workbook, tabId, withGroups(tab, axis, next))
}

// ---- view settings

/** Show or hide a tab's grid lines (shown is the default, so it removes the field). */
export function setGridlines(workbook: Workbook, tabId: string, show: boolean): Workbook {
  const tab = tabById(workbook, tabId)
  if (!tab || (tab.gridlines !== false) === show) return workbook
  const { gridlines: _g, ...rest } = tab
  return replaceTab(workbook, tabId, show ? rest : { ...rest, gridlines: false })
}

export function setLocale(workbook: Workbook, locale: string | null): Workbook | string {
  if (locale !== null && !(SHEET_LOCALES as readonly string[]).includes(locale)) {
    return `"${locale}" is not one of ${SHEET_LOCALES.join(', ')}`
  }
  if ((workbook.locale ?? null) === locale) return workbook
  const { locale: _l, ...rest } = workbook
  return locale === null ? rest : { ...rest, locale: locale as SheetLocale }
}

export function setTimeZone(workbook: Workbook, timeZone: string | null): Workbook | string {
  if (timeZone !== null && !isTimeZone(timeZone)) return `"${timeZone}" is not an IANA time zone like "Europe/London"`
  if ((workbook.timeZone ?? null) === timeZone) return workbook
  const { timeZone: _t, ...rest } = workbook
  return timeZone === null ? rest : { ...rest, timeZone }
}

/** The width that fits a column's longest shown text (as a double-click on its edge does). */
export function fitColumnWidth(workbook: Workbook, engine: SheetEngine, tabId: string, col: number): number {
  const tab = tabById(workbook, tabId)
  if (!tab) return MIN_COL_WIDTH
  const letters = colName(col)
  let longest = letters.length
  for (const [address, cell] of Object.entries(tab.cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(address)
    if (!match || match[1] !== letters) continue
    const text = formatValue(engine.value(tab.id, Number(match[2]) - 1, col), cell.fmt, { ...cell, locale: workbook.locale })
    const scale = (cell.size ?? 12) / 12
    longest = Math.max(longest, (text.length + (cell.bold ? 1 : 0)) * scale)
  }
  return Math.max(48, Math.min(Math.min(480, MAX_COL_WIDTH), Math.round(longest * 7.4 + 22)))
}
