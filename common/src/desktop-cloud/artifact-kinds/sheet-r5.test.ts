import { describe, expect, test } from 'bun:test'
import { parseWorkbook, workbookSchema, type Workbook } from './sheet'
import { applyInput, editText, formatPattern, formatValue, parseInput } from './sheet-format'
import { SheetEngine } from './sheet-formula'
import { parseRichText, richTextToMarkup } from './sheet-richtext'
import { convertText, copyBlock, describeSheet, importRows, pasteSpecial, personCell, removeDuplicates, splitToColumns, trimWhitespace } from './sheet-r5'

/** A workbook as stored before round 5, every round-4 feature in it: it must parse to itself. */
const PRE_R5: Workbook = {
  version: 1,
  title: 'Q4 budget',
  locale: 'en-GB',
  timeZone: 'Europe/London',
  names: [{ name: 'Costs', tab: 'budget', range: 'B2:B4' }],
  tabs: [
    {
      id: 'budget',
      name: 'Budget',
      rows: 40,
      cols: 10,
      frozenRows: 1,
      columns: [{ width: 180 }, { hidden: true }],
      rowMeta: { '3': { height: 40 } },
      gridlines: false,
      cells: {
        A1: { v: 'Item', bold: true, bg: 'gray', border: { bottom: 'thick' } },
        A2: { v: 'Hosting now', runs: [{ text: 'Hosting ' }, { text: 'now', bold: true }] },
        B2: { v: 1200, fmt: 'currency', currency: 'EUR', decimals: 0 },
        C2: { v: '2026-11-20', fmt: 'date', dateStyle: 'long' },
        D2: { v: '@Maya' },
        B5: { f: '=SUM(Costs)', fmt: 'currency', bold: true, note: 'total' },
      },
      merges: ['E1:F1'],
      tables: [{ id: 't1', range: 'A1:D4', banded: true }],
      rules: [{ id: 'r1', range: 'B2:B4', type: 'scale', scale: ['red', 'yellow', 'green'] }],
      validations: [{ kind: 'list', range: 'D2:D9', options: [{ value: 'Done', color: 'green' }] }],
      protected: [{ id: 'p1', range: 'B5', note: 'formula' }],
      rowGroups: [{ from: 6, to: 8, collapsed: true }],
      charts: [{ id: 'chart-1', anchor: 'H2', spec: { type: 'bar', range: 'A1:B4', legend: false } }],
    },
  ],
  deletedTabs: [{ tab: { id: 'old', name: 'Old', cells: { A1: { v: 1 } } }, index: 1 }],
}

describe('round-5 schema', () => {
  test('a pre-round-5 workbook parses unchanged', () => {
    const parsed = workbookSchema.safeParse(JSON.parse(JSON.stringify(PRE_R5)))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(PRE_R5)
  })

  test('new fields are optional and validated', () => {
    const book = (cell: Record<string, unknown>) => ({ ...PRE_R5, tabs: [{ ...PRE_R5.tabs[0], cells: { A1: cell } }] })
    expect(parseWorkbook(book({ v: 'x', font: 'Georgia', indent: 2, rotate: 45, list: 'bullet', pattern: '#,##0' })).ok).toBe(true)
    expect(parseWorkbook(book({ v: 'x', font: 'Comic Sans' })).ok).toBe(false)
    expect(parseWorkbook(book({ v: 'x', rotate: 30 })).ok).toBe(false)
    expect(parseWorkbook(book({ v: 'Maya, Li', people: [{ name: 'Maya' }, { name: 'Li' }] })).ok).toBe(true)
    expect(parseWorkbook(book({ v: 'Maya', people: [{ name: 'Ma,ya' }] })).ok).toBe(false)
    expect(parseWorkbook(book({ v: 'x', bg: 'purple', color: 'teal' })).ok).toBe(true)
    const chart = { id: 'c', anchor: 'H2', spec: { type: 'pie', range: 'A1:B4' } }
    expect(parseWorkbook({ ...PRE_R5, tabs: [{ ...PRE_R5.tabs[0], charts: [chart, { ...chart, id: 'd', spec: { type: 'bar', stacked: true, range: 'A1:C4' } }] }] }).ok).toBe(true)
    const rules = [{ id: 'b', range: 'B2:B4', type: 'bars', style: { bg: 'blue' } }, { id: 'i', range: 'B2:B4', type: 'icons', icons: 'traffic' }]
    expect(parseWorkbook({ ...PRE_R5, tabs: [{ ...PRE_R5.tabs[0], rules }] }).ok).toBe(true)
  })
})

