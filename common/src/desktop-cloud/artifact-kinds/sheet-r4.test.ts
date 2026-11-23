import { describe, expect, test } from 'bun:test'
import { parseWorkbook, rowHidden, colHidden, type Workbook } from './sheet'
import {
  addGroup,
  copyCells,
  fitColumnWidth,
  groupAt,
  removeGroups,
  setGridlines,
  setGroupCollapsed,
  setLocale,
  setTimeZone,
} from './sheet-extras'
import { applyInput, editText, formatValue, parseInput, pruneCell } from './sheet-format'
import { clockParts, SheetEngine } from './sheet-formula'
import { addTab, deleteTab, duplicateTab, importCsv, pasteText, restoreTab, setCellInput, tabLimitMessage } from './sheet-ops'
import { cellRuns, isMention, parseRichText, richTextToMarkup } from './sheet-richtext'
import { deleteLines, insertLines, moveLines } from './sheet-structure'

/** A body as stored before round 4: every optional field of the time, none of the new ones. */
const PRE_R4: Workbook = {
  version: 1,
  title: 'Budget',
  revision: 3,
  names: [{ name: 'Costs', tab: 'main', range: 'B2:B4' }],
  tabs: [
    {
      id: 'main',
      name: 'Budget',
      rows: 40,
      cols: 8,
      frozenRows: 1,
      columns: [{ width: 160 }, { hidden: true }],
      rowMeta: { '3': { height: 40 } },
      merges: ['A10:B10'],
      tables: [{ id: 't1', range: 'A1:B4' }],
      rules: [{ id: 'r1', range: 'B2:B4', type: 'gt', value: 10, style: { bg: 'red' } }],
      validations: [{ kind: 'checkbox', range: 'C2:C4' }],
      protected: [{ id: 'p1', range: 'D1:D2', note: 'fixed' }],
      filter: { range: 'A1:B4' },
      cells: {
        A1: { v: 'Item', bold: true, bg: 'gray' },
        B1: { v: 'Cost', bold: true },
        A2: { v: 'Hosting', note: 'monthly' },
        B2: { v: 30, fmt: 'currency', decimals: 0 },
        B3: { v: 0.25, fmt: 'percent' },
        B4: { v: '2026-11-20', fmt: 'date', dateStyle: 'short' },
        B5: { f: '=SUM(B2:B4)', border: { top: 'thin' } },
      },
      charts: [{ id: 'c', anchor: 'E2', spec: { type: 'bar', range: 'A1:B4' } }],
    },
    { id: 'sum', name: 'Summary', cells: { A1: { f: '=Budget!B5' } } },
  ],
}

const fresh = (): Workbook => JSON.parse(JSON.stringify(PRE_R4)) as Workbook

describe('round-4 schema', () => {
  test('a pre-round-4 body parses unchanged', () => {
    const original = fresh()
    const parsed = parseWorkbook(original)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.workbook).toEqual(original)
  })

  test('new fields are accepted and checked', () => {
    const body = fresh()
    body.locale = 'en-GB'
    body.timeZone = 'Europe/London'
    body.tabs[0].gridlines = false
    body.tabs[0].rowGroups = [{ from: 2, to: 4, collapsed: true }]
    body.tabs[0].colGroups = [{ from: 'B', to: 'C' }]
    body.tabs[0].cells.A6 = { v: 'Total due', runs: [{ text: 'Total', bold: true }, { text: ' due' }], link: 'https://example.com' }
    body.tabs[0].cells.A7 = { v: 5, fmt: 'currency', currency: 'EUR' }
    expect(parseWorkbook(body).ok).toBe(true)

    const bad = (mutate: (w: Workbook) => void) => {
      const w = fresh()
      mutate(w)
      return parseWorkbook(w)
    }
    expect(bad((w) => (w.tabs[0].cells.A6 = { v: 'Total', runs: [{ text: 'Tot' }] })).ok).toBe(false)
    expect(bad((w) => (w.tabs[0].cells.A6 = { v: 'x', link: 'javascript:alert(1)' })).ok).toBe(false)
    expect(bad((w) => (w.tabs[0].rowGroups = [{ from: 2, to: 5 }, { from: 4, to: 6 }])).ok).toBe(false)
    expect(bad((w) => (w.tabs[0].rowGroups = [{ from: 5, to: 2 }])).ok).toBe(false)
    expect(bad((w) => (w.tabs[0].colGroups = [{ from: 'A', to: 'Z' }])).ok).toBe(false)
    expect(bad((w) => (w.timeZone = 'Mars/Olympus'))).toMatchObject({ ok: false })
    expect(bad((w) => ((w as { locale?: string }).locale = 'xx-XX')).ok).toBe(false)
  })
})

