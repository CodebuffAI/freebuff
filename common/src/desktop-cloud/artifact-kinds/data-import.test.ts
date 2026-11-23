import { describe, expect, test } from 'bun:test'

import { parseDashboard, type Dashboard } from './data'
import {
  coerceCell,
  columnKey,
  datasetFromTable,
  importDataset,
  importDatasetArgsSchema,
  importDatasetOp,
  importRows,
  inferColumnType,
  parseDateCell,
  parseNumberCell,
  parseTable,
  rowsFromTable,
} from './data-import'

const base = (): Dashboard => ({
  version: 1,
  title: 'T',
  layout: 'grid',
  sources: [{ id: 's', label: 'Source' }],
  datasets: [
    {
      id: 'd',
      sourceId: 's',
      columns: [
        { key: 'day', label: 'Day', type: 'date' },
        { key: 'n', label: 'Count', type: 'number' },
      ],
      rows: [{ day: '2026-11-01', n: 1 }],
    },
  ],
  blocks: [{ kind: 'text', id: 't', markdown: 'hi' }],
})

const valid = (d: Dashboard) => {
  const r = parseDashboard(d)
  return r.ok ? [] : r.issues
}

describe('parsing fields', () => {
  test('parseTable picks TSV when the first line has a tab, and drops blank lines', () => {
    expect(parseTable('a\tb\n1\t2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseTable('a,b\r\n"x, y",2\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', '2'],
    ])
  })

  test('numbers: separators, currency, percent, parentheses', () => {
    expect(parseNumberCell('1,234.5')).toEqual({ value: 1234.5, style: 'number' })
    expect(parseNumberCell('$1,234.50')).toEqual({ value: 1234.5, style: 'currency' })
    expect(parseNumberCell('-$12')).toEqual({ value: -12, style: 'currency' })
    expect(parseNumberCell('(12)')).toEqual({ value: -12, style: 'number' })
    expect(parseNumberCell('12.5%')!.value).toBeCloseTo(0.125)
    expect(parseNumberCell('1e3')).toEqual({ value: 1000, style: 'number' })
    for (const bad of ['', 'abc', '1,23', '1.2.3', '$5%', '12 apples']) expect(parseNumberCell(bad)).toBeNull()
  })

  test('dates normalise to YYYY-MM-DD and impossible days are refused', () => {
    expect(parseDateCell('2026-11-09')).toBe('2026-11-09')
    expect(parseDateCell('2026/1/9')).toBe('2026-01-09')
    expect(parseDateCell('11/9/2026')).toBe('2026-11-09')
    expect(parseDateCell('2026-11-09T08:00:00Z')).toBe('2026-11-09')
    expect(parseDateCell('2026-02-30')).toBeNull()
    expect(parseDateCell('Nov 9')).toBeNull()
  })

  test('inferColumnType needs every non-empty value to agree', () => {
    expect(inferColumnType(['2026-11-01', '', '2026-11-02'])).toBe('date')
    expect(inferColumnType(['1', '2.5', ''])).toBe('number')
    expect(inferColumnType(['$1', '2'])).toBe('currency')
    expect(inferColumnType(['10%', '12.5%'])).toBe('percent')
    expect(inferColumnType(['10%', '12'])).toBe('string')
    expect(inferColumnType(['1', 'two'])).toBe('string')
    expect(inferColumnType(['', ''])).toBe('string')
    expect(inferColumnType(['02139', '10001'])).toBe('string')
    expect(inferColumnType(['0.5', '0'])).toBe('number')
  })

  test('coerceCell reads a field as its column type', () => {
    expect(coerceCell('', 'number')).toEqual({ cell: null, ok: true })
    expect(coerceCell('12.5%', 'percent').cell).toBeCloseTo(0.125)
    expect(coerceCell('0.2', 'percent')).toEqual({ cell: 0.2, ok: true })
    expect(coerceCell('20', 'percent').cell).toBeCloseTo(0.2)
    expect(coerceCell('word', 'number')).toEqual({ cell: null, ok: false })
    expect(coerceCell('x'.repeat(1500), 'string').cell).toHaveLength(1000)
  })

  test('columnKey makes unique, valid ids', () => {
    const taken = new Set<string>()
    expect(columnKey('Active users', taken)).toBe('active_users')
    expect(columnKey('Active users', taken)).toBe('active_users_2')
    expect(columnKey('!!!', taken)).toBe('col')
    expect(columnKey('x'.repeat(100), taken).length).toBeLessThanOrEqual(64)
  })
})