describe('custom number formats', () => {
  test('number patterns', () => {
    expect(formatPattern(1234.567, '#,##0.00')?.text).toBe('1,234.57')
    expect(formatPattern(1234.5, '0')?.text).toBe('1235')
    expect(formatPattern(0.125, '0.0%')?.text).toBe('12.5%')
    expect(formatPattern(-1500, '"$"#,##0;[Red]-"$"#,##0')).toEqual({ text: '-$1,500', color: 'red' })
    expect(formatPattern(1500, '"$"#,##0;[Red]-"$"#,##0')?.text).toBe('$1,500')
    expect(formatPattern(12_345, '#,##0,"k"')?.text).toBe('12k')
    expect(formatPattern(12345, '0.00E+00')?.text).toBe('1.23E+04')
    expect(formatPattern(0, '0;-0;"zero"')?.text).toBe('zero')
    expect(formatPattern(7, '000')?.text).toBe('007')
    expect(formatPattern('abc', '0;-0;0;"<"@">"')?.text).toBe('<abc>')
    expect(formatPattern('abc', '0.00')).toBeNull()
  })

  test('date patterns', () => {
    const serial = 46_346 // 2026-11-20
    expect(formatPattern(serial, 'yyyy-mm-dd')?.text).toBe('2026-11-20')
    expect(formatPattern(serial, 'dddd, mmmm d')?.text).toBe('Friday, November 20')
    expect(formatPattern(serial + 0.75, 'h:mm AM/PM')?.text).toBe('6:00 PM')
    expect(formatPattern('2026-11-20', 'mmm d, yy', 'date')?.text).toBe('Nov 20, 26')
  })

  test('formatValue applies a cell pattern', () => {
    expect(formatValue(0.5, 'percent', { pattern: '0%' })).toBe('50%')
    expect(formatValue(true, undefined, { pattern: '0%' })).toBe('TRUE')
  })
})

describe('rich text, lists and people', () => {
  test('++underline++ is typed markup and round-trips', () => {
    const rich = parseRichText('a ++key++ word')!
    expect(rich.runs).toEqual([{ text: 'a ' }, { text: 'key', underline: true }, { text: ' word' }])
    expect(richTextToMarkup(rich.runs)).toBe('a ++key++ word')
    expect(parseRichText('C++ and C++')).toBeNull()
  })

  test('lines typed as a list become a list cell and edit back as markup', () => {
    const cell = applyInput(undefined, '- milk\n- eggs')!
    expect(cell).toEqual({ v: 'milk\neggs', list: 'bullet' })
    expect(editText(cell)).toBe('- milk\n- eggs')
    expect(applyInput(undefined, '1. one\n2. two')).toEqual({ v: 'one\ntwo', list: 'number' })
    expect(applyInput(cell, 'plain')).toEqual({ v: 'plain' })
    expect(parseInput('- 5').v).toBe('- 5')
  })

  test('person cells keep formatting; typing over one drops the people', () => {
    const cell = personCell({ v: 'x', bold: true }, [{ name: 'Maya' }, { name: 'Li' }, { name: 'maya' }])!
    expect(cell).toEqual({ v: 'Maya, Li', people: [{ name: 'Maya' }, { name: 'Li' }], bold: true })
    expect(applyInput(cell, 'Someone')).toEqual({ v: 'Someone', bold: true })
  })
})