describe('typed input', () => {
  test('the same strings the editor reads', () => {
    expect(parseInput('50%')).toEqual({ v: 0.5, fmt: 'percent' })
    expect(parseInput('$1,234.50')).toEqual({ v: 1234.5, fmt: 'currency' })
    expect(parseInput('-$5')).toEqual({ v: -5, fmt: 'currency' })
    expect(parseInput('€5')).toEqual({ v: 5, fmt: 'currency', currency: 'EUR' })
    expect(parseInput('12.5 £')).toEqual({ v: 12.5, fmt: 'currency', currency: 'GBP' })
    expect(parseInput('2026-11-20')).toEqual({ v: '2026-11-20', fmt: 'date' })
    expect(parseInput('11/20/2026')).toEqual({ v: '2026-11-20', fmt: 'date' })
    expect(parseInput('Nov 20, 2026')).toEqual({ v: '2026-11-20', fmt: 'date' })
    expect(parseInput('20 November 2026')).toEqual({ v: '2026-11-20', fmt: 'date' })
    expect(parseInput('13:45').fmt).toBe('time')
    expect(parseInput('1:45 PM')).toEqual(parseInput('13:45'))
    expect(parseInput('true')).toEqual({ v: true })
    expect(parseInput("'50%")).toEqual({ v: '50%', fmt: 'text' })
    expect(parseInput('Hello')).toEqual({ v: 'Hello' })
    expect(parseInput('Mark 12, 2026')).toEqual({ v: 'Mark 12, 2026' })
    expect(parseInput('Sept 3, 2026')).toEqual({ v: '2026-09-03', fmt: 'date' })
    expect(parseInput('1,5')).toEqual({ v: '1,5' })
  })

  test('the locale picks day-first dates and the decimal comma', () => {
    expect(parseInput('20/11/2026', { locale: 'en-GB' })).toEqual({ v: '2026-11-20', fmt: 'date' })
    expect(parseInput('11/20/2026', { locale: 'en-GB' })).toEqual({ v: '11/20/2026' })
    expect(parseInput('20.11.2026', { locale: 'de-DE' })).toEqual({ v: '2026-11-20', fmt: 'date' })
    expect(parseInput('1.234,5', { locale: 'de-DE' })).toEqual({ v: 1234.5 })
    expect(parseInput('12,5 %', { locale: 'de-DE' })).toEqual({ v: 0.125, fmt: 'percent' })
    expect(parseInput('1.234,50 €', { locale: 'de-DE' })).toEqual({ v: 1234.5, fmt: 'currency', currency: 'EUR' })
  })

  test('typing into a currency cell keeps its currency; a new symbol replaces it', () => {
    const eur = applyInput(undefined, '€5')!
    expect(eur).toEqual({ v: 5, fmt: 'currency', currency: 'EUR' })
    expect(applyInput(eur, '7')).toEqual({ v: 7, fmt: 'currency', currency: 'EUR' })
    expect(applyInput(eur, '$7')).toEqual({ v: 7, fmt: 'currency' })
    expect(applyInput(eur, 'n/a')).toEqual({ v: 'n/a' })
  })

  test('setCellInput reads with the workbook locale', () => {
    const w = { ...fresh(), locale: 'en-GB' as const }
    const next = setCellInput(w, 'main', { row: 7, col: 0 }, '01/02/2026')
    expect(next.tabs[0].cells.A8).toEqual({ v: '2026-02-01', fmt: 'date' })
  })
})

describe('locale display', () => {
  test('en-US output is unchanged; other locales and currencies use Intl', () => {
    expect(formatValue(1234.5, 'currency')).toBe('$1,234.50')
    expect(formatValue(1234.5, 'number')).toBe('1,234.50')
    expect(formatValue(0.125, 'percent')).toBe('12.5%')
    expect(formatValue(46346, 'date')).toBe('Nov 20, 2026')
    expect(formatValue(5, 'currency', { currency: 'EUR' })).toBe('€5.00')
    expect(formatValue(1234.5, 'number', { locale: 'de-DE' })).toBe('1.234,50')
    expect(formatValue(1234.5, undefined, { locale: 'de-DE' })).toBe('1234,5')
    expect(formatValue(46346, 'date', { locale: 'en-GB', dateStyle: 'short' })).toBe('20/11/2026')
    expect(formatValue(0.5, 'time', { locale: 'de-DE' })).toBe('12:00')
  })

  test('editText writes back what parses to the same value', () => {
    expect(editText({ v: 1234.5 }, { locale: 'de-DE' })).toBe('1234,5')
    expect(parseInput(editText({ v: 0.125, fmt: 'percent' }, { locale: 'de-DE' }), { locale: 'de-DE' })).toEqual({ v: 0.125, fmt: 'percent' })
    // Literal markup with no runs keeps an apostrophe so it is not turned into rich text.
    expect(editText({ v: '**hi**' })).toBe("'**hi**")
  })
})

