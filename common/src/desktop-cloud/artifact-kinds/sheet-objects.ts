/**
 * Freebuff Sheets — a tab's side objects as pure edits: merges, declared tables, the filter
 * range, conditional rules, validations (checkbox and dropdown cells), plus find and replace.
 * Every function returns its input unchanged when there is nothing to do.
 */

import { parseRange, rectToRange, toAddress, type CellRect } from './sheet-address'
import { applyInput, editText, formatValue } from './sheet-format'
import { setCells } from './sheet-ops'
import { rewriteFormula, type SheetEngine } from './sheet-formula'
import {
  definedNameProblem,
  SHEET_LIMITS,
  tabCols,
  tabRows,
  type SheetCell,
  type SheetName,
  type SheetRule,
  type SheetTab,
  type SheetTable,
  type SheetValidation,
  type Workbook,
} from './sheet'

const overlaps = (a: CellRect, b: CellRect) => a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right
const contains = (outer: CellRect, inner: CellRect) =>
  inner.top >= outer.top && inner.bottom <= outer.bottom && inner.left >= outer.left && inner.right <= outer.right
const blockRange = (rect: CellRect) =>
  `${toAddress({ row: rect.top, col: rect.left })}:${toAddress({ row: rect.bottom, col: rect.right })}`

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

function withList<K extends 'merges' | 'tables' | 'rules' | 'validations'>(tab: SheetTab, key: K, list: SheetTab[K]): SheetTab {
  const { [key]: _old, ...rest } = tab
  return (list && (list as unknown[]).length ? { ...rest, [key]: list } : rest) as unknown as SheetTab
}

function freshId(ids: string[], base: string): string {
  const taken = new Set(ids)
  for (let n = ids.length + 1; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

const clampRect = (tab: SheetTab, rect: CellRect): CellRect => ({
  top: Math.max(0, rect.top),
  left: Math.max(0, rect.left),
  bottom: Math.min(tabRows(tab) - 1, rect.bottom),
  right: Math.min(tabCols(tab) - 1, rect.right),
})

// ---- merges

/**
 * Merge a block: merges it overlaps are replaced, and only the top-left cell keeps its content
 * (the others are cleared, as Sheets does after asking). A single cell is no merge.
 */
export function mergeCells(workbook: Workbook, tabId: string, rect: CellRect): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab) return workbook
  const r = clampRect(tab, rect)
  if (r.top === r.bottom && r.left === r.right) return workbook
  if ((r.bottom - r.top + 1) * (r.right - r.left + 1) > 100_000) return workbook
  const kept = (tab.merges ?? []).filter((range) => {
    const m = parseRange(range)
    return m && !overlaps(m, r)
  })
  if (kept.length >= SHEET_LIMITS.merges) return workbook
  const updates = new Map<string, SheetCell | undefined>()
  for (const address of Object.keys(tab.cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(address)
    if (!m) continue
    let col = 0
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
    col -= 1
    const row = Number(m[2]) - 1
    if (row < r.top || row > r.bottom || col < r.left || col > r.right || (row === r.top && col === r.left)) continue
    updates.set(address, undefined)
  }
  const cleared = setCells(workbook, tabId, updates)
  return replaceTab(cleared, tabId, (t) => withList(t, 'merges', [...kept, blockRange(r)]))
}

/** Undo every merge that overlaps `rect`. */
export function unmergeCells(workbook: Workbook, tabId: string, rect: CellRect): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    if (!tab.merges?.length) return tab
    const kept = tab.merges.filter((range) => {
      const m = parseRange(range)
      return m && !overlaps(m, rect)
    })
    return kept.length === tab.merges.length ? tab : withList(tab, 'merges', kept)
  })
}

export function mergesIn(tab: SheetTab, rect: CellRect): boolean {
  return (tab.merges ?? []).some((range) => {
    const m = parseRange(range)
    return m !== null && overlaps(m, rect)
  })
}

// ---- tables and the filter