const book = (cells: Workbook['tabs'][0]['cells'], cols = 8): Workbook => ({
  version: 1,
  title: 'T',
  tabs: [
    { id: 'a', name: 'A', rows: 20, cols, cells },
    { id: 'b', name: 'B', rows: 20, cols: 8, cells: {} },
  ],
})
const rect = (top: number, left: number, bottom: number, right: number) => ({ top, left, bottom, right })

describe('cleanup', () => {
  test('trim whitespace', () => {
    const result = trimWhitespace(book({ A1: { v: '  a   b  ' }, A2: { v: 'ok' }, A3: { f: '=" x "' } }), 'a', rect(0, 0, 2, 0))
    if (typeof result === 'string') throw new Error(result)
    expect(result.changed).toBe(1)
    expect(result.workbook.tabs[0].cells.A1).toEqual({ v: 'a b' })
  })

  test('remove duplicates keeps the header and the first of each, shifting rows up', () => {
    const wb = book({ A1: { v: 'Name' }, A2: { v: 'x' }, B2: { v: 1 }, A3: { v: 'X ' }, B3: { v: 1 }, A4: { v: 'y' }, B4: { v: 2 }, A5: { v: 'x' }, B5: { v: 3 } })
    const result = removeDuplicates(wb, SheetEngine.build(wb), 'a', rect(0, 0, 4, 1), { header: true, columns: [0] })
    if (typeof result === 'string') throw new Error(result)
    expect(result.changed).toBe(2)
    const cells = result.workbook.tabs[0].cells
    expect([cells.A2?.v, cells.A3?.v, cells.A4, cells.A5]).toEqual(['x', 'y', undefined, undefined])
    expect(cells.B3?.v).toBe(2)
  })

  test('split text to columns types the parts and refuses to overwrite', () => {
    const wb = book({ A1: { v: 'Maya, 12, 2026-11-20' }, A2: { v: 'Li,3' } })
    const result = splitToColumns(wb, 'a', rect(0, 0, 1, 0))
    if (typeof result === 'string') throw new Error(result)
    expect(result.workbook.tabs[0].cells).toEqual({ A1: { v: 'Maya' }, B1: { v: 12 }, C1: { v: '2026-11-20', fmt: 'date' }, A2: { v: 'Li' }, B2: { v: 3 } })
    expect(splitToColumns(book({ A1: { v: 'a,b' }, B1: { v: 'taken' } }), 'a', rect(0, 0, 0, 0))).toContain('B1 is not empty')
    expect(splitToColumns(wb, 'a', rect(0, 0, 0, 1))).toContain('one column')
  })

  test('text to numbers and dates', () => {
    const wb = book({ A1: { v: '1,234', fmt: 'text' }, A2: { v: '$5' }, A3: { v: 'n/a' }, A4: { v: 'Nov 20, 2026' } })
    const numbers = convertText(wb, 'a', rect(0, 0, 3, 0), 'number')
    if (typeof numbers === 'string') throw new Error(numbers)
    expect(numbers.workbook.tabs[0].cells).toMatchObject({ A1: { v: 1234 }, A2: { v: 5, fmt: 'currency' }, A3: { v: 'n/a' }, A4: { v: 'Nov 20, 2026' } })
    expect(numbers.workbook.tabs[0].cells.A1.fmt).toBeUndefined()
    const dates = convertText(wb, 'a', rect(0, 0, 3, 0), 'date')
    if (typeof dates === 'string') throw new Error(dates)
    expect(dates.workbook.tabs[0].cells.A4).toEqual({ v: '2026-11-20', fmt: 'date' })
  })
})

