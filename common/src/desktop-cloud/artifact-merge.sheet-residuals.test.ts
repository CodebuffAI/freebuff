import { describe, expect, test } from 'bun:test'

import { mergeArtifactBodies, type ArtifactMergeResult } from './artifact-merge'
import { workbookSchema, type Workbook } from './artifact-kinds/sheet'
import { protectionRefusal } from './artifact-kinds/sheet-guard'
import { insertLines, moveLines } from './artifact-kinds/sheet-structure'

// Sheet merge residuals from the third artifacts audit: the owner on "mine", Keep mine on a
// protection conflict after a row shift, sparse tabs whose line edit only settings pin down, and
// a move of one filled line.

const J = JSON.stringify
const clone = <T>(value: T): T => structuredClone(value)
const tab = (id: string, cells: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), rows: 20, cols: 6, cells, ...extra })
const book = (...tabs: unknown[]): any => ({ version: 1, title: 'B', tabs })

function body(result: ArtifactMergeResult): any {
  if (!result.ok) throw new Error(`conflict: ${result.conflicts.join(', ')}`)
  return JSON.parse(result.body)
}

const ownerAccepts = (theirs: unknown, out: unknown) => protectionRefusal(theirs as Workbook, out as Workbook, { owner: true })

describe('the owner is "mine": their protection changes stand', () => {
  const P = { id: 'p', range: 'A1:A1' }
  const Q = { id: 'q', range: 'B1:B1' }

  test('the owner adds a protection while an editor edits elsewhere', () => {
    const R = { id: 'r', range: 'D1:D1' }
    const base = book(tab('t', { A1: { v: 'locked' } }, { protected: [P] }))
    const mine = book(tab('t', { A1: { v: 'locked' }, D1: { v: 'secret' } }, { protected: [P, R] }))
    const theirs = book(tab('t', { A1: { v: 'locked' }, C5: { v: 'ed' } }, { protected: [P] }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs), { mineIsOwner: true }))
    expect(out.tabs[0].protected).toEqual([P, R])
    expect(out.tabs[0].cells).toEqual({ A1: { v: 'locked' }, D1: { v: 'secret' }, C5: { v: 'ed' } })
    expect(ownerAccepts(theirs, out)).toBeNull()
  })

  test('the owner removes a protection and edits the cell it held', () => {
    const base = book(tab('t', { A1: { v: 'locked' }, B1: { v: 'q' } }, { protected: [P, Q] }))
    const mine = book(tab('t', { A1: { v: 'owner-edit' }, B1: { v: 'q' } }, { protected: [Q] }))
    const theirs = book(tab('t', { A1: { v: 'locked' }, B1: { v: 'q' }, C5: { v: 'ed' } }, { protected: [P, Q] }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs), { mineIsOwner: true }))
    expect(out.tabs[0].protected).toEqual([Q])
    expect(out.tabs[0].cells).toEqual({ A1: { v: 'owner-edit' }, B1: { v: 'q' }, C5: { v: 'ed' } })
    expect(ownerAccepts(theirs, out)).toBeNull()
  })

  test('the owner resizes a protection', () => {
    const base = book(tab('t', { A1: { v: 'locked' } }, { protected: [P] }))
    const mine = book(tab('t', { A1: { v: 'locked' } }, { protected: [{ id: 'p', range: 'A1:A3' }] }))
    const theirs = book(tab('t', { A1: { v: 'locked' }, C5: { v: 'ed' } }, { protected: [P] }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs), { mineIsOwner: true }))
    expect(out.tabs[0].protected).toEqual([{ id: 'p', range: 'A1:A3' }])
    expect(out.tabs[0].cells.C5).toEqual({ v: 'ed' })
  })

  test('the owner inserts a row above a protection, moving it', () => {
    const PP = { id: 'p', range: 'A3:A4' }
    const QQ = { id: 'q', range: 'A1:A1' }
    const base = book(tab('t', { A1: { v: 'q' }, A3: { v: 'p1' }, A4: { v: 'p2' }, B10: { v: 'z' } }, { protected: [QQ, PP] }))
    const mine = insertLines(base, 't', 'row', 1, 1)
    const theirs = book(tab('t', { A1: { v: 'q' }, A3: { v: 'p1' }, A4: { v: 'p2' }, B10: { v: 'z' }, F19: { v: 'ed' } }, { protected: [QQ, PP] }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs), { mineIsOwner: true }))
    expect(out.tabs[0].protected).toEqual([QQ, { id: 'p', range: 'A4:A5' }])
    expect(out.tabs[0].cells).toEqual({ A1: { v: 'q' }, A4: { v: 'p1' }, A5: { v: 'p2' }, B11: { v: 'z' }, F20: { v: 'ed' } })
    expect(ownerAccepts(theirs, out)).toBeNull()
  })

  test('without the flag a non-owner still cannot drop a protection the owner holds', () => {
    // Same bodies as the removal case, read as an editor's draft: the protection stays.
    const base = book(tab('t', { A1: { v: 'locked' }, B1: { v: 'q' } }, { protected: [P, Q] }))
    const mine = book(tab('t', { A1: { v: 'locked' }, B1: { v: 'q' }, D4: { v: 'x' } }, { protected: [P, Q] }))
    const theirs = book(tab('t', { A1: { v: 'locked' }, B1: { v: 'q' }, C5: { v: 'ed' } }, { protected: [P, Q] }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs)))
    expect(out.tabs[0].protected).toEqual([P, Q])
  })
})

