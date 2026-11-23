import { describe, expect, test } from 'bun:test'

import { applySheet, rng, sheetBase, sheetScript } from './__tests__/merge-generators'
import { mergeArtifactBodies } from './artifact-merge'
import type { Workbook } from './artifact-kinds/sheet'
import { protectionRefusal } from './artifact-kinds/sheet-guard'
import { protectionInvariantViolation } from './artifact-kinds/sheet-protection-invariant'

// A merge must never produce a body the protection check would have refused. The store checks a
// non-owner's merged save against what it holds (theirs), so: when each side's own edit was a write
// a non-owner could make (the guard accepts it against base), every merged result, clean or settled
// toward either side, is accepted against theirs, and the protection invariant holds against both
// base and theirs (sheet-protection.ts: protected cells, protection config and the names their
// formulas read are unchanged).

const CASES = 400
const SEED = 0x9a7d

/** The base with a protected block on Data and a protected formula on Sum. */
function protect(base: Workbook, r: ReturnType<typeof rng>): Workbook {
  const top = 1 + r.int(2)
  return {
    ...base,
    tabs: base.tabs.map((tab) =>
      tab.id === 'data'
        ? { ...tab, protected: [{ id: 'p1', range: `A${top}:B${top + 1}`, note: 'locked' }] }
        : tab.id === 'sum'
          ? { ...tab, protected: [{ id: 'p1', range: 'A1:A2' }] }
          : tab,
    ),
  }
}

const accepted = (before: Workbook, after: Workbook) => protectionRefusal(before, after, { owner: false }) === null

/**
 * Sometimes a conditional-format rule, a table or a validation on Data (over a protected range
 * they are its cells' format), at a random place, so a merge meets them too.
 */
function withOverlay(r: ReturnType<typeof rng>, workbook: Workbook, rows: number): Workbook {
  if (!r.chance(0.5)) return workbook
  const top = 1 + r.int(rows)
  const range = `${r.chance(0.5) ? 'A' : 'C'}${top}:${r.chance(0.5) ? 'B' : 'D'}${top + 1 + r.int(2)}`
  const id = r.token('o')
  return {
    ...workbook,
    tabs: workbook.tabs.map((tab) =>
      tab.id !== 'data'
        ? tab
        : r.chance(0.5)
          ? { ...tab, rules: [...(tab.rules ?? []), { id, range, type: 'gt' as const, value: r.int(9), style: { bg: 'red' as const } }] }
          : r.chance(0.5)
            ? { ...tab, tables: [...(tab.tables ?? []), { id, range }] }
            : { ...tab, validations: [...(tab.validations ?? []), { kind: 'list' as const, range, options: [{ value: id }] }] },
    ),
  }
}

describe('sheet merge × protection: merging two accepted non-owner writes stays accepted', () => {
  test(`${CASES} random cases`, () => {
    const r = rng(SEED)
    let checked = 0
    for (let c = 0; c < CASES; c += 1) {
      const what = `seed ${SEED} case ${c}`
      const shape = sheetBase(r)
      const base = protect(shape.workbook, r)
      const mine = withOverlay(r, applySheet(base, sheetScript(r, shape)), shape.rows)
      const theirs = withOverlay(r, applySheet(base, sheetScript(r, shape)), shape.rows)
      if (!accepted(base, mine) || !accepted(base, theirs)) continue
      checked += 1
      const [b, m, t] = [base, mine, theirs].map((w) => JSON.stringify(w))
      for (const resolve of [undefined, 'mine', 'theirs'] as const) {
        const result = mergeArtifactBodies('sheet', b!, m!, t!, resolve ? { resolve } : {})
        if (!result.ok) continue
        const merged = JSON.parse(result.body) as Workbook
        const label = `${what} resolve ${resolve ?? 'none'}`
        expect(protectionRefusal(theirs, merged, { owner: false }), `${label}: the store would refuse the merge`).toBeNull()
        expect(protectionInvariantViolation(base, merged), `${label}: invariant vs base`).toBeNull()
        expect(protectionInvariantViolation(theirs, merged), `${label}: invariant vs theirs`).toBeNull()
      }
    }
    // Enough accepted pairs to mean something.
    expect(checked).toBeGreaterThan(CASES / 10)
  })
})

