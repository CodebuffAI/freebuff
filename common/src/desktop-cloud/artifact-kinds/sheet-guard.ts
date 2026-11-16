/**
 * Freebuff Sheets — the two rules an edit must pass, checked the same way by the
 * page (`apply`) and the agent's sheet ops, by comparing the workbook before and
 * after the edit:
 *
 * - PROTECTED RANGES (`tab.protected`): their cells may not change, and only the
 *   owner may add, remove, resize or move a protection. The owner inserting rows
 *   or columns before a protected range just moves it; a non-owner may not (a
 *   moved protection could sit on copies while the originals change). Inserting
 *   inside, deleting through it, or sorting over it changes its cells and is
 *   refused for everyone. See `protectionRefusal` for the full non-owner rule.
 * - VALIDATIONS in `reject` mode: a typed value (not a formula) that breaks the
 *   rule is refused. `warn` mode keeps it; `validationIssue` marks the cell.
 */

import { parseAddress, parseRange, rectToRange, toAddress, type CellRect } from './sheet-address'
import { isError, literalValue, shiftFormula, tryParseFormula, type CellValue, type FormulaNode, type SheetEngine } from './sheet-formula'
import { isoToSerial } from './sheet-formula'
import type { SheetCell, SheetProtected, SheetTab, SheetValidation, Workbook } from './sheet'

const sameValue = (a: SheetCell | undefined, b: SheetCell | undefined) =>
  (a?.v ?? null) === (b?.v ?? null) && (a?.f === undefined) === (b?.f === undefined)

