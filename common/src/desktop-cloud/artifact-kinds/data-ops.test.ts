import { describe, expect, test } from 'bun:test'

import { parseDashboard, type ChartBlock, type Dashboard, type DataBlock, type KpiBlock, type TableBlock } from './data'
import {
  addRow,
  addSource,
  bindChart,
  bindKpi,
  bindTable,
  blockSpan,
  chartTypesFor,
  duplicateBlock,
  insertBlock,
  removeDataset,
  removeRow,
  setBlockSpan,
  setCell,
  starterBlock,
} from './data-ops'

const dash = (): Dashboard => ({
  version: 1,
  title: 'T',
  layout: 'grid',
  sources: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  datasets: [
    {
      id: 'weekly',
      sourceId: 'a',
      columns: [
        { key: 'week', label: 'Week', type: 'date' },
        { key: 'users', label: 'Users', type: 'number' },
        { key: 'rev', label: 'Revenue', type: 'currency' },
        { key: 'platform', label: 'Platform', type: 'string' },
      ],
      rows: [
        { week: '2026-11-02', users: 10, rev: 5, platform: 'Web' },
        { week: '2026-11-09', users: 12, rev: 6, platform: 'CLI' },
      ],
    },
    {
      id: 'plans',
      sourceId: 'b',
      columns: [
        { key: 'plan', label: 'Plan', type: 'string' },
        { key: 'seats', label: 'Seats', type: 'number' },
      ],
      rows: [{ plan: 'Pro', seats: 3 }],
    },
  ],
  blocks: [
    { kind: 'kpi', id: 'k', label: 'Users', datasetId: 'weekly', value: { column: 'users', agg: 'sum' }, sparkline: 'week', delta: { vs: 'previous', format: 'percent' }, format: 'compact', sourceId: 'a' },
    { kind: 'chart', id: 'c', title: 'Users', type: 'line', datasetId: 'weekly', x: 'week', series: [{ key: 'users', label: 'People' }], sourceId: 'a' },
    { kind: 'table', id: 't', title: 'Rows', datasetId: 'weekly' },
  ],
})

const valid = (d: Dashboard) => {
  const r = parseDashboard(d)
  return r.ok ? [] : r.issues
}

const block = <T extends DataBlock = DataBlock>(d: Dashboard, id: string) => d.blocks.find((b) => b.id === id) as T

describe('span', () => {
  test('defaults by kind, and setting it keeps size in step for older readers', () => {
    const d = dash()
    expect(d.blocks.map(blockSpan)).toEqual([1, 2, 4])
    const wide = setBlockSpan(d, 'c', 3)
    expect(block<ChartBlock>(wide, 'c')).toMatchObject({ span: 3 })
    expect(blockSpan(block(wide, 'c'))).toBe(3)
    expect(setBlockSpan(d, 'k', 1)).toBe(d) // already 1
    expect(blockSpan(block(setBlockSpan(d, 'k', 9), 'k'))).toBe(4)
    expect(valid(wide)).toEqual([])
  })
})