describe('rich text, links and mentions', () => {
  test('markup becomes runs over the plain text, and back', () => {
    const parsed = parseRichText('**Total** due by *Friday* see [docs](https://example.com/a)')!
    expect(parsed.text).toBe('Total due by Friday see docs')
    expect(parsed.runs).toEqual([
      { text: 'Total', bold: true },
      { text: ' due by ' },
      { text: 'Friday', italic: true },
      { text: ' see ' },
      { text: 'docs', link: 'https://example.com/a' },
    ])
    expect(richTextToMarkup(parsed.runs)).toBe('**Total** due by *Friday* see [docs](https://example.com/a)')
    expect(parseInput('**Total** due')).toEqual({ v: 'Total due', runs: [{ text: 'Total', bold: true }, { text: ' due' }] })
    const cell = applyInput(undefined, '~~old~~ new')!
    expect(editText(cell)).toBe('~~old~~ new')
  })

  test('no markup, a space inside markers, arithmetic, globs or an unsafe link stays text', () => {
    expect(parseRichText('5 * 3 * 2')).toBeNull()
    expect(parseRichText('2*3*4')).toBeNull()
    expect(parseRichText('*.ts,*.tsx')).toBeNull()
    expect(parseRichText('x**b**y')).toBeNull()
    expect(parseRichText('plain')).toBeNull()
    expect(parseRichText('[x](javascript:alert(1))')).toBeNull()
    expect(parseInput('2*3*4')).toEqual({ v: '2*3*4' })
    expect(parseRichText('a (**b**) c')?.runs).toEqual([{ text: 'a (' }, { text: 'b', bold: true }, { text: ') c' }])
  })

  test('paste and CSV import never read markup', () => {
    expect(parseInput('*x*', { rich: false })).toEqual({ v: '*x*' })
    const pasted = pasteText(fresh(), 'main', { top: 20, left: 0, bottom: 20, right: 0 }, '**x**\t*y*', null)
    expect(pasted.workbook.tabs[0].cells.A21).toEqual({ v: '**x**' })
    expect(pasted.workbook.tabs[0].cells.B21).toEqual({ v: '*y*' })
    const imported = importCsv(fresh(), 'a,b\n*x*,**y**', 'notes.csv')
    const tab = imported.workbook.tabs.find((t) => t.id === imported.tabId)!
    expect(tab.cells.A2).toEqual({ v: '*x*' })
  })

  test('runs that no longer spell the text are dropped', () => {
    expect(pruneCell({ v: 'Total', runs: [{ text: 'Tot', bold: true }] })).toEqual({ v: 'Total' })
    expect(cellRuns({ v: 'ab', runs: [{ text: 'a' }, { text: 'b', bold: true }] })).toHaveLength(2)
    // Typing over a rich cell without markup drops the runs and keeps the style.
    expect(applyInput({ v: 'ab', runs: [{ text: 'a' }, { text: 'b', bold: true }], bg: 'red' }, 'plain')).toEqual({ v: 'plain', bg: 'red' })
  })

  test('mentions', () => {
    expect(isMention('@Maya')).toBe(true)
    expect(isMention('@maya.lee')).toBe(true)
    expect(isMention('email me @ home now')).toBe(false)
  })
})

describe('time zone', () => {
  const at = new Date('2026-11-16T23:30:00Z')
  test('TODAY() and NOW() read the workbook zone', () => {
    const tokyo = { ...fresh(), timeZone: 'Asia/Tokyo' }
    tokyo.tabs[1].cells.B1 = { f: '=TODAY()' }
    tokyo.tabs[1].cells.B2 = { f: '=NOW()' }
    const engine = SheetEngine.build(tokyo, { now: () => at })
    // 23:30 UTC on the 16th is 08:30 on the 17th in Tokyo.
    expect(engine.value('sum', 0, 1)).toBe(46343)
    expect(engine.value('sum', 1, 1)).toBeCloseTo(46343 + 8.5 / 24, 6)
    const la = engine.update({ ...tokyo, timeZone: 'America/Los_Angeles' })
    expect(la.value('sum', 0, 1)).toBe(46342)
  })
  test('clockParts', () => {
    expect(clockParts(at, 'UTC')).toEqual({ y: 2026, m: 11, d: 16, h: 23, mi: 30, s: 0 })
  })
})