describe('paste special', () => {
  const wb = book({ A1: { v: 2, bold: true }, A2: { f: '=A1*3', fmt: 'currency' }, B1: { v: 'x', bg: 'red' } })
  const engine = SheetEngine.build(wb)
  const block = copyBlock(wb, engine, 'a', rect(0, 0, 1, 1))
  if (typeof block === 'string') throw new Error(block)

  test('values only writes computed values with the number format', () => {
    const out = pasteSpecial(wb, 'b', { row: 0, col: 0 }, block, 'values')
    if (typeof out === 'string') throw new Error(out)
    expect(out.workbook.tabs[1].cells).toEqual({ A1: { v: 2 }, A2: { v: 6, fmt: 'currency' }, B1: { v: 'x' } })
  })

  test('formats only keeps the destination values', () => {
    const target = { ...wb, tabs: [wb.tabs[0], { ...wb.tabs[1], cells: { A1: { v: 'keep' } } }] }
    const out = pasteSpecial(target, 'b', { row: 0, col: 0 }, block, 'formats')
    if (typeof out === 'string') throw new Error(out)
    expect(out.workbook.tabs[1].cells).toEqual({ A1: { v: 'keep', bold: true }, A2: { fmt: 'currency' }, B1: { bg: 'red' } })
  })

  test('transpose turns the block and shifts formulas by their own move', () => {
    const out = pasteSpecial(wb, 'a', { row: 4, col: 0 }, block, 'transpose')
    if (typeof out === 'string') throw new Error(out)
    const cells = out.workbook.tabs[0].cells
    expect(cells.A5).toEqual({ v: 2, bold: true })
    expect(cells.B5).toEqual({ f: '=B4*3', fmt: 'currency' })
    expect(cells.A6).toEqual({ v: 'x', bg: 'red' })
    expect(out.rect).toEqual(rect(4, 0, 5, 1))
  })

  test('refuses past the edge', () => {
    expect(pasteSpecial(wb, 'a', { row: 19, col: 0 }, block, 'values')).toContain("past the tab's edge")
  })
})

describe('importRows', () => {
  test('types every field, grows the tab, keeps "=" as text', () => {
    const wb = book({}, 2)
    const out = importRows(wb, 'a', 'name,amount,when,ok\nMaya,"1,200",2026-11-20,TRUE\nLi,50%,,=1+1\n')
    if (typeof out === 'string') throw new Error(out)
    const tab = out.workbook.tabs[0]
    expect(tab.cols).toBe(4)
    expect(tab.cells).toMatchObject({ A1: { v: 'name' }, B2: { v: 1200 }, C2: { v: '2026-11-20', fmt: 'date' }, D2: { v: true }, B3: { v: 0.5, fmt: 'percent' }, D3: { v: '=1+1', fmt: 'text' } })
    expect(parseWorkbook(out.workbook).ok).toBe(true)
  })

  test('tab-separated text and a start cell', () => {
    const out = importRows(book({}), 'a', 'a\tb\n1\t2', { at: { row: 2, col: 1 } })
    if (typeof out === 'string') throw new Error(out)
    expect(out.workbook.tabs[0].cells).toEqual({ B3: { v: 'a' }, C3: { v: 'b' }, B4: { v: 1 }, C4: { v: 2 } })
  })
})

describe('describeSheet', () => {
  test('names frozen panes, tables, rules, validations, protections, charts, formats and names', () => {
    const text = describeSheet(PRE_R5)
    for (const part of [
      'Budget (id budget)',
      'frozen: 1 row',
      'grid lines hidden',
      'hidden columns: B',
      'row heights: 3=40px',
      'row groups: 6:8 collapsed',
      'table t1 A1:D4',
      'merges: E1:F1',
      'rule r1 on B2:B4: colour scale red→yellow→green',
      'validation on D2:D9: list options Done (green)',
      'protected B5 (id p1): formula',
      'chart chart-1 at H2: bar of A1:B4, no legend',
      'format {"fmt":"currency","decimals":0,"currency":"EUR"} on B2',
      'B5 note "total"',
      'Defined names: Costs = Budget!B2:B4',
    ])
      expect(text).toContain(part)
    expect(describeSheet(PRE_R5, 'nope')).toBe('')
  })
})
