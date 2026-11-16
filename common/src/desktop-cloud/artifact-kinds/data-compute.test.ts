import { describe, expect, test } from 'bun:test'

import { parseDashboard, type Dashboard } from './data'
import { describeRefresh, describeRefreshAll } from './data-recipe'
import {
  chartData,
  chartFacets,
  dashboardChecks,
  dashboardReadout,
  datasetFreshness,
  defaultFilterState,
  explainCell,
  explainChartPoint,
  filterRows,
  formatAge,
  isOtherRow,
  linearFit,
  logScaleUsable,
  OTHER_LABEL,
  searchRows,
  staleDatasets,
  tableTotals,
  toTsv,
  tsvCell,
} from './data-compute'
import { importDataset, tableFromJson } from './data-import'

const NOW = Date.parse('2026-11-16T20:00:00Z')

function dashboard(): Dashboard {
  return {
    version: 1,
    title: 'Sales',
    layout: 'grid',
    sources: [{ id: 'wh', label: 'Warehouse' }],
    datasets: [
      {
        id: 'sales',
        sourceId: 'wh',
        title: 'Sales by region',
        columns: [
          { key: 'region', label: 'Region', type: 'string' },
          { key: 'week', label: 'Week', type: 'date' },
          { key: 'revenue', label: 'Revenue', type: 'currency' },
          { key: 'users', label: 'Users', type: 'number' },
        ],
        rows: [
          { region: 'West', week: '2026-11-02', revenue: 100, users: 10 },
          { region: 'East', week: '2026-11-02', revenue: 40, users: 4 },
          { region: 'North', week: '2026-11-02', revenue: 20, users: 2 },
          { region: 'South', week: '2026-11-02', revenue: 10, users: 0 },
          { region: 'West', week: '2026-11-09', revenue: 120, users: 12 },
          { region: 'East', week: '2026-11-09', revenue: 50, users: 5 },
        ],
        calculated: [{ key: 'arpu', label: 'Revenue per user', type: 'currency', expr: '[revenue] / [users]' }],
        provenance: { query: 'select region, week, sum(revenue) …', fetchedAt: '2026-11-14T18:00:00Z', runId: 'run-7' },
        refresh: { recipe: 'Rerun the weekly revenue query', file: 'queries/revenue.sql', staleAfterHours: 24 },
      },
    ],
    blocks: [
      { kind: 'kpi', id: 'rev', label: 'Revenue', datasetId: 'sales', value: { column: 'revenue', agg: 'sum' }, format: 'currency', sourceId: 'wh' },
      { kind: 'chart', id: 'by-region', title: 'By region', type: 'bar', datasetId: 'sales', x: 'region', series: [{ key: 'revenue', label: 'Revenue' }], sourceId: 'wh', topN: 2 },
      { kind: 'table', id: 'rows', title: 'Rows', datasetId: 'sales' },
    ],
    filters: [{ id: 'region', label: 'Region', datasetIds: ['sales'], column: 'region', type: 'select', multiple: true }],
  }
}

describe('schema (round 4 fields stay additive)', () => {
  test('provenance, refresh and the new chart/table/filter fields validate', () => {
    expect(parseDashboard(dashboard()).ok).toBe(true)
  })

  test('misplaced options are refused with a path', () => {
    const d = dashboard()
    d.blocks[1] = { ...d.blocks[1], type: 'line', x: 'week', topN: 2, scale: 'log', stack: 'percent' } as Dashboard['blocks'][number]
    const result = parseDashboard(d)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.startsWith('blocks.1.topN'))).toBe(true)
      expect(result.issues.some((i) => i.startsWith('blocks.1.stack'))).toBe(true)
    }
  })

  test('a multi-value date-range filter and a format on a text column are refused', () => {
    const d = dashboard()
    d.filters = [{ id: 'w', label: 'W', datasetIds: ['sales'], column: 'week', type: 'date-range', multiple: true }]
    d.blocks[2] = { kind: 'table', id: 'rows', title: 'Rows', datasetId: 'sales', formats: { region: 'number' } }
    const result = parseDashboard(d)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.startsWith('filters.0.multiple'))).toBe(true)
      expect(result.issues.some((i) => i.startsWith('blocks.2.formats.region'))).toBe(true)
    }
  })
})

describe('freshness', () => {
  test('a dataset past its threshold is stale; its age reads in words', () => {
    const d = dashboard()
    const f = datasetFreshness(d, d.datasets[0], NOW)
    expect(f.own).toBe(true)
    expect(f.ageHours).toBe(50)
    expect(f.stale).toBe(true)
    expect(f.age).toBe('2 days ago')
    expect(staleDatasets(d, NOW)).toEqual(['sales'])
  })

  test('no threshold is never stale; a date-only asOf ages from the end of that day', () => {
    const d = dashboard()
    delete d.datasets[0].refresh
    delete d.datasets[0].provenance
    d.asOf = '2026-11-16'
    const f = datasetFreshness(d, d.datasets[0], NOW)
    expect(f.own).toBe(false)
    expect(f.stale).toBe(false)
    expect(f.ageHours).toBe(0)
  })

  test('formatAge', () => {
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(0.5)).toBe('30 minutes ago')
    expect(formatAge(1)).toBe('1 hour ago')
    expect(formatAge(72)).toBe('3 days ago')
  })
})

