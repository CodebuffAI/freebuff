import { describe, expect, test } from 'bun:test'

import {
  applyDoc,
  applyKeyed,
  applySheet,
  DESIGN,
  DESIGN_FRAMES,
  docBase,
  docScript,
  docTouches,
  expectDoc,
  expectKeyed,
  expectSheet,
  frameKids,
  KEYED_SPECS,
  keyedScript,
  relativeOrder,
  rng,
  sheetBase,
  sheetScript,
  survivingValues,
  type KeyedModel,
  type KeyedSpec,
  type Side,
} from './__tests__/merge-generators'
import { mergeArtifactBodies, type ArtifactMergeResult } from './artifact-merge'
import { parseBoard } from './artifact-kinds/whiteboard'
import { parseDashboard } from './artifact-kinds/data'
import { validateDesign } from './artifact-kinds/design'
import { parseDeck } from './artifact-kinds/slides'
import { parseWorkbook } from './artifact-kinds/sheet'

import type { ArtifactKind } from './artifacts'

// Random bases and random edit scripts for both sides, per kind, checked against what the scripts
// say a merge must give. Deterministic: a failure names its seed and case.

const CASES = 250
const SEED = 0x5eed

const VALID: Record<Exclude<ArtifactKind, 'doc'>, (value: unknown) => boolean> = {
  slides: (v) => parseDeck(v).ok,
  whiteboard: (v) => parseBoard(v).ok,
  data: (v) => parseDashboard(v).ok,
  design: (v) => validateDesign(v).ok,
  sheet: (v) => parseWorkbook(v).ok,
}

const json = (value: unknown) => JSON.stringify(value)
const body = (result: ArtifactMergeResult, what: string): string => {
  if (!result.ok) throw new Error(`${what}: expected a merge, got conflicts ${result.conflicts.join(', ')}`)
  return result.body
}

function checkUnits(result: ArtifactMergeResult, what: string) {
  if (result.ok) return
  expect(result.units.length, what).toBeGreaterThan(0)
  expect(new Set(result.units.map((u) => u.key)).size, `${what}: unit keys are unique`).toBe(result.units.length)
  expect(result.conflicts, what).toEqual(result.units.map((u) => u.label))
}

/** merge(base, x, x) = x, merge(base, base, t) = t, merge(base, m, base) = m, and the result re-merged against theirs is stable. */
function checkIdempotence(kind: ArtifactKind, base: string, mine: string, theirs: string, merged: string | null, what: string) {
  expect(mergeArtifactBodies(kind, base, mine, mine), what).toEqual({ ok: true, body: mine })
  expect(mergeArtifactBodies(kind, base, base, theirs), what).toEqual({ ok: true, body: theirs })
  expect(mergeArtifactBodies(kind, base, mine, base), what).toEqual({ ok: true, body: mine })
  if (merged === null) return
  const again = mergeArtifactBodies(kind, base, merged, theirs)
  const parse = (text: string) => (kind === 'doc' ? text : JSON.parse(text))
  expect(again.ok ? parse(again.body) : again.conflicts, `${what}: re-merge`).toEqual(parse(merged))
}

describe('keyed kinds: entities edited, added, deleted and reordered on both sides', () => {
  for (const spec of KEYED_SPECS) {
    const name = spec.name ?? spec.kind
    test(`${name}: ${CASES} random cases`, () => {
      const r = rng(SEED + name.length)
      let merged = 0
      let clashed = 0
      for (let c = 0; c < CASES; c += 1) {
        const outcome = runKeyedCase(spec, r, `${name} seed ${SEED} case ${c}`)
        if (outcome === true) merged += 1
        else if (outcome === false) clashed += 1
      }
      // Both outcomes are exercised: clean merges and conflicts.
      expect(merged).toBeGreaterThan(CASES / 10)
      expect(clashed).toBeGreaterThan(CASES / 10)
    })
  }
})