/** Same cell content, formatting included (a protected cell keeps its look too). */
function sameCell(a: SheetCell | undefined, b: SheetCell | undefined): boolean {
  if (a === b) return true
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

const sizeOf = (r: CellRect) => ({ rows: r.bottom - r.top + 1, cols: r.right - r.left + 1 })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function describe(tab: SheetTab, item: SheetProtected): string {
  return `${tab.name}!${item.range} is protected${item.note ? ` (${item.note})` : ''}`
}

/**
 * The addresses inside `rect` worth comparing between `a` and `b`: every filled key of either
 * that falls inside it. Walks the sparse cell maps, not the rect's area (a whole-tab protection
 * is millions of addresses), unless the area is the smaller of the two.
 */
function addressesIn(rect: CellRect, ...maps: Array<Record<string, SheetCell>>): string[] {
  const area = (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1)
  const filled = maps.reduce((n, cells) => n + Object.keys(cells).length, 0)
  if (area <= filled) {
    const all: string[] = []
    for (let row = rect.top; row <= rect.bottom; row += 1)
      for (let col = rect.left; col <= rect.right; col += 1) all.push(toAddress({ row, col }))
    return all
  }
  const keys = new Set<string>()
  for (const cells of maps)
    for (const key of Object.keys(cells)) {
      const pos = parseAddress(key)
      if (pos && pos.row >= rect.top && pos.row <= rect.bottom && pos.col >= rect.left && pos.col <= rect.right) keys.add(key)
    }
  return [...keys]
}

/**
 * Why `next` breaks a protection of `prev`, or null.
 *
 * - A non-owner (an editor, a link editor, any agent) changes no protection at all: each live
 *   tab's `protected` list, and every trashed tab that holds one, stays exactly as it was (so a
 *   protection is never added, removed, resized, re-noted, MOVED by an insert before it, or
 *   duplicated under an existing id), no protected cell changes, and every tab name and defined
 *   name a protected formula reads still resolves to the same tab or range.
 * - The owner may add, remove, resize or move protections, but never change a protected cell
 *   while its protection stands. Protections are matched as a list, never by first id, so a
 *   sheet that already holds a duplicate id does not lock the owner out.
 */
export function protectionRefusal(prev: Workbook, next: Workbook, options: { owner: boolean }): string | null {
  return options.owner ? ownerRefusal(prev, next) : editorRefusal(prev, next)
}

function ownerRefusal(prev: Workbook, next: Workbook): string | null {
  for (const before of prev.tabs) {
    const protections = before.protected ?? []
    if (!protections.length) continue
    const after = next.tabs.find((t) => t.id === before.id)
    if (!after) continue
    const now = after.protected ?? []
    // Exact (id and range) matches first, then the same id moved or resized; each used once.
    const taken = new Set<number>()
    const matched = new Map<number, SheetProtected>()
    const claim = (test: (p: SheetProtected) => boolean, i: number) => {
      const j = now.findIndex((p, k) => !taken.has(k) && test(p))
      if (j === -1) return
      taken.add(j)
      matched.set(i, now[j]!)
    }
    protections.forEach((item, i) => claim((p) => p.id === item.id && p.range === item.range, i))
    protections.forEach((item, i) => matched.has(i) || claim((p) => p.id === item.id, i))
    for (const [i, item] of protections.entries()) {
      const moved = matched.get(i)
      const rect = parseRange(item.range)
      if (!moved || !rect) continue
      const target = parseRange(moved.range)
      if (!target) continue
      const a = sizeOf(rect)
      const b = sizeOf(target)
      if (a.rows !== b.rows || a.cols !== b.cols) {
        if (target.top === rect.top && target.left === rect.left) continue
        return `${describe(before, item)}; rows and columns cannot be inserted or deleted inside it`
      }
      const dRow = target.top - rect.top
      const dCol = target.left - rect.left
      if (!dRow && !dCol) {
        for (const address of addressesIn(rect, before.cells, after.cells))
          if (!sameCell(before.cells[address], after.cells[address])) return describe(before, item)
        continue
      }
      // A moved block's formulas are rewritten by the move itself, so compare what they hold.
      const keys = new Set(addressesIn(rect, before.cells))
      for (const address of addressesIn(target, after.cells)) {
        const pos = parseAddress(address)
        if (pos) keys.add(toAddress({ row: pos.row - dRow, col: pos.col - dCol }))
      }
      for (const address of keys) {
        const pos = parseAddress(address)!
        if (!sameValue(before.cells[address], after.cells[toAddress({ row: pos.row + dRow, col: pos.col + dCol })]))
          return describe(before, item)
      }
    }
  }
  return null
}

function editorRefusal(prev: Workbook, next: Workbook): string | null {
  if (!hasProtection(prev) && !hasProtection(next)) return null
  const ids = new Set<string>()
  for (const tab of next.tabs) {
    if (ids.has(tab.id)) return `two tabs share the id "${tab.id}"; only the owner can do that while the sheet has protected ranges`
    ids.add(tab.id)
  }
  for (const before of prev.tabs) {
    const protections = before.protected ?? []
    const after = next.tabs.find((t) => t.id === before.id)
    if (!after) {
      if (protections.length) return `${before.name} holds protected ranges; only the owner can delete it`
      continue
    }
    const now = after.protected ?? []
    if (!same(protections, now)) return protectionChange(before, after, protections, now)
    for (const item of protections) {
      const rect = parseRange(item.range)
      if (!rect) continue
      for (const address of addressesIn(rect, before.cells, after.cells))
        if (!sameCell(before.cells[address], after.cells[address])) return describe(before, item)
    }
    const overlay = overlayRefusal(before, after, protections)
    if (overlay) return overlay
  }
  return trashRefusal(prev, next) ?? referenceRefusal(prev, next)
}

/**
 * Conditional-format rules, tables and data validations are stored beside the cells but restyle
 * them (a rule's fill, a table's header band and banding, a validation's checkbox or dropdown and
 * what it lets be typed there), so for a non-owner they count as the protected cells' FORMAT:
 * what each rule, table or validation does INSIDE a protected range stays exactly as it was
 * (none added, removed or changed there, none moved onto or off it), compared as a list. Only the
 * part inside counts: a rule or table that also reaches past the range may grow, shrink or shift
 * out there (a row inserted below the protection stretches a column-wide rule), and ones clear of
 * every protection change freely. Row heights, hidden rows and columns, column widths, freeze and
 * gridlines are view state that leaves every stored cell as it was, and stay allowed.
 */
function overlayRefusal(before: SheetTab, after: SheetTab, protections: SheetProtected[]): string | null {
  if (!protections.length) return null
  const rects = protections.map((item) => ({ item, rect: parseRange(item.range) }))
  /** The entry as the protected cells see it (its range cut to each protection), or null when clear of all. */
  const inside = (entry: { range: string }) => {
    const rect = parseRange(entry.range)
    const parts = rects.map(({ rect: p }) => {
      // An unreadable range cannot be shown clear of a protection: it counts as over all of it.
      if (!rect || !p) return entry.range
      const cut = { top: Math.max(rect.top, p.top), bottom: Math.min(rect.bottom, p.bottom), left: Math.max(rect.left, p.left), right: Math.min(rect.right, p.right) }
      return cut.top <= cut.bottom && cut.left <= cut.right ? rectToRange(cut) : null
    })
    const first = parts.findIndex((part) => part !== null)
    if (first === -1) return null
    const { range: _range, ...rest } = entry
    return { item: rects[first]!.item, text: JSON.stringify({ ...rest, inside: parts }) }
  }
  for (const [key, label] of [
    ['rules', 'conditional formatting'],
    ['tables', 'a table'],
    ['validations', 'a data validation'],
  ] as const) {
    const over = (tab: SheetTab) =>
      ((tab[key] ?? []) as Array<{ range: string }>).flatMap((entry) => {
        const seen = inside(entry)
        return seen ? [seen] : []
      })
    const was = over(before)
    const now = over(after)
    const left = now.map((entry) => entry.text)
    for (const entry of was) {
      const index = left.indexOf(entry.text)
      if (index === -1) return `${describe(before, entry.item)}; only the owner can change or remove ${label} over it`
      left.splice(index, 1)
    }
    if (left.length) return `${describe(before, now.find((entry) => entry.text === left[0])!.item)}; only the owner can add ${label} over it`
  }
  return null
}

/** What a non-owner did to a tab's protection list, as the refusal. */
function protectionChange(before: SheetTab, after: SheetTab, was: SheetProtected[], now: SheetProtected[]): string {
  const left = [...now]
  for (const item of was) {
    const exact = left.findIndex((p) => same(p, item))
    if (exact !== -1) {
      left.splice(exact, 1)
      continue
    }
    const index = left.findIndex((p) => p.id === item.id)
    if (index === -1) return `${describe(before, item)}; only the owner can remove it`
    const moved = left[index]!
    if (moved.range === item.range) return `only the owner can change the protection of ${before.name}!${item.range}`
    const a = parseRange(item.range)
    const b = parseRange(moved.range)
    if (a && b && (sizeOf(a).rows !== sizeOf(b).rows || sizeOf(a).cols !== sizeOf(b).cols))
      return `${describe(before, item)}; rows and columns cannot be inserted or deleted inside it`
    return `${describe(before, item)}; only the owner can insert or delete rows or columns before it, or move it`
  }
  if (left.length) return `only the owner can protect ${after.name}!${left[0]!.range}`
  return `only the owner can reorder the protections of ${before.name}`
}

/**
 * The tab trash (`deletedTabs`) and new tabs, for a non-owner: a tab that was not live before
 * (restored, duplicated or written in) may carry no protection, and the trashed tabs holding
 * protections stay in the trash exactly as they are (not edited, purged, restored, duplicated
 * or joined by another), compared as a list (never by first id), so deleting and restoring a
 * tab is never a way around its protections.
 */
function trashRefusal(prev: Workbook, next: Workbook): string | null {
  const live = new Set(prev.tabs.map((tab) => tab.id))
  for (const tab of next.tabs) {
    if (live.has(tab.id) || !tab.protected?.length) continue
    const trashed = (prev.deletedTabs ?? []).some((entry) => entry.tab.id === tab.id)
    return trashed
      ? `${tab.name} holds protected ranges; only the owner can restore it`
      : `only the owner can protect ${tab.name}!${tab.protected[0]!.range}`
  }
  const guarded = (workbook: Workbook) => (workbook.deletedTabs ?? []).filter((entry) => entry.tab.protected?.length)
  const left = guarded(next).map((entry) => JSON.stringify(entry))
  for (const entry of guarded(prev)) {
    const index = left.indexOf(JSON.stringify(entry))
    if (index === -1) return `the deleted tab ${entry.tab.name} holds protected ranges; only the owner can change or empty it`
    left.splice(index, 1)
  }
  if (left.length) {
    const extra = JSON.parse(left[0]!) as { tab: SheetTab }
    return `only the owner can protect ${extra.tab.name}!${extra.tab.protected![0]!.range}`
  }
  return null
}

/** The tab names (by their lower-case key) and defined names a formula reads. */
export function formulaReferences(formula: string): { tabs: Map<string, string>; names: Map<string, string> } {
  const tabs = new Map<string, string>()
  const names = new Map<string, string>()
  const ast = tryParseFormula(formula)
  const stack: FormulaNode[] = ast ? [ast] : []
  while (stack.length) {
    const node = stack.pop()!
    switch (node.k) {
      case 'ref':
      case 'spill':
      case 'range':
        if (node.sheet !== undefined) tabs.set(node.sheet.toLowerCase(), node.sheet)
        break
      case 'name':
        names.set(node.name.toLowerCase(), node.name)
        break
      case 'call':
        stack.push(...node.args)
        break
      case 'neg':
      case 'pct':
        stack.push(node.a)
        break
      case 'bin':
        stack.push(node.a, node.b)
        break
      default:
        break
    }
  }
  return { tabs, names }
}

/**
 * For a non-owner: every tab name and defined name a protected formula (on a live tab) reads
 * resolves to the same tab id, or the same tab and range, after the write as before, resolved
 * the way the formula engine does (case-insensitively). So a protected `=Budget!A1` cannot be
 * pointed at an impostor tab named Budget, nor `=SUM(Revenue)` at another range. Values in the
 * precedent cells may still change; the references themselves may not.
 */
function referenceRefusal(prev: Workbook, next: Workbook): string | null {
  // Resolution reads only tab names and the names list: when neither changed (most edits),
  // nothing a protected formula reads can resolve elsewhere, so skip parsing them.
  const keys = (workbook: Workbook) => workbook.tabs.map((t) => `${t.id}\u0000${t.name.toLowerCase()}`).sort().join('\u0001')
  if (keys(prev) === keys(next) && same(prev.names ?? [], next.names ?? [])) return null
  const tabs = new Map<string, { name: string; on: string }>()
  const names = new Map<string, { name: string; on: string }>()
  for (const tab of prev.tabs) {
    for (const item of tab.protected ?? []) {
      const rect = parseRange(item.range)
      if (!rect) continue
      for (const address of addressesIn(rect, tab.cells)) {
        const formula = tab.cells[address]?.f
        if (!formula) continue
        const refs = formulaReferences(formula)
        for (const [key, name] of refs.tabs) if (!tabs.has(key)) tabs.set(key, { name, on: `${tab.name}!${address}` })
        for (const [key, name] of refs.names) if (!names.has(key)) names.set(key, { name, on: `${tab.name}!${address}` })
      }
    }
  }
  const tabId = (workbook: Workbook, key: string) => workbook.tabs.find((t) => t.name.toLowerCase() === key)?.id ?? null
  for (const [key, ref] of tabs) {
    if (tabId(prev, key) !== tabId(next, key))
      return `the protected formula in ${ref.on} reads the tab "${ref.name}"; only the owner can rename, add or delete a tab of that name`
  }
  const target = (workbook: Workbook, key: string) => {
    const def = (workbook.names ?? []).find((d) => d.name.toLowerCase() === key)
    return def && workbook.tabs.some((t) => t.id === def.tab) ? `${def.tab}!${def.range}` : null
  }
  for (const [key, ref] of names) {
    if (target(prev, key) !== target(next, key))
      return `the protected formula in ${ref.on} reads the name "${ref.name}"; only the owner can define, change, rename or delete it`
  }
  return null
}

/** Whether a workbook holds any protection, on a live tab or in the trash. */
export function hasProtection(workbook: Workbook): boolean {
  return (
    workbook.tabs.some((tab) => tab.protected?.length) ||
    (workbook.deletedTabs ?? []).some((entry) => entry.tab.protected?.length)
  )
}

// ---- validation

const ruleText = (v: SheetValidation): string => {
  switch (v.kind) {
    case 'number': {
      const what = v.integer ? 'a whole number' : 'a number'
      if (v.min !== undefined && v.max !== undefined) return `${what} from ${v.min} to ${v.max}`
      if (v.min !== undefined) return `${what} of at least ${v.min}`
      if (v.max !== undefined) return `${what} of at most ${v.max}`
      return what
    }
    case 'date':
      if (v.from && v.to) return `a date from ${v.from} to ${v.to}`
      if (v.from) return `a date on or after ${v.from}`
      if (v.to) return `a date on or before ${v.to}`
      return 'a date'
    case 'list':
      return `one of ${v.options.slice(0, 6).map((o) => o.value).join(', ')}${v.options.length > 6 ? ', …' : ''}`
    case 'custom':
      return `a value for which ${v.formula} is TRUE`
    case 'checkbox':
      return 'TRUE or FALSE'
  }
}

/**
 * Whether `value` (typed at row/col) breaks `validation`; blanks never do.
 * Custom rules need the engine (`evaluate` with the entry laid over the cell).
 */
export function breaksRule(
  validation: SheetValidation,
  value: CellValue,
  at: { tabId: string; row: number; col: number },
  engine: SheetEngine | null,
): boolean {
  if (value === null || value === '') return false
  switch (validation.kind) {
    case 'checkbox':
      return false
    case 'number':
      if (typeof value !== 'number') return true
      if (validation.integer && !Number.isInteger(value)) return true
      if (validation.min !== undefined && value < validation.min) return true
      return validation.max !== undefined && value > validation.max
    case 'date': {
      const serial = typeof value === 'number' ? value : typeof value === 'string' ? isoToSerial(value) : null
      if (serial === null) return true
      const from = validation.from ? isoToSerial(validation.from) : null
      const to = validation.to ? isoToSerial(validation.to) : null
      return (from !== null && serial < from) || (to !== null && Math.floor(serial) > to)
    }
    case 'list': {
      if (!validation.mode) return false
      const text = String(value).toLowerCase()
      return !validation.options.some((o) => o.value.toLowerCase() === text)
    }
    case 'custom': {
      if (!engine) return false
      const origin = parseRange(validation.range)
      if (!origin) return false
      const formula = shiftFormula(validation.formula, at.row - origin.top, at.col - origin.left)
      const result = engine.evaluate(at.tabId, formula, { row: at.row, col: at.col, value })
      return isError(result) || result !== true
    }
  }
}

export type ValidationIssue = { message: string; mode: 'reject' | 'warn' }

/** The rule a cell's current content breaks (for warn marks), or null. */
export function validationIssue(
  tab: SheetTab,
  validation: SheetValidation,
  row: number,
  col: number,
  value: CellValue,
  engine: SheetEngine | null,
): ValidationIssue | null {
  if (validation.kind === 'checkbox' || (validation.kind === 'list' && !validation.mode)) return null
  if (!breaksRule(validation, value, { tabId: tab.id, row, col }, engine)) return null
  return { message: validation.message || `Expected ${ruleText(validation)}.`, mode: validation.mode ?? 'reject' }
}

/**
 * The first typed value in `next` that a reject-mode rule refuses, as a message, or null.
 * Only cells that changed are checked; formulas are never refused. `engine` is
 * for custom rules (the engine of `prev`, with each entry laid over its cell).
 */
export function validationRefusal(prev: Workbook, next: Workbook, engine: SheetEngine | null): string | null {
  for (const tab of next.tabs) {
    const rules = (tab.validations ?? []).filter((v) => v.kind !== 'checkbox' && (v.kind !== 'list' || v.mode) && (v.mode ?? 'reject') === 'reject')
    if (!rules.length) continue
    const before = prev.tabs.find((t) => t.id === tab.id)
    if (before && before.cells === tab.cells) continue
    for (const rule of rules) {
      const rect = parseRange(rule.range)
      if (!rect) continue
      for (let row = rect.top; row <= rect.bottom; row += 1) {
        for (let col = rect.left; col <= rect.right; col += 1) {
          const address = toAddress({ row, col })
          const cell = tab.cells[address]
          if (!cell || cell.f !== undefined || cell.v === undefined) continue
          if (before && sameCell(before.cells[address], cell)) continue
          const issue = validationIssue(tab, rule, row, col, literalValue(cell), engine)
          if (issue) return `${tab.name}!${address}: ${issue.message}`
        }
      }
    }
  }
  return null
}

// ---- protection edits (owner only)

export function protectRange(workbook: Workbook, tabId: string, rect: CellRect, note?: string): Workbook {
  return {
    ...workbook,
    tabs: workbook.tabs.map((tab) => {
      if (tab.id !== tabId) return tab
      const list = tab.protected ?? []
      const ids = new Set(list.map((p) => p.id))
      let n = list.length + 1
      while (ids.has(`p${n}`)) n += 1
      const item: SheetProtected = { id: `p${n}`, range: rectToRange(rect), ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}) }
      return { ...tab, protected: [...list, item] }
    }),
  }
}

/**
 * Remove a protection by id; with `index` (its place in the tab's list) only that one, so the
 * owner can remove one of two protections that share an id (a sheet written before ids were
 * guarded) without the other.
 */
export function unprotectRange(workbook: Workbook, tabId: string, id: string, index?: number): Workbook {
  return {
    ...workbook,
    tabs: workbook.tabs.map((tab) => {
      if (tab.id !== tabId || !tab.protected?.some((p) => p.id === id)) return tab
      const one = index !== undefined && tab.protected[index]?.id === id
      const list = tab.protected.filter((p, i) => (one ? i !== index : p.id !== id))
      const { protected: _old, ...rest } = tab
      return list.length ? { ...rest, protected: list } : rest
    }),
  }
}

/** The protection a cell falls in, or undefined. */
export function protectedAt(tab: SheetTab, row: number, col: number): SheetProtected | undefined {
  return tab.protected?.find((p) => {
    const r = parseRange(p.range)
    return r !== null && row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
  })
}