describe('adding and duplicating', () => {
  test('every starter block is valid on a dashboard with data', () => {
    let d = dash()
    for (const kind of ['kpi', 'chart', 'table', 'text', 'section'] as const) {
      const made = starterBlock(d, kind)
      expect(made).not.toBeNull()
      d = insertBlock(d, made!)
    }
    expect(d.blocks).toHaveLength(8)
    expect(new Set(d.blocks.map((b) => b.id)).size).toBe(8)
    expect(valid(d)).toEqual([])
    // Bound to a chosen dataset, it takes that dataset's source.
    expect(starterBlock(d, 'chart', 'plans')).toMatchObject({ datasetId: 'plans', sourceId: 'b', x: 'plan', type: 'bar' })
  })

  test('with no datasets: a KPI is a literal on the first source; charts and tables cannot start', () => {
    const empty: Dashboard = { ...dash(), datasets: [], blocks: [{ kind: 'text', id: 'x', markdown: 'hi' }] }
    const kpi = starterBlock(empty, 'kpi')
    expect(kpi).toMatchObject({ value: { literal: 0 }, sourceId: 'a' })
    expect(valid(insertBlock(empty, kpi!))).toEqual([])
    expect(starterBlock(empty, 'chart')).toBeNull()
    expect(starterBlock(empty, 'table')).toBeNull()
  })

  test('insertBlock puts it after a block, and refuses a taken id', () => {
    const d = dash()
    const made = starterBlock(d, 'text')!
    expect(insertBlock(d, made, 'k').blocks.map((b) => b.id)).toEqual(['k', made.id, 'c', 't'])
    expect(insertBlock(d, { ...made, id: 'k' })).toBe(d)
  })

  test('duplicateBlock copies after the original with a fresh id', () => {
    const d = dash()
    const { dashboard, id } = duplicateBlock(d, 'c')
    expect(id).toBe('c-copy')
    expect(dashboard.blocks.map((b) => b.id)).toEqual(['k', 'c', 'c-copy', 't'])
    expect(block<ChartBlock>(dashboard, 'c-copy').title).toBe('Users (copy)')
    expect(duplicateBlock(dashboard, 'c').id).toBe('c-copy_2')
    expect(valid(dashboard)).toEqual([])
    expect(duplicateBlock(d, 'nope').id).toBeNull()
  })
})

describe('binding', () => {
  test('a KPI moved to another dataset takes its source, and drops a "previous" delta without a sparkline', () => {
    const d = dash()
    const kpi = block<KpiBlock>(d, 'k')
    const next = bindKpi(d, kpi, { datasetId: 'plans', column: 'seats', agg: 'avg', format: 'integer', sparkline: null, compare: true, display: 'trend' })!
    expect(next).toMatchObject({ datasetId: 'plans', sourceId: 'b', value: { column: 'seats', agg: 'avg' } })
    expect(next.delta).toBeUndefined()
    expect(next.display).toBeUndefined()
    expect(next.sparkline).toBeUndefined()
    expect(valid({ ...d, blocks: [next, ...d.blocks.slice(1)] })).toEqual([])
  })

  test('a ratio stays a ratio, and a target delta survives, when only the trend or display changes', () => {
    const d = dash()
    const ratio: KpiBlock = {
      kind: 'kpi',
      id: 'k',
      label: 'Revenue per user',
      datasetId: 'weekly',
      value: { ratio: { numerator: { column: 'rev', agg: 'sum' }, denominator: { column: 'users', agg: 'sum' } } },
      sparkline: 'week',
      delta: { vs: 0.5, format: 'absolute', label: 'vs goal' },
      format: 'currency',
      sourceId: 'a',
    }
    const next = bindKpi(d, ratio, { datasetId: 'weekly', column: 'rev', agg: 'sum', format: 'currency', sparkline: null, compare: false, display: 'tile' })!
    expect(next.value).toEqual(ratio.value)
    expect(next.delta).toEqual(ratio.delta)
    expect(next.sparkline).toBeUndefined()
    // Changing the measure itself makes it a single measure.
    const changed = bindKpi(d, ratio, { datasetId: 'weekly', column: 'rev', agg: 'avg', format: 'currency', sparkline: 'week', compare: true, display: 'tile' })!
    expect(changed.value).toEqual({ column: 'rev', agg: 'avg' })
    expect(changed.delta).toEqual(ratio.delta) // the target wins over "previous"
    expect(valid({ ...d, blocks: [next, ...d.blocks.slice(1)] })).toEqual([])
  })

  test('a KPI on a string column falls back to count', () => {
    const d = dash()
    const next = bindKpi(d, block(d, 'k'), { datasetId: 'weekly', column: 'platform', agg: 'sum', format: 'number', sparkline: 'week', compare: true, display: 'tile' })!
    expect(next.value).toEqual({ column: 'platform', agg: 'count' })
    expect(next.delta?.vs).toBe('previous')
  })

  test('chart rules: split keeps one series, rules out pie; series keep their labels; non-numeric series drop', () => {
    const d = dash()
    const chart = block<ChartBlock>(d, 'c')
    const split = bindChart(d, chart, { datasetId: 'weekly', type: 'pie', x: 'week', series: ['users', 'rev'], agg: 'sum', split: 'platform' })!
    expect(split.series).toEqual([{ key: 'users', label: 'People' }])
    expect(split.type).toBe('bar')
    expect(split.split).toBe('platform')

    const combo = bindChart(d, chart, { datasetId: 'weekly', type: 'combo', x: 'week', series: ['users', 'rev', 'platform'], agg: 'avg', split: null })!
    expect(combo.series.map((s) => s.key)).toEqual(['users', 'rev'])
    expect(combo.type).toBe('combo')
    expect(combo.agg).toBe('avg')

    const moved = bindChart(d, chart, { datasetId: 'plans', type: 'scatter', x: 'nope', series: ['users'], agg: 'sum', split: null })!
    expect(moved).toMatchObject({ datasetId: 'plans', sourceId: 'b', x: 'plan', series: [{ key: 'seats', label: 'Seats' }] })
    expect(moved.type).toBe('bar') // scatter needs a numeric x
    for (const b of [split, combo, moved]) expect(valid({ ...d, blocks: [d.blocks[0], b, d.blocks[2]] })).toEqual([])
  })

  test('chartTypesFor', () => {
    expect(chartTypesFor('date', true, 1)).not.toContain('pie')
    expect(chartTypesFor('string', false, 1)).not.toContain('combo')
    expect(chartTypesFor('string', false, 2)).toContain('combo')
    expect(chartTypesFor('number', false, 1)).toContain('scatter')
  })

  test('a table keeps only columns that exist; heatmap only numeric ones', () => {
    const d = dash()
    const next = bindTable(d, block<TableBlock>(d, 't'), { datasetId: 'weekly', columns: ['week', 'users', 'gone'], heatmap: ['users', 'platform'] })!
    expect(next.columns).toEqual(['week', 'users'])
    expect(next.heatmap).toEqual(['users'])
    const all = bindTable(d, block<TableBlock>(d, 't'), { datasetId: 'plans', columns: ['plan', 'seats'], heatmap: [] })!
    expect(all.columns).toBeUndefined()
    expect(all.datasetId).toBe('plans')
  })
})