/** Whether the case merged cleanly; null when it was skipped (over the kind's list cap). */
function runKeyedCase(spec: KeyedSpec, r: ReturnType<typeof rng>, what: string): boolean | null {
  const base = spec.base(r)
  const reorderer: Side | null = r.chance(0.3) ? r.pick(['mine', 'theirs'] as const) : null
  const mineModel = applyKeyed(base, keyedScript(r, spec, base, reorderer === 'mine'))
  const theirModel = applyKeyed(base, keyedScript(r, spec, base, reorderer === 'theirs'))
  const [b, m, t] = [base, mineModel, theirModel].map((model) => json(spec.render(model)))
  expect(VALID[spec.kind](JSON.parse(b!)), `${what}: base valid`).toBe(true)

  const expected = expectKeyed(base, mineModel, theirModel)
  const over = (count: number) => spec.max !== undefined && count > spec.max
  if ([mineModel, theirModel].some((model) => over(model.order.length)) || over(Object.keys(expected.ents).length)) return null
  for (const side of ['mine', 'theirs'] as const) if (over(Object.keys(expectKeyed(base, mineModel, theirModel, side).ents).length)) return null
  const orderClash = spec === DESIGN && designOrderClash(base, mineModel, theirModel)
  const result = mergeArtifactBodies(spec.kind, b!, m!, t!)
  checkUnits(result, what)
  // (ii) a unit changed differently on both sides is reported, never silently dropped.
  expect(result.ok, `${what}: conflicts ${expected.conflicts.join(', ')} ${result.ok ? '' : result.conflicts.join(', ')}`).toBe(
    expected.conflicts.length === 0 && !orderClash,
  )
  if (result.ok) {
    const out = JSON.parse(result.body)
    // (iii) the merge is a body of this kind.
    expect(VALID[spec.kind](out), `${what}: merged valid`).toBe(true)
    // (i) every unit changed on one side has that side's value; untouched units stay.
    const got = spec.extract(out)
    expect(got.ents, what).toEqual(expected.ents)
    expect(new Set(got.order), what).toEqual(new Set(Object.keys(expected.ents)))
    if (spec !== DESIGN) {
      // One side's reorder of the entities both kept is the merged order of them.
      const both = new Set(base.order.filter((id) => id in expected.ents && id in mineModel.ents && id in theirModel.ents))
      const reference = reorderer === 'mine' ? mineModel.order : theirModel.order
      expect(relativeOrder(got.order, both), `${what}: order`).toEqual(relativeOrder(reference, both))
    }
  }
  // (iv) idempotence.
  checkIdempotence(spec.kind, b!, m!, t!, result.ok ? result.body : null, what)

  // (v) Keep mine / Keep theirs: always a valid body, nothing changed on one side only is lost,
  // and each clashing unit takes the chosen side.
  for (const side of ['mine', 'theirs'] as const) {
    const settled = mergeArtifactBodies(spec.kind, b!, m!, t!, { resolve: side })
    const out = JSON.parse(body(settled, `${what} resolve ${side}`))
    expect(VALID[spec.kind](out), `${what} resolve ${side}: valid`).toBe(true)
    expect(spec.extract(out).ents, `${what} resolve ${side}`).toEqual(expectKeyed(base, mineModel, theirModel, side).ents)
  }
  return result.ok
}

/** A design frame whose child list both sides changed differently (its order is one unit). */
function designOrderClash(b: KeyedModel, m: KeyedModel, t: KeyedModel): boolean {
  return DESIGN_FRAMES.some((frame) => {
    const [bk, mk, tk] = [b, m, t].map((model) => json(frameKids(model, frame)))
    return bk !== mk && bk !== tk && mk !== tk
  })
}

describe('doc: blocks edited, deleted and inserted on both sides', () => {
  test(`${CASES} random cases`, () => {
    const r = rng(SEED)
    for (let c = 0; c < CASES; c += 1) {
      const what = `doc seed ${SEED} case ${c}`
      const base = docBase(r)
      const mine = docScript(r, base)
      const theirs = docScript(r, base)
      const join = (blocks: string[]) => `${blocks.join('\n\n')}\n`
      const [b, m, t] = [base, applyDoc(base, mine), applyDoc(base, theirs)].map(join)
      const result = mergeArtifactBodies('doc', b!, m!, t!)
      checkUnits(result, what)
      const [mt, tt] = [docTouches(mine), docTouches(theirs)]
      const near = mt.some((x) => tt.some((y) => Math.abs(x - y) < 3))
      const sameBlock = [...mine.edits.keys(), ...mine.deletes].some(
        (i) => (theirs.edits.has(i) && theirs.edits.get(i) !== mine.edits.get(i)) || (theirs.deletes.has(i) && mine.edits.has(i)),
      )
      // (ii) the same block changed differently is reported; (i) changes apart always merge.
      if (sameBlock) expect(result.ok, what).toBe(false)
      if (!near) expect(result.ok, `${what}: ${result.ok ? '' : result.conflicts.join(', ')}`).toBe(true)
      // When it merges, it is exactly both scripts applied.
      if (result.ok) {
        // Exactly both scripts applied; two insertions at one gap that each joined a neighbouring
        // hunk of their own side do not clash, and either may come first.
        const shared = [...mine.inserts.keys()].some((p) => theirs.inserts.has(p))
        const sorted = (blocks: string[]) => (shared ? [...blocks].sort() : blocks)
        expect(sorted(result.body.trim().split('\n\n')), what).toEqual(sorted(expectDoc(base, mine, theirs)))
      }
      // Re-merging under the OLD base is only stable when the two sides' changes sit apart: a
      // block hunk of the result that spans both sides' adjacent changes overlaps theirs (diff3).
      checkIdempotence('doc', b!, m!, t!, result.ok && !near ? result.body : null, what)
      // (v) settled either way: every change of one side away from the other side's survives.
      for (const side of ['mine', 'theirs'] as const) {
        const settled = body(mergeArtifactBodies('doc', b!, m!, t!, { resolve: side }), `${what} resolve ${side}`)
        const blocks = settled.trim().split('\n\n')
        for (const [script, touches, others] of [[mine, mt, tt], [theirs, tt, mt]] as const) {
          // A side's changes that touch (adjacent blocks, a block and the gap beside it) are one
          // hunk, and a clashing hunk is settled whole; so "apart" is the change's whole run.
          const run = (x: number) => {
            const sorted = [...touches].sort((p, q) => p - q)
            let [lo, hi] = [x, x]
            for (const y of sorted) if (y > hi && y - hi <= 2) hi = y
            for (const y of [...sorted].reverse()) if (y < lo && lo - y <= 2) lo = y
            return [lo, hi] as const
          }
          const apart = (x: number) => {
            const [lo, hi] = run(x)
            return others.every((y) => y <= lo - 3 || y >= hi + 3)
          }
          for (const [i, text] of script.edits) if (apart(2 * i + 1)) expect(blocks, `${what} resolve ${side}: edit`).toContain(text)
          for (const i of script.deletes) if (apart(2 * i + 1)) expect(blocks, `${what} resolve ${side}: delete`).not.toContain(base[i])
          for (const [p, texts] of script.inserts) if (apart(2 * p)) for (const text of texts) expect(blocks, `${what} resolve ${side}: insert`).toContain(text)
        }
      }
    }
  })
})