describe('sheet merge × protection: the owner protected cells this editor changed meanwhile', () => {
  test(`${CASES} random cases`, () => {
    const r = rng(SEED + 1)
    let merged = 0
    let conflicts = 0
    for (let c = 0; c < CASES; c += 1) {
      const what = `seed ${SEED + 1} case ${c}`
      const shape = sheetBase(r)
      const base = shape.workbook
      const mine = withOverlay(r, applySheet(base, sheetScript(r, shape)), shape.rows)
      // Theirs: the owner adds (or, with a protection already there, resizes) one over Data.
      const top = 1 + r.int(shape.rows)
      const owner = applySheet(base, { edits: [] })
      const theirs: Workbook = {
        ...owner,
        tabs: owner.tabs.map((tab) =>
          tab.id === 'data' ? { ...tab, protected: [{ id: 'p1', range: `A${top}:${r.chance(0.5) ? 'C' : 'B'}${top + r.int(2)}` }] } : tab,
        ),
      }
      const [b, m, t] = [base, mine, theirs].map((w) => JSON.stringify(w))
      for (const resolve of [undefined, 'mine', 'theirs'] as const) {
        const result = mergeArtifactBodies('sheet', b!, m!, t!, resolve ? { resolve } : {})
        if (!result.ok) {
          // Only an unsettled merge may stop on the owner's new protection.
          expect(resolve, `${what}: a resolution always settles it`).toBeUndefined()
          conflicts += 1
          continue
        }
        merged += 1
        const out = JSON.parse(result.body) as Workbook
        // The editor's save of this merge goes to the store against theirs.
        expect(protectionRefusal(theirs, out, { owner: false }), `${what} resolve ${resolve ?? 'none'}`).toBeNull()
        // Every value is a unique token: one showing up twice is a row the overlay put on shifted lines.
        const values = Object.values(out.tabs.find((tab) => tab.id === 'data')?.cells ?? {}).flatMap((cell) => (typeof cell.v === 'string' ? [cell.v] : []))
        expect(new Set(values).size, `${what} resolve ${resolve ?? 'none'}: a value doubled`).toBe(values.length)
      }
    }
    expect(merged).toBeGreaterThan(0)
    // The generator really produces edits that reach the owner's new range.
    expect(conflicts).toBeGreaterThan(0)
  })
})

/** The owner's own change to the Data tab's protections: one added, p1 removed, or p1 resized. */
function ownerProtects(r: ReturnType<typeof rng>, workbook: Workbook, rows: number): Workbook {
  const roll = r.int(3)
  const top = 1 + r.int(rows)
  return {
    ...workbook,
    tabs: workbook.tabs.map((tab) => {
      if (tab.id !== 'data') return tab
      const list = tab.protected ?? []
      const next =
        roll === 0
          ? [...list, { id: 'p2', range: `C${top}:C${top + r.int(2)}` }]
          : roll === 1
            ? list.filter((p) => p.id !== 'p1')
            : list.map((p) => (p.id === 'p1' ? { ...p, range: p.range.replace(/:B(\d+)$/, (_, n: string) => `:C${Number(n) + 1}`) } : p))
      const { protected: _old, ...rest } = tab
      return next.length ? { ...rest, protected: next } : rest
    }),
  }
}

describe('sheet merge × protection: the owner is "mine" (their draft changed protections), an editor wrote meanwhile', () => {
  test(`${CASES} random cases`, () => {
    const r = rng(SEED + 2)
    let checked = 0
    let kept = 0
    for (let c = 0; c < CASES; c += 1) {
      const what = `seed ${SEED + 2} case ${c}`
      const shape = sheetBase(r)
      const base = protect(shape.workbook, r)
      const mine = ownerProtects(r, applySheet(base, sheetScript(r, shape)), shape.rows)
      const script = sheetScript(r, shape)
      const theirs = applySheet(base, script)
      // Each side's own write is one the store takes: the owner's as the owner's, theirs as an editor's.
      if (protectionRefusal(base, mine, { owner: true }) !== null || !accepted(base, theirs)) continue
      checked += 1
      const [b, m, t] = [base, mine, theirs].map((w) => JSON.stringify(w))
      for (const resolve of [undefined, 'mine', 'theirs'] as const) {
        const result = mergeArtifactBodies('sheet', b!, m!, t!, { mineIsOwner: true, ...(resolve ? { resolve } : {}) })
        if (!result.ok) continue
        const out = JSON.parse(result.body) as Workbook
        const label = `${what} resolve ${resolve ?? 'none'}`
        // The owner's save of this merge goes to the store against theirs.
        expect(protectionRefusal(theirs, out, { owner: true }), `${label}: the store would refuse the owner's merge`).toBeNull()
        // The owner's protection change stands (theirs moved no line of Data, so no remap applies).
        if (resolve !== 'theirs' && script.line?.tab !== 'data') {
          const data = (w: Workbook) => w.tabs.find((tab) => tab.id === 'data')?.protected ?? []
          expect(data(out), `${label}: the owner's protections`).toEqual(data(mine))
          kept += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(CASES / 10)
    expect(kept).toBeGreaterThan(0)
  })
})
