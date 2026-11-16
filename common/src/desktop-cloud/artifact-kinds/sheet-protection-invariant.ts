/**
 * Freebuff Sheets — the protection INVARIANT, checked independently of the guard that enforces
 * it (`protectionRefusal` in sheet-guard.ts), for property tests:
 *
 *   For a non-owner, any accepted write leaves (1) the stored value and formula (and format) of
 *   every protected cell, (2) the protection config (ranges, notes, ids, per tab, incl. trash)
 *   byte-identical, and (3) every tab name / defined name a protected formula references
 *   resolving to the same tab id / range, and (4) every conditional-format rule, table and data
 *   validation whose range overlaps a protected range (they restyle its cells: its format) unchanged where
 *   it covers protected cells (its other fields byte-identical, the protected cells it covers the
 *   same), none added or removed there; a range may move only by the owner. View state (row heights, hidden
 *   rows and columns, column widths, freeze, gridlines) changes no stored cell and is not covered.
 *
 * Written apart from the guard on purpose (it tokenizes formulas where the guard walks the
 * parse tree, and walks every address of a protected range where the guard walks the sparse
 * cell map), so a property test that pairs the two is not checking the guard against itself.
 */

import { parseRange, toAddress } from './sheet-address'
import { tokenize } from './sheet-formula'
import type { Workbook } from './sheet'

/** The first way `after` breaks the invariant against `before`, or null when it holds. */
export function protectionInvariantViolation(before: Workbook, after: Workbook): string | null {
  const text = (value: unknown) => JSON.stringify(value ?? null)
  const afterIds = after.tabs.map((tab) => tab.id)
  const beforeIds = new Set(before.tabs.map((tab) => tab.id))
  const anyProtection = [before, after].some(
    (wb) => wb.tabs.some((t) => (t.protected ?? []).length > 0) || (wb.deletedTabs ?? []).some((e) => (e.tab.protected ?? []).length > 0),
  )
  if (!anyProtection) return null
  if (new Set(afterIds).size !== afterIds.length) return 'duplicate live tab ids'

  // (2) per live tab, the protection list byte for byte; no new live tab carries one.
  for (const tab of before.tabs) {
    const twin = after.tabs.filter((t) => t.id === tab.id)
    if (!twin.length) {
      if ((tab.protected ?? []).length) return `protected tab ${tab.id} is gone`
      continue
    }
    if (text(tab.protected ?? []) !== text(twin[0]!.protected ?? [])) return `protections of ${tab.id} changed`
  }
  for (const tab of after.tabs) if (!beforeIds.has(tab.id) && (tab.protected ?? []).length) return `new tab ${tab.id} carries a protection`
  // ... and the trashed tabs holding one, as a sorted multiset.
  const trash = (wb: Workbook) =>
    (wb.deletedTabs ?? [])
      .filter((e) => (e.tab.protected ?? []).length)
      .map((e) => text(e))
      .sort()
  if (text(trash(before)) !== text(trash(after))) return 'protected trash changed'

  // (1) every address of every protected range holds the same cell.
  for (const tab of before.tabs) {
    const twin = after.tabs.find((t) => t.id === tab.id)
    for (const item of tab.protected ?? []) {
      const rect = parseRange(item.range)
      if (!rect || !twin) continue
      for (let row = rect.top; row <= rect.bottom; row += 1) {
        for (let col = rect.left; col <= rect.right; col += 1) {
          const address = toAddress({ row, col })
          if (text(tab.cells[address]) !== text(twin.cells[address])) return `protected cell ${tab.id}!${address} changed`
        }
      }
    }
  }

  // (3) tab names and defined names read by protected formulas resolve as before.
  const tabOf = (wb: Workbook, name: string) => {
    const hits = wb.tabs.filter((t) => t.name.toUpperCase() === name.toUpperCase())
    return hits.length === 1 ? hits[0]!.id : hits.length ? '<ambiguous>' : '<none>'
  }
  const nameOf = (wb: Workbook, name: string) => {
    const def = (wb.names ?? []).find((d) => d.name.toUpperCase() === name.toUpperCase())
    if (!def || !wb.tabs.some((t) => t.id === def.tab)) return '<none>'
    return `${def.tab}|${def.range}`
  }
  for (const tab of before.tabs) {
    for (const item of tab.protected ?? []) {
      const rect = parseRange(item.range)
      if (!rect) continue
      for (let row = rect.top; row <= rect.bottom; row += 1) {
        for (let col = rect.left; col <= rect.right; col += 1) {
          const formula = tab.cells[toAddress({ row, col })]?.f
          if (!formula) continue
          let tokens: ReturnType<typeof tokenize>
          try {
            tokens = tokenize(formula.startsWith('=') ? formula.slice(1) : formula)
          } catch {
            continue
          }
          for (const token of tokens) {
            if ((token.t === 'ref' || token.t === 'colref') && token.sheet !== undefined) {
              if (tabOf(before, token.sheet) !== tabOf(after, token.sheet)) return `tab "${token.sheet}" now resolves elsewhere`
            }
            if (token.t === 'name' && nameOf(before, token.name) !== nameOf(after, token.name)) return `name "${token.name}" now resolves elsewhere`
          }
        }
      }
    }
  }
  // (4) rules, tables and validations over a protected range, as a sorted multiset per tab: each seen through
  // the protected addresses it covers (the part outside a protection may change).
  for (const tab of before.tabs) {
    const ranges = (tab.protected ?? []).map((item) => item.range)
    if (!ranges.length) continue
    const twin = after.tabs.find((t) => t.id === tab.id)
    if (!twin) continue
    const covered = (range: string) => {
      const a = parseRange(range)
      const out: string[] = []
      for (const protectedRange of ranges) {
        const b = parseRange(protectedRange)
        if (!a || !b) {
          out.push(`${protectedRange}:?${range}`)
          continue
        }
        for (let row = b.top; row <= b.bottom; row += 1)
          for (let col = b.left; col <= b.right; col += 1)
            if (row >= a.top && row <= a.bottom && col >= a.left && col <= a.right) out.push(toAddress({ row, col }))
      }
      return out
    }
    for (const key of ['rules', 'tables', 'validations'] as const) {
      const over = (t: typeof tab) =>
        ((t[key] ?? []) as Array<{ range: string }>)
          .flatMap((entry) => {
            const cells = covered(entry.range)
            if (!cells.length) return []
            const { range: _range, ...rest } = entry
            return [text({ ...rest, cells })]
          })
          .sort()
      if (text(over(tab)) !== text(over(twin))) return `${key} over a protected range of ${tab.id} changed`
    }
  }
  return null
}

/** Whether a non-owner's write from `before` to `after` keeps the protection invariant. */
export function protectionInvariantHolds(before: Workbook, after: Workbook): boolean {
  return protectionInvariantViolation(before, after) === null
}