describe('sheet: cell edits, row/column inserts and deletes, tab rename and delete on both sides', () => {
  test(`${CASES} random cases`, () => {
    const r = rng(SEED + 7)
    let rebased = 0
    for (let c = 0; c < CASES; c += 1) {
      const what = `sheet seed ${SEED + 7} case ${c}`
      const base = sheetBase(r)
      const mine = sheetScript(r, base)
      const theirs = sheetScript(r, base)
      const [b, m, t] = [base.workbook, applySheet(base.workbook, mine), applySheet(base.workbook, theirs)].map(json)
      expect(VALID.sheet(JSON.parse(b!)), `${what}: base valid`).toBe(true)
      const expected = expectSheet(base.workbook, mine, theirs)
      const result = mergeArtifactBodies('sheet', b!, m!, t!)
      checkUnits(result, what)
      expect(result.ok, `${what}: expected ${expected.conflicts.join(', ') || 'a merge'}, got ${result.ok ? 'a merge' : result.conflicts.join(', ')}`).toBe(
        expected.conflicts.length === 0,
      )
      if (result.ok && expected.workbook) {
        const out = JSON.parse(result.body)
        expect(VALID.sheet(out), `${what}: merged valid`).toBe(true)
        // Every cell where the scripts put it (shifted by the other side's line edit), formulas
        // in every tab pointing at the shifted cells.
        const cells = (book: any) => Object.fromEntries(book.tabs.map((tab: any) => [tab.id, { name: tab.name, rows: tab.rows, cols: tab.cols, cells: tab.cells }]))
        expect(cells(out), what).toEqual(cells(expected.workbook))
        if ((mine.line || theirs.line) && (mine.edits.length || theirs.edits.length)) rebased += 1
      }
      checkIdempotence('sheet', b!, m!, t!, result.ok ? result.body : null, what)
      for (const side of ['mine', 'theirs'] as const) {
        const settled = mergeArtifactBodies('sheet', b!, m!, t!, { resolve: side })
        const out = JSON.parse(body(settled, `${what} resolve ${side}`))
        expect(VALID.sheet(out), `${what} resolve ${side}: valid`).toBe(true)
        if (expected.workbook) expect(out, `${what} resolve ${side}: no conflict, same merge`).toEqual(JSON.parse(body(result, what)))
        // (v) nothing either side wrote is lost unless it clashed and the other side won.
        const values = new Set(out.tabs.flatMap((tab: any) => Object.values(tab.cells).map((cell: any) => cell.v)))
        for (const [script, other, is] of [[mine, theirs, 'mine'], [theirs, mine, 'theirs']] as const) {
          for (const v of survivingValues(script, other, is, side)) expect(values.has(v), `${what} resolve ${side}: ${is}'s ${v}`).toBe(true)
        }
      }
    }
    // The generator really exercises the rebase.
    expect(rebased).toBeGreaterThan(CASES / 5)
  })
})