describe('refresh prompts', () => {
  test('one dataset: names the artifact, the dataset, the recipe, the file and how to write back', () => {
    const text = describeRefresh(dashboard(), 'sales', { artifactId: 'art_1', now: NOW })
    expect(text).toContain('artifact id art_1')
    expect(text).toContain('(id sales)')
    expect(text).toContain('Rerun the weekly revenue query')
    expect(text).toContain('queries/revenue.sql')
    expect(text).toContain('setDatasetRows')
    expect(text).toContain('(stale)')
    expect(text).toContain('do not write them')
  })

  test('refresh all keeps every id under the limit, clipping recipes first', () => {
    const d = dashboard()
    d.datasets[0].refresh = { recipe: 'x'.repeat(2000) }
    d.datasets.push({ ...d.datasets[0], id: 'sales2', refresh: { recipe: 'y'.repeat(2000) } })
    const text = describeRefreshAll(d, ['sales', 'sales2'], { artifactId: 'art_1', limit: 1500 })
    expect(text.length).toBeLessThanOrEqual(1500)
    expect(text).toContain('"dataset": "sales"')
    expect(text).toContain('"dataset": "sales2"')
    expect(text).toContain('artifact id art_1')
  })
})

describe('charts', () => {
  test('topN keeps the largest categories and folds the rest into Other, last', () => {
    const d = dashboard()
    const block = d.blocks[1] as Extract<Dashboard['blocks'][number], { kind: 'chart' }>
    const data = chartData(d, block, defaultFilterState(d))
    expect(data.rows.map((r) => r.x)).toEqual(['West', 'East', OTHER_LABEL])
    expect(data.rows[2].s0).toBe(30)
    expect(isOtherRow(data.rows[2])).toBe(true)
    expect(isOtherRow(data.rows[0])).toBe(false)
  })

  test('value sort orders categories; a trendline is a fitted series', () => {
    const d = dashboard()
    const block = { ...(d.blocks[1] as Extract<Dashboard['blocks'][number], { kind: 'chart' }>), topN: undefined, sort: 'value-asc' as const, trendline: true }
    const data = chartData(d, block, {})
    expect(data.rows.map((r) => r.x)).toEqual(['South', 'North', 'East', 'West'])
    expect(data.series.at(-1)).toMatchObject({ key: 't0', trend: true })
    expect(data.rows[0].t0).toBeCloseTo(-20, 6)
  })

  test('linearFit and logScaleUsable', () => {
    expect(linearFit([[0, 1], [1, 3], [2, 5]])).toEqual({ slope: 2, intercept: 1 })
    expect(linearFit([[1, 1], [1, 2]])).toBeNull()
    expect(logScaleUsable({ rows: [{ x: 'a', s0: 1 }], series: [{ key: 's0', label: 'A' }], xType: 'string' })).toBe(true)
    expect(logScaleUsable({ rows: [{ x: 'a', s0: 0 }], series: [{ key: 's0', label: 'A' }], xType: 'string' })).toBe(false)
  })

  test('facets: one chart per value, dates ascending', () => {
    const d = dashboard()
    const block = { ...(d.blocks[1] as Extract<Dashboard['blocks'][number], { kind: 'chart' }>), topN: undefined, facet: 'week' }
    const facets = chartFacets(d, block, {})
    expect(facets.map((f) => f.key)).toEqual(['2026-11-02', '2026-11-09'])
    expect(facets[1].data.rows.map((r) => r.x)).toEqual(['West', 'East'])
  })

  test('explainChartPoint says how the point is worked out', () => {
    const d = dashboard()
    const block = d.blocks[1] as Extract<Dashboard['blocks'][number], { kind: 'chart' }>
    expect(explainChartPoint(d, block, {}, 'West')).toBe('Sum of Revenue over 2 rows where Region is West.')
  })
})

describe('filters', () => {
  test('a multi-select filter keeps rows matching any chosen value', () => {
    const d = dashboard()
    expect(defaultFilterState(d).region).toEqual({ kind: 'multi', values: [] })
    const rows = filterRows(d.datasets[0], d.filters, { region: { kind: 'multi', values: ['East', 'South'] } })
    expect(rows.map((r) => r.region)).toEqual(['East', 'South', 'East'])
  })
})