describe('Keep mine on a protection conflict after these edits shifted rows', () => {
  // An editor inserted row 2 (and typed in B3, now B4) while the owner protected A10:A12.
  const cells: Record<string, unknown> = {}
  for (let i = 1; i <= 14; i += 1) cells[`A${i}`] = { v: `r${i}` }
  const base = book(tab('t', cells))
  const inserted: any = insertLines(base, 't', 'row', 1, 1)
  inserted.tabs[0].cells.B4 = { v: 'mine' }
  const theirs = book(tab('t', { ...cells, C1: { v: 'owner' } }, { protected: [{ id: 'q', range: 'A10:A12' }] }))

  test('unsettled it is a conflict on the protection', () => {
    const result = mergeArtifactBodies('sheet', J(base), J(inserted), J(theirs))
    expect(result.ok).toBe(false)
  })

  test('settled toward mine: no row lost or doubled, the insert undone, the other edits kept', () => {
    const out = body(mergeArtifactBodies('sheet', J(base), J(inserted), J(theirs), { resolve: 'mine' }))
    const column = Object.entries(out.tabs[0].cells as Record<string, { v: unknown }>)
      .filter(([address]) => address.startsWith('A'))
      .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
      .map(([address, cell]) => `${address}=${String(cell.v)}`)
    expect(column).toEqual(Array.from({ length: 14 }, (_, i) => `A${i + 1}=r${i + 1}`))
    expect(out.tabs[0].cells.B3).toEqual({ v: 'mine' })
    expect(out.tabs[0].cells.C1).toEqual({ v: 'owner' })
    expect(out.tabs[0].protected).toEqual([{ id: 'q', range: 'A10:A12' }])
    expect(workbookSchema.safeParse(out).success).toBe(true)
    expect(protectionRefusal(theirs, out, { owner: false })).toBeNull()
  })

  test('settled toward theirs: their body', () => {
    const result = mergeArtifactBodies('sheet', J(base), J(inserted), J(theirs), { resolve: 'theirs' })
    expect(body(result)).toEqual(theirs)
  })
})

describe('a sparse tab: where a row went in is pinned by more than its cells', () => {
  const sparse = (extra: Record<string, unknown> = {}) => tab('t', { A20: { v: 'x' } }, { rows: 30, cols: 5, ...extra })

  test('the other side’s row settings in the span the insert could be anywhere in: a conflict, never a guess', () => {
    const base = book(sparse())
    const mine = insertLines(base, 't', 'row', 5, 1)
    const theirs = book(
      sparse({ rowMeta: { '2': { height: 60 } }, merges: ['A1:B1'], rules: [{ id: 'r1', range: 'A2:A3', type: 'empty', style: { bg: 'red' } }] }),
    )
    const result = mergeArtifactBodies('sheet', J(base), J(mine), J(theirs))
    if (result.ok) {
      // Clean only if nothing shifted by a guess.
      const out = JSON.parse(result.body)
      expect(out.tabs[0].rowMeta).toEqual({ '2': { height: 60 } })
      expect(out.tabs[0].merges).toEqual(['A1:B1'])
      expect(out.tabs[0].rules[0].range).toBe('A2:A3')
    } else {
      expect(result.conflicts).toEqual(['rows or columns of tab "T"'])
    }
  })

  test('settings on this side pin the insert: the other side’s settings above it stay put', () => {
    // Row 4's height says mine inserted at or below row 4.
    const base = book(sparse({ rowMeta: { '4': { height: 40 } } }))
    const mine = insertLines(base, 't', 'row', 5, 1)
    const theirs = book(
      sparse({ rowMeta: { '2': { height: 60 }, '4': { height: 40 } }, merges: ['A1:B1'], rules: [{ id: 'r1', range: 'A2:A3', type: 'empty', style: { bg: 'red' } }] }),
    )
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs)))
    expect(out.tabs[0].rowMeta).toEqual({ '2': { height: 60 }, '4': { height: 40 } })
    expect(out.tabs[0].merges).toEqual(['A1:B1'])
    expect(out.tabs[0].rules[0].range).toBe('A2:A3')
    expect(out.tabs[0].cells).toEqual({ A21: { v: 'x' } })
    expect(out.tabs[0].rows).toBe(31)
  })

  test('below the insert the other side’s settings shift with the rows', () => {
    const base = book(sparse({ rowMeta: { '4': { height: 40 } } }))
    const mine = insertLines(base, 't', 'row', 5, 1)
    const theirs = book(sparse({ rowMeta: { '4': { height: 40 } }, merges: ['A25:B25'] }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs)))
    expect(out.tabs[0].merges).toEqual(['A26:B26'])
  })
})