describe('groups', () => {
  test('add, collapse hides, overlap refused, ungroup', () => {
    let w = addGroup(fresh(), 'main', 'row', 1, 3)
    if (typeof w === 'string') throw new Error(w)
    expect(w.tabs[0].rowGroups).toEqual([{ from: 2, to: 4 }])
    expect(addGroup(w, 'main', 'row', 3, 5)).toContain('overlap')
    expect(addGroup(w, 'main', 'row', 0, 99)).toContain('40 rows')
    w = setGroupCollapsed(w, 'main', 'row', 2, true)
    expect(rowHidden(w.tabs[0], 1)).toBe(true)
    expect(rowHidden(w.tabs[0], 4)).toBe(false)
    expect(groupAt(w.tabs[0], 'row', 3)).toEqual({ from: 1, to: 3, collapsed: true })
    expect(setGroupCollapsed(w, 'main', 'row', 2, true)).toBe(w)
    const cols = addGroup(w, 'main', 'col', 2, 3) as Workbook
    expect(cols.tabs[0].colGroups).toEqual([{ from: 'C', to: 'D' }])
    expect(colHidden(setGroupCollapsed(cols, 'main', 'col', 3, true).tabs[0], 2)).toBe(true)
    expect(removeGroups(w, 'main', 'row', 0, 0)).toBe(w)
    // A folded group is found from the visible line that carries its +/− (row 5 here).
    expect(groupAt(w.tabs[0], 'row', 4)).toBeUndefined()
    expect(groupAt(w.tabs[0], 'row', 4, 40)).toEqual({ from: 1, to: 3, collapsed: true })
    expect(setGroupCollapsed(w, 'main', 'row', 4, false).tabs[0].rowGroups).toEqual([{ from: 2, to: 4 }])
    expect(addGroup(fresh(), 'main', 'col', 0, 7)).toContain('outside')
    expect(removeGroups(w, 'main', 'row', 3, 3).tabs[0].rowGroups).toBeUndefined()
    expect(parseWorkbook(cols).ok).toBe(true)
  })

  test('groups follow inserted, deleted and moved lines', () => {
    const w = addGroup(addGroup(fresh(), 'main', 'row', 4, 6) as Workbook, 'main', 'col', 2, 3) as Workbook
    expect(insertLines(w, 'main', 'row', 0, 2).tabs[0].rowGroups).toEqual([{ from: 7, to: 9 }])
    expect(deleteLines(w, 'main', 'row', 5, 1).tabs[0].rowGroups).toEqual([{ from: 5, to: 6 }])
    expect(deleteLines(w, 'main', 'row', 4, 3).tabs[0].rowGroups).toBeUndefined()
    expect(insertLines(w, 'main', 'col', 0, 1).tabs[0].colGroups).toEqual([{ from: 'D', to: 'E' }])
    expect(moveLines(w, 'main', 'row', 4, 3, 0).tabs[0].rowGroups).toEqual([{ from: 1, to: 3 }])
  })
})