describe('tables', () => {
  test('totals sum numbers and average percents; search matches shown text', () => {
    const d = dashboard()
    const columns = [...d.datasets[0].columns, { key: 'share', label: 'Share', type: 'percent' as const }]
    const rows = d.datasets[0].rows.map((r, i) => ({ ...r, share: i % 2 ? 0.2 : 0.4 }))
    const totals = tableTotals(columns, rows)
    expect(totals.get('revenue')).toEqual({ value: 340, agg: 'sum' })
    expect(totals.get('share')?.agg).toBe('avg')
    expect(totals.get('share')?.value).toBeCloseTo(0.3, 9)
    expect(totals.has('region')).toBe(false)
    expect(tableTotals(columns, rows, new Set(['revenue'])).has('revenue')).toBe(false)
    expect(searchRows(rows, columns, 'west nov 9').length).toBe(1)
  })

  test('TSV flattens tabs and guards formulas', () => {
    expect(tsvCell('a\tb\nc')).toBe('a b c')
    expect(tsvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    // One rule with export-safe.ts: leading whitespace does not hide a formula; numbers stay values.
    expect(tsvCell(' =SUM(A1)')).toBe("' =SUM(A1)")
    expect(tsvCell('\t=x')).toBe("' =x")
    expect(tsvCell({ text: '-5', numeric: true })).toBe('-5')
    expect(toTsv(['A', 'B'], [['-x', { text: '-2', numeric: true }]])).toBe("A\tB\n'-x\t-2")
  })

  test('explainCell names a calculation or the stored source', () => {
    const d = dashboard()
    expect(explainCell(d, 'sales', 'arpu')).toBe('Revenue per user is calculated for each row: [revenue] / [users].')
    expect(explainCell(d, 'sales', 'revenue')).toBe('Revenue is a stored value in Sales by region, from Warehouse.')
  })
})

describe('agent readout', () => {
  test('checks first, then freshness, KPI values and chart series; capped', () => {
    const d = dashboard()
    const text = dashboardReadout(d, NOW)
    const lines = text.split('\n')
    expect(lines[0]).toStartWith('Checks: dataset sales is stale')
    expect(text).toContain('sales fetched 2026-11-14T18:00:00Z STALE, recipe (stale after 24h)')
    expect(text).toContain('kpi rev = $340 (raw 340), 6 rows')
    expect(text).toContain('chart by-region (bar) 3 points: Revenue: total $340')
    expect(text).toContain('table rows: 6 rows')
    expect(dashboardReadout(d, NOW, 80).length).toBeLessThanOrEqual(80)
  })

  test('checks catch an empty calculation and a log scale over zero', () => {
    const d = dashboard()
    d.datasets[0].calculated = [{ key: 'bad', label: 'Bad', type: 'number', expr: '[users] / 0' }]
    d.blocks[1] = { ...(d.blocks[1] as Extract<Dashboard['blocks'][number], { kind: 'chart' }>), topN: undefined, x: 'region', series: [{ key: 'users', label: 'Users' }], scale: 'log' }
    const { materializeDashboard } = require('./data-calc') as typeof import('./data-calc')
    const checks = dashboardChecks(materializeDashboard(d), NOW)
    expect(checks.some((c) => c.includes('sales.bad is empty'))).toBe(true)
    expect(checks.some((c) => c.includes('log scale'))).toBe(true)
  })
})

describe('JSON import', () => {
  test('rows of objects become a typed dataset', () => {
    expect(tableFromJson('[{"a":1,"b":"x"},{"b":"y","c":true}]')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x', ''],
      ['', 'y', 'true'],
    ])
    expect(tableFromJson('a,b\n1,2')).toBeNull()
    expect(tableFromJson('[{"a":{"b":1}}]')).toEqual({ error: expect.stringContaining('nested') })
    const made = importDataset(dashboard(), { text: '{"rows":[{"day":"2026-11-01","n":"12%"}]}', title: 'Pct' })
    expect(made.ok).toBe(true)
    if (made.ok) expect(made.dashboard.datasets.at(-1)?.columns.map((c) => c.type)).toEqual(['date', 'percent'])
  })
})

describe('type switches keep only the options the new type can draw', () => {
  test('a stack and top N drop on a line over dates; a log scale and trendline stay', async () => {
    const { keepChartOptions } = await import('./data-ops')
    const d = dashboard()
    const old = { ...(d.blocks[1] as Extract<Dashboard['blocks'][number], { kind: 'chart' }>), stack: 'normal' as const, scale: 'log' as const, trendline: true, facet: 'week' }
    const next = keepChartOptions({ ...old, type: 'line', x: 'week' }, old, d.datasets[0])
    expect(next.stack).toBeUndefined()
    expect(next.topN).toBeUndefined()
    expect(next.facet).toBeUndefined()
    expect(next.scale).toBe('log')
    expect(next.trendline).toBe(true)
    expect(parseDashboard({ ...d, blocks: [d.blocks[0], next, d.blocks[2]] }).ok).toBe(true)
  })
})