/** Declare a table over a block (two rows at least). Refused where it would overlap another. */
export function addTable(
  workbook: Workbook,
  tabId: string,
  rect: CellRect,
  options: Omit<SheetTable, 'id' | 'range'> = {},
): { workbook: Workbook; tableId: string | null } {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab) return { workbook, tableId: null }
  const r = clampRect(tab, rect)
  const tables = tab.tables ?? []
  if (r.bottom <= r.top || tables.length >= SHEET_LIMITS.tables) return { workbook, tableId: null }
  if (tables.some((t) => overlaps(parseRange(t.range)!, r))) return { workbook, tableId: null }
  const tableId = freshId(tables.map((t) => t.id), 'table')
  const table: SheetTable = { id: tableId, range: blockRange(r), ...options }
  return { workbook: replaceTab(workbook, tabId, (t) => withList(t, 'tables', [...tables, table])), tableId }
}

export function removeTable(workbook: Workbook, tabId: string, tableId: string): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    const tables = (tab.tables ?? []).filter((t) => t.id !== tableId)
    return tables.length === (tab.tables?.length ?? 0) ? tab : withList(tab, 'tables', tables)
  })
}

export function tableAt(tab: SheetTab, row: number, col: number): SheetTable | undefined {
  return tab.tables?.find((t) => {
    const r = parseRange(t.range)
    return r !== null && row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
  })
}

/** Put the filter row on a block (its first row), or take it off with `null`. */
export function setFilterRange(workbook: Workbook, tabId: string, rect: CellRect | null): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    if (rect === null) {
      if (!tab.filter) return tab
      const { filter: _f, ...rest } = tab
      return rest
    }
    const range = blockRange(clampRect(tab, rect))
    return tab.filter?.range === range ? tab : { ...tab, filter: { range } }
  })
}

// ---- conditional rules

export function addRule(workbook: Workbook, tabId: string, rule: Omit<SheetRule, 'id'>): { workbook: Workbook; ruleId: string | null } {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab || (tab.rules?.length ?? 0) >= SHEET_LIMITS.rules || !parseRange(rule.range)) return { workbook, ruleId: null }
  const ruleId = freshId((tab.rules ?? []).map((r) => r.id), 'rule')
  return { workbook: replaceTab(workbook, tabId, (t) => withList(t, 'rules', [...(t.rules ?? []), { ...rule, id: ruleId }])), ruleId }
}

export function removeRule(workbook: Workbook, tabId: string, ruleId: string): Workbook {
  return replaceTab(workbook, tabId, (tab) => {
    const rules = (tab.rules ?? []).filter((r) => r.id !== ruleId)
    return rules.length === (tab.rules?.length ?? 0) ? tab : withList(tab, 'rules', rules)
  })
}

/** Rules that touch a block. */
export function rulesIn(tab: SheetTab, rect: CellRect): SheetRule[] {
  return (tab.rules ?? []).filter((r) => {
    const range = parseRange(r.range)
    return range !== null && overlaps(range, rect)
  })
}

// ---- validations

/**
 * Give a block a checkbox or dropdown (or none, with `null`). Validations wholly inside the block
 * are replaced. New checkboxes start unticked (FALSE) where the cell is empty.
 */
/** A validation without its range (the rect gives it). */
export type SheetValidationInput = SheetValidation extends infer V ? (V extends SheetValidation ? Omit<V, 'range'> : never) : never

export function setValidation(
  workbook: Workbook,
  tabId: string,
  rect: CellRect,
  validation: SheetValidationInput | null,
): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  if (!tab) return workbook
  const r = clampRect(tab, rect)
  const kept = (tab.validations ?? []).filter((v) => {
    const range = parseRange(v.range)
    return range && !contains(r, range)
  })
  if (validation === null && kept.length === (tab.validations?.length ?? 0)) return workbook
  const list = validation === null ? kept : [...kept, { ...validation, range: rectToRange(r) } as SheetValidation]
  if (list.length > SHEET_LIMITS.validations) return workbook
  let next = replaceTab(workbook, tabId, (t) => withList(t, 'validations', list))
  if (validation?.kind === 'checkbox' && (r.bottom - r.top + 1) * (r.right - r.left + 1) <= 5_000) {
    const updates = new Map<string, SheetCell | undefined>()
    for (let row = r.top; row <= r.bottom; row += 1) {
      for (let col = r.left; col <= r.right; col += 1) {
        const address = toAddress({ row, col })
        const cell = tab.cells[address]
        if (cell?.v === undefined && cell?.f === undefined) updates.set(address, { ...(cell ?? {}), v: false })
      }
    }
    next = setCells(next, tabId, updates)
  }
  return next
}