describe('tabs: trash and limit', () => {
  test('a deleted tab is kept and restored where it was', () => {
    const deleted = deleteTab(fresh(), 'main')
    expect(deleted.tabs.map((t) => t.id)).toEqual(['sum'])
    expect(deleted.deletedTabs?.[0].index).toBe(0)
    expect(parseWorkbook(deleted).ok).toBe(true)
    const restored = restoreTab(deleted)
    if ('error' in restored) throw new Error(restored.error)
    expect(restored.workbook.tabs.map((t) => t.name)).toEqual(['Budget', 'Summary'])
    expect(restored.workbook.deletedTabs).toBeUndefined()
    expect(restored.workbook).toEqual(fresh())
    expect(restoreTab(fresh())).toEqual({ error: 'No deleted tab to restore.' })
  })

  test('a restored name that was taken meanwhile gets a number; the trash keeps five', () => {
    const deleted = deleteTab(fresh(), 'main')
    const taken = addTab(deleted, { name: 'Budget' }).workbook
    const restored = restoreTab(taken)
    if ('error' in restored) throw new Error(restored.error)
    expect(restored.workbook.tabs.some((t) => t.name === 'Budget (2)')).toBe(true)
    let w = fresh()
    for (let i = 0; i < 7; i += 1) {
      const added = addTab(w, { name: `T${i}` })
      w = deleteTab(added.workbook, added.tabId)
    }
    expect(w.deletedTabs?.map((e) => e.tab.name)).toEqual(['T2', 'T3', 'T4', 'T5', 'T6'])
  })

  test('the trash has its own cell budget: big deletes evict old entries or are not kept', () => {
    const big = (id: string, n: number) => {
      const cells: Record<string, { v: number }> = {}
      for (let i = 0; i < n; i += 1) cells[`A${i + 1}`] = { v: i }
      return { id, name: id.toUpperCase(), rows: Math.max(n, 1), cols: 2, cells }
    }
    let w: Workbook = { ...fresh(), tabs: [...fresh().tabs, big('x', 30_000), big('y', 30_000), big('z', 60_000)] }
    w = deleteTab(w, 'x')
    expect(w.deletedTabs?.map((e) => e.tab.id)).toEqual(['x'])
    w = deleteTab(w, 'y')
    // 60k would pass the 50k budget: the older one goes.
    expect(w.deletedTabs?.map((e) => e.tab.id)).toEqual(['y'])
    w = deleteTab(w, 'z')
    expect(w.deletedTabs?.map((e) => e.tab.id)).toEqual(['y'])
    expect(w.tabs.map((t) => t.id)).toEqual(['main', 'sum'])
    expect(parseWorkbook(w).ok).toBe(true)
  })

  test('at 50 tabs add and duplicate change nothing, restore says why', () => {
    let w = fresh()
    while (w.tabs.length < 50) w = addTab(w).workbook
    expect(addTab(w).workbook).toBe(w)
    expect(duplicateTab(w, 'main').workbook).toBe(w)
    const full = { ...w, deletedTabs: [{ tab: { id: 'x', name: 'X', cells: {} }, index: 0 }] }
    expect(restoreTab(full)).toEqual({ error: tabLimitMessage })
  })
})

describe('copy, view settings, fit', () => {
  test('copyCells shifts relative references and refuses off-sheet', () => {
    const result = copyCells(fresh(), 'main', { top: 4, left: 1, bottom: 4, right: 1 }, 'main', { row: 4, col: 2 })
    if ('error' in result) throw new Error(result.error)
    expect(result.workbook.tabs[0].cells.C5).toEqual({ f: '=SUM(C2:C4)', border: { top: 'thin' } })
    const across = copyCells(fresh(), 'main', { top: 0, left: 0, bottom: 1, right: 1 }, 'sum', { row: 3, col: 0 })
    if ('error' in across) throw new Error(across.error)
    expect(across.workbook.tabs[1].cells.A4).toEqual({ v: 'Item', bold: true, bg: 'gray' })
    expect(copyCells(fresh(), 'main', { top: 0, left: 0, bottom: 1, right: 1 }, 'main', { row: 39, col: 0 })).toHaveProperty('error')
  })

  test('gridlines, locale and time zone', () => {
    const hidden = setGridlines(fresh(), 'main', false)
    expect(hidden.tabs[0].gridlines).toBe(false)
    expect(setGridlines(hidden, 'main', true).tabs[0].gridlines).toBeUndefined()
    expect(setGridlines(fresh(), 'main', true)).toEqual(fresh())
    expect(setLocale(fresh(), 'fr-FR')).toMatchObject({ locale: 'fr-FR' })
    expect(setLocale(fresh(), 'xx')).toContain('not one of')
    expect(setTimeZone(fresh(), 'Asia/Tokyo')).toMatchObject({ timeZone: 'Asia/Tokyo' })
    expect(setTimeZone(fresh(), 'Nowhere/City')).toContain('IANA')
    expect(setTimeZone({ ...fresh(), timeZone: 'UTC' }, null)).toEqual(fresh())
  })

  test('fitColumnWidth grows with the longest shown text', () => {
    const w = fresh()
    w.tabs[0].cells.A9 = { v: 'A rather long line of text in column A' }
    const engine = SheetEngine.build(w)
    expect(fitColumnWidth(w, engine, 'main', 0)).toBeGreaterThan(250)
    expect(fitColumnWidth(w, engine, 'main', 7)).toBe(48)
  })
})