describe('tables into datasets', () => {
  test('datasetFromTable infers types and passes the schema', () => {
    const table = parseTable('Week,Users,Revenue,Rate,Name\n2026-11-02,"1,200",$5.50,12%,Web\n2026-11-09,1300,$6,13%,CLI\n')
    const made = datasetFromTable(table, { id: 'imp', sourceId: 's' })
    if ('error' in made) throw new Error(made.error)
    expect(made.dataset.columns.map((c) => [c.key, c.type])).toEqual([
      ['week', 'date'],
      ['users', 'number'],
      ['revenue', 'currency'],
      ['rate', 'percent'],
      ['name', 'string'],
    ])
    expect(made.dataset.rows[0]).toEqual({ week: '2026-11-02', users: 1200, revenue: 5.5, rate: 0.12, name: 'Web' })
    const d = base()
    expect(valid({ ...d, datasets: [...d.datasets, made.dataset] })).toEqual([])
  })

  test('caps rows and columns with a warning', () => {
    const header = Array.from({ length: 45 }, (_, i) => `c${i}`)
    const rows = Array.from({ length: 2100 }, () => header.map(() => '1'))
    const made = datasetFromTable([header, ...rows], { id: 'big', sourceId: 's' })
    if ('error' in made) throw new Error(made.error)
    expect(made.dataset.columns).toHaveLength(40)
    expect(made.dataset.rows).toHaveLength(2000)
    expect(made.warnings).toHaveLength(2)
  })

  test('rowsFromTable maps by header name when present, else by position', () => {
    const dataset = base().datasets[0]
    const named = rowsFromTable(dataset, [['Count', 'Day'], ['5', '2026-11-03']])
    expect(named.header).toBe(true)
    expect(named.rows).toEqual([{ day: '2026-11-03', n: 5 }])
    // A header naming only some of the columns still maps by name; the rest are left out (read as null).
    const wide = { ...dataset, columns: [...dataset.columns, { key: 'a', label: 'A', type: 'string' as const }, { key: 'b', label: 'B', type: 'string' as const }] }
    const subset = rowsFromTable(wide, [['n'], ['7']])
    expect(subset.header).toBe(true)
    expect(subset.rows).toEqual([{ n: 7 }]) // a left-out column reads as null
    const positional = rowsFromTable(dataset, [['2026-11-03', '5']])
    expect(positional.header).toBe(false)
    expect(positional.rows).toEqual([{ day: '2026-11-03', n: 5 }])
  })

  test('importRows replaces or appends, and counts values that did not fit', () => {
    const d = base()
    const appended = importRows(d, 'd', 'Day\tCount\n2026-11-02\t2\n2026-11-03\tlots', 'append')
    if (!appended.ok) throw new Error(appended.error)
    expect(appended.dashboard.datasets[0].rows).toHaveLength(3)
    expect(appended.dashboard.datasets[0].rows[2]).toEqual({ day: '2026-11-03', n: null })
    expect(appended.message).toContain('1 value did not fit')
    expect(valid(appended.dashboard)).toEqual([])

    const replaced = importRows(d, 'd', '2026-12-01,9', 'replace')
    if (!replaced.ok) throw new Error(replaced.error)
    expect(replaced.dashboard.datasets[0].rows).toEqual([{ day: '2026-12-01', n: 9 }])
    expect(d.datasets[0].rows).toHaveLength(1) // the input is left alone

    expect(importRows(d, 'nope', '1,2', 'append').ok).toBe(false)
    expect(importRows(d, 'd', '\n\n', 'append').ok).toBe(false)
  })

  test('importDataset adds a dataset and a source, and the result is valid', () => {
    const r = importDataset(base(), { text: 'Plan,Seats\nPro,12\nTeam,40', title: 'Seats by plan.csv' })
    if (!r.ok) throw new Error(r.error)
    expect(r.datasetId).toBe('seats_by_plan')
    expect(r.dashboard.sources).toHaveLength(2)
    const added = r.dashboard.datasets.find((ds) => ds.id === r.datasetId)!
    expect(added.sourceId).toBe(r.dashboard.sources[1].id)
    expect(valid(r.dashboard)).toEqual([])

    const onExisting = importDataset(base(), { text: 'a\n1', sourceId: 's' })
    expect(onExisting.ok && onExisting.dashboard.sources).toHaveLength(1)
    expect(importDataset(base(), { text: 'a\n1', sourceId: 'missing' }).ok).toBe(false)
    expect(importDataset(base(), { text: 'a\n1', id: 'd' }).ok).toBe(false)
    expect(importDataset(base(), { text: 'only,a,header' }).ok).toBe(false)
  })

  test('the agent op takes strict args', () => {
    expect(importDatasetArgsSchema.safeParse({ csv: 'a\n1', extra: 1 }).success).toBe(false)
    const args = importDatasetArgsSchema.parse({ csv: 'k,v\nx,1', title: 'KV', source: { label: 'Paste' } })
    const r = importDatasetOp(base(), args)
    expect(r.ok && valid(r.dashboard)).toEqual([])
  })
})