/** Tick or untick a checkbox cell (a formula there is left alone). */
export function toggleCheckbox(workbook: Workbook, tabId: string, row: number, col: number): Workbook {
  const tab = workbook.tabs.find((t) => t.id === tabId)
  const address = toAddress({ row, col })
  const cell = tab?.cells[address]
  if (!tab || cell?.f !== undefined) return workbook
  return setCells(workbook, tabId, new Map([[address, { ...(cell ?? {}), v: cell?.v !== true }]]))
}

// ---- find and replace

export type FindOptions = {
  query: string
  matchCase?: boolean
  /** The whole shown value (or formula) must equal the query. */
  wholeCell?: boolean
  /** Search formulas' text rather than what they show. */
  inFormulas?: boolean
  /** One tab, or every tab. */
  tabId?: string
}

export type FindMatch = { tabId: string; row: number; col: number }

function searchable(cell: SheetCell, engine: SheetEngine, tabId: string, row: number, col: number, options: FindOptions): string {
  if (options.inFormulas && cell.f !== undefined) return cell.f
  return formatValue(engine.value(tabId, row, col), cell.fmt, cell)
}

function matcher(options: FindOptions): ((text: string) => boolean) | null {
  if (!options.query) return null
  const query = options.matchCase ? options.query : options.query.toLowerCase()
  return (text) => {
    const t = options.matchCase ? text : text.toLowerCase()
    return options.wholeCell ? t === query : t.includes(query)
  }
}

/** Every matching filled cell, tab by tab in order, then row by row. Most 5,000. */
export function findMatches(workbook: Workbook, engine: SheetEngine, options: FindOptions): FindMatch[] {
  const test = matcher(options)
  if (!test) return []
  const out: FindMatch[] = []
  for (const tab of workbook.tabs) {
    if (options.tabId && tab.id !== options.tabId) continue
    const found: FindMatch[] = []
    for (const [address, cell] of Object.entries(tab.cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(address)
      if (!m) continue
      let col = 0
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
      const pos = { row: Number(m[2]) - 1, col: col - 1 }
      if (test(searchable(cell, engine, tab.id, pos.row, pos.col, options))) found.push({ tabId: tab.id, ...pos })
    }
    found.sort((a, b) => a.row - b.row || a.col - b.col)
    out.push(...found)
    if (out.length >= 5_000) return out.slice(0, 5_000)
  }
  return out
}

function replaceText(text: string, options: FindOptions, replacement: string): string {
  if (options.wholeCell) return replacement
  const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, options.matchCase ? 'g' : 'gi'), () => replacement)
}

/**
 * Replace in the given matches (from `findMatches`). Literal cells are edited as typed (so
 * "10" → "12" stays a number); formulas change only when searching inside formulas.
 * Returns how many cells changed.
 */
export function replaceMatches(
  workbook: Workbook,
  matches: FindMatch[],
  options: FindOptions,
  replacement: string,
): { workbook: Workbook; count: number } {
  let next = workbook
  let count = 0
  const byTab = new Map<string, FindMatch[]>()
  for (const match of matches) byTab.set(match.tabId, [...(byTab.get(match.tabId) ?? []), match])
  for (const [tabId, list] of byTab) {
    const tab = next.tabs.find((t) => t.id === tabId)
    if (!tab) continue
    const updates = new Map<string, SheetCell | undefined>()
    for (const { row, col } of list) {
      const address = toAddress({ row, col })
      const cell = tab.cells[address]
      if (!cell) continue
      if (cell.f !== undefined) {
        if (!options.inFormulas) continue
        const f = replaceText(cell.f, options, replacement)
        if (f !== cell.f && f.startsWith('=')) updates.set(address, { ...cell, f })
        continue
      }
      const text = editText(cell)
      const replaced = replaceText(text, options, replacement)
      if (replaced !== text) updates.set(address, applyInput(cell, replaced))
    }
    const before = next
    next = setCells(next, tabId, updates)
    if (next !== before) count += updates.size
  }
  return { workbook: next, count }
}