describe('sources and rows', () => {
  test('addSource makes a unique id', () => {
    const one = addSource(dash(), { label: 'A', detail: ' how ' })
    expect(one.id).toBe('a_2')
    expect(one.dashboard.sources[2]).toEqual({ id: 'a_2', label: 'A', detail: 'how' })
    expect(addSource(dash(), { label: '  ' }).id).toBeNull()
    expect(valid(one.dashboard)).toEqual([])
  })

  test('setCell reads text as the column type and refuses what does not fit', () => {
    const d = dash()
    const next = setCell(d, 'weekly', 0, 'rev', '$1,250.5')
    expect(next.datasets[0].rows[0].rev).toBe(1250.5)
    expect(setCell(d, 'weekly', 0, 'users', 'many')).toBe(d)
    expect(setCell(d, 'weekly', 0, 'users', '10')).toBe(d) // unchanged
    expect(setCell(d, 'weekly', 0, 'week', '11/30/2026').datasets[0].rows[0].week).toBe('2026-11-30')
  })

  test('add and remove rows; a dataset in use cannot be removed', () => {
    const d = dash()
    const added = addRow(d, 'plans')
    expect(added.datasets[1].rows[1]).toEqual({ plan: null, seats: null })
    expect(removeRow(added, 'plans', 0).datasets[1].rows).toEqual([{ plan: null, seats: null }])
    expect(removeDataset(d, 'weekly')).toBe(d)
    expect(removeDataset(d, 'plans').datasets.map((x) => x.id)).toEqual(['weekly'])
  })
})