describe('a move of one filled row', () => {
  // Row 5 (the only one filled under the header) moved up to row 2.
  const base = book(tab('t', { A1: { v: 'h' }, A5: { v: 'x' } }, { rows: 6, cols: 3 }))
  const moved = moveLines(base, 't', 'row', 4, 1, 1)

  test('the fixture really is one filled cell moving', () => {
    expect((moved as any).tabs[0].cells).toEqual({ A1: { v: 'h' }, A2: { v: 'x' } })
  })

  test('the other side’s cell edit on a displaced row never lands on the wrong row', () => {
    const theirs = clone(base)
    theirs.tabs[0].cells.C3 = { v: 'y' }
    for (const [m, t] of [
      [moved, theirs],
      [theirs, moved],
    ]) {
      const result = mergeArtifactBodies('sheet', J(base), J(m), J(t))
      // Base row 3 is row 4 after the move.
      if (result.ok) expect(JSON.parse(result.body).tabs[0].cells.C4).toEqual({ v: 'y' })
      else expect(result.conflicts).toEqual(['rows or columns of tab "T"'])
    }
  })

  test('the other side’s row settings on a displaced row never land on the wrong row', () => {
    const theirs = clone(base)
    theirs.tabs[0].rowMeta = { '3': { height: 50 } }
    const result = mergeArtifactBodies('sheet', J(base), J(moved), J(theirs))
    if (result.ok) expect(JSON.parse(result.body).tabs[0].rowMeta).toEqual({ '4': { height: 50 } })
    else expect(result.conflicts).toEqual(['rows or columns of tab "T"'])
  })
})

describe('regressions the move and Keep-mine fixes must not bring', () => {
  test('a status column edited in place is not a move', () => {
    const base = book(tab('t', { A2: { v: 'Doing' }, A7: { v: 'Todo' } }))
    const mine = book(tab('t', { A2: { v: 'Done' }, A7: { v: 'Doing' } }))
    const theirs = book(tab('t', { A2: { v: 'Doing' }, A7: { v: 'Todo' }, C4: { v: 'note' } }))
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs)))
    expect(out.tabs[0].cells).toEqual({ A2: { v: 'Done' }, A7: { v: 'Doing' }, C4: { v: 'note' } })
  })

  test('Keep mine on a protection conflict keeps a row inserted below every protection', () => {
    // Mine inserts below the owner's new protection and also types into it.
    const cells: Record<string, unknown> = {}
    for (let i = 1; i <= 14; i += 1) cells[`A${i}`] = { v: `r${i}` }
    const base = book(tab('t', cells))
    const mine: any = insertLines(base, 't', 'row', 12, 1)
    mine.tabs[0].cells.A3 = { v: 'mine' }
    const theirs = book(tab('t', cells, { protected: [{ id: 'q', range: 'A2:A4' }] }))
    expect(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs)).ok).toBe(false)
    const out = body(mergeArtifactBodies('sheet', J(base), J(mine), J(theirs), { resolve: 'mine' }))
    // The protected cell is theirs'; the insert stands (r13 and r14 moved down one).
    expect(out.tabs[0].cells.A3).toEqual({ v: 'r3' })
    expect(out.tabs[0].cells.A13).toBeUndefined()
    expect(out.tabs[0].cells.A14).toEqual({ v: 'r13' })
    expect(out.tabs[0].cells.A15).toEqual({ v: 'r14' })
    expect(protectionRefusal(theirs, out, { owner: false })).toBeNull()
  })
})

describe('a sort that moves one filled row', () => {
  test('the other side’s edit on a row the sort moved never lands on the wrong row', async () => {
    const { sortRange } = await import('./artifact-kinds/sheet-structure')
    const { SheetEngine } = await import('./artifact-kinds/sheet-formula')
    const base = book(tab('t', { A1: { v: 'n' }, A3: { v: 1 } }, { rows: 6, cols: 3 }))
    const sorted: any = sortRange(base, SheetEngine.build(base), 't', { top: 0, left: 0, bottom: 5, right: 2 }, [{ col: 0 }], { header: true })
    // The fixture really is one filled cell moving up a row.
    expect(sorted.tabs[0].cells).toEqual({ A1: { v: 'n' }, A2: { v: 1 } })
    const theirs = clone(base)
    theirs.tabs[0].cells.B3 = { v: 'with 1' }
    const result = mergeArtifactBodies('sheet', J(base), J(sorted), J(theirs))
    if (result.ok) expect(JSON.parse(result.body).tabs[0].cells.B2).toEqual({ v: 'with 1' })
    else expect(result.conflicts).toEqual(['rows or columns of tab "T"'])
  })
})