// ---- defined names (named ranges)

/** The defined name, ignoring case. */
export function nameDef(workbook: Workbook, name: string): SheetName | undefined {
  const key = name.trim().toLowerCase()
  return workbook.names?.find((def) => def.name.toLowerCase() === key)
}

/**
 * Define (or redefine) a name for a range on one tab. `replacing` is the name
 * being edited, so a rename keeps its place in the list. Formulas that used the
 * old spelling are rewritten to the new one.
 */
export function defineName(
  workbook: Workbook,
  def: { name: string; tab: string; rect: CellRect; comment?: string },
  replacing?: string,
): { workbook: Workbook; error: null } | { workbook: Workbook; error: string } {
  const name = def.name.trim()
  const problem = definedNameProblem(name)
  if (problem) return { workbook, error: problem }
  const tab = workbook.tabs.find((t) => t.id === def.tab)
  if (!tab) return { workbook, error: 'no such tab' }
  if (def.rect.bottom >= tabRows(tab) || def.rect.right >= tabCols(tab)) return { workbook, error: 'that range is outside the tab' }
  const list = workbook.names ?? []
  const oldKey = replacing?.trim().toLowerCase()
  const clash = list.find((d) => d.name.toLowerCase() === name.toLowerCase() && d.name.toLowerCase() !== oldKey)
  if (clash) return { workbook, error: `"${clash.name}" is already defined` }
  if (!oldKey && list.length >= SHEET_LIMITS.names) return { workbook, error: `a workbook has at most ${SHEET_LIMITS.names} names` }
  const single = def.rect.top === def.rect.bottom && def.rect.left === def.rect.right
  const range = single ? toAddress({ row: def.rect.top, col: def.rect.left }) : rectToRange(def.rect)
  const next: SheetName = { name, tab: tab.id, range, ...(def.comment?.trim() ? { comment: def.comment.trim().slice(0, 200) } : {}) }
  const index = oldKey ? list.findIndex((d) => d.name.toLowerCase() === oldKey) : -1
  const names = index === -1 ? [...list, next] : list.map((d, i) => (i === index ? next : d))
  let result: Workbook = { ...workbook, names }
  const oldName = index === -1 ? null : list[index].name
  if (oldName && oldName.toLowerCase() !== name.toLowerCase()) result = renameNameInFormulas(result, oldName, name)
  return { workbook: result, error: null }
}

export function deleteName(workbook: Workbook, name: string): Workbook {
  const key = name.trim().toLowerCase()
  const list = workbook.names ?? []
  const names = list.filter((d) => d.name.toLowerCase() !== key)
  if (names.length === list.length) return workbook
  const { names: _old, ...rest } = workbook
  return names.length ? { ...rest, names } : rest
}

/** Point every formula's use of name `from` at `to`. */
function renameNameInFormulas(workbook: Workbook, from: string, to: string): Workbook {
  const key = from.toLowerCase()
  const tabs = workbook.tabs.map((tab) => {
    let cells: SheetTab['cells'] | null = null
    for (const [address, cell] of Object.entries(tab.cells)) {
      if (!cell.f || !cell.f.toLowerCase().includes(key)) continue
      const f = rewriteFormula(cell.f, (token) => (token.t === 'name' && token.name.toLowerCase() === key ? to : undefined))
      if (f === cell.f) continue
      cells ??= { ...tab.cells }
      cells[address] = { ...cell, f }
    }
    return cells ? { ...tab, cells } : tab
  })
  return { ...workbook, tabs }
}
