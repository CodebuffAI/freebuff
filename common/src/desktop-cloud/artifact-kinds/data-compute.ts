/**
 * Freebuff Data: the pure logic behind a dashboard, shared by the app and the server (the
 * agent's `read_artifact` readout). Filtering, aggregation, KPI values and deltas, chart
 * series, sorting, number and date formatting, freshness, and the plain-text summaries "Ask
 * Buffy" hands the chat. No React, no DOM.
 *
 * Formatting is pinned to `en-US` and dates are read as UTC calendar days, so a dashboard
 * reads the same on every machine; anything time-dependent takes `now` as an argument.
 */

import { formulaSafeCell } from './export-safe'
import { MAX_FACETS, type DatasetRefresh, type RecipeHow } from './data'
import { materializeDashboard } from './data-calc'
import { certification, datasetDoubts } from './data-trust'
import type {
  Agg,
  Cell,
  ChartBlock,
  ColumnType,
  Dashboard,
  DataBlock,
  DataColumn,
  DataFilter,
  DataRow,
  Dataset,
  KpiBlock,
  KpiValue,
  Measure,
  TableBlock,
  ValueFormat,
} from './data'
import { isNumericType } from './data'

// ---- The reader's state (never part of the stored body)

/** One filter-bar choice: a select's value (or values), or a date range's ends. */
export type FilterChoice =
  | { kind: 'select'; value: string | null }
  | { kind: 'multi'; values: string[] }
  | { kind: 'date-range'; from: string | null; to: string | null }

/**
 * A click on a chart mark: every dataset with `column` shows only rows where it is `value`.
 * The chart clicked keeps all its marks (the chosen one highlighted).
 */
export type CrossFilter = { kind: 'cross'; column: string; value: string; label: string; fromBlockId: string }

/** "Compare to previous period": KPIs measure their change against the window before the range. */
export type CompareChoice = { kind: 'compare'; on: boolean }

/** Reserved keys in FilterState (filter ids are letters, digits, "-" and "_", so never these). */
export const CROSS_KEY = '__cross'
export const COMPARE_KEY = '__compare'

/**
 * What a reader has chosen, by filter id, plus the click filter (`CROSS_KEY`) and the compare
 * toggle (`COMPARE_KEY`). Never saved to the dashboard.
 */
export type FilterState = Record<string, FilterChoice | CrossFilter | CompareChoice>

const LOCALE = 'en-US'
export const EMPTY = '—'

// ---- Lookup

export function findDataset(dashboard: Dashboard, datasetId: string | undefined): Dataset | undefined {
  return datasetId === undefined ? undefined : dashboard.datasets.find((d) => d.id === datasetId)
}

export function findColumn(dataset: Dataset | undefined, key: string): DataColumn | undefined {
  return dataset?.columns.find((c) => c.key === key)
}

export function findSource(dashboard: Dashboard, sourceId: string | undefined) {
  return sourceId === undefined ? undefined : dashboard.sources.find((s) => s.id === sourceId)
}

/** The source a block's numbers come from: its own, else its dataset's. */
export function blockSourceId(dashboard: Dashboard, block: DataBlock): string | undefined {
  if (block.kind === 'kpi' || block.kind === 'chart') return block.sourceId
  if (block.kind === 'table') return block.sourceId ?? findDataset(dashboard, block.datasetId)?.sourceId
  return undefined
}

export function blockDatasetId(block: DataBlock): string | undefined {
  if (block.kind === 'kpi' || block.kind === 'chart' || block.kind === 'table') return block.datasetId
  return undefined
}

// ---- Filters

/** Every filter at its default: a select at its `default` (or all), a date range open. */
export function defaultFilterState(dashboard: Dashboard): FilterState {
  const state: FilterState = {}
  for (const filter of dashboard.filters ?? []) {
    state[filter.id] =
      filter.type === 'select'
        ? filter.multiple
          ? { kind: 'multi', values: filter.default ? [filter.default] : [] }
          : { kind: 'select', value: filter.default ?? null }
        : { kind: 'date-range', from: null, to: null }
  }
  return state
}

export function isFilterActive(state: FilterState[string] | undefined): boolean {
  if (!state) return false
  switch (state.kind) {
    case 'select':
      return state.value !== null
    case 'multi':
      return state.values.length > 0
    case 'date-range':
      return state.from !== null || state.to !== null
    case 'cross':
      return true
    case 'compare':
      return false
  }
}

/** The click filter, when one is set. */
export function crossFilter(state: FilterState): CrossFilter | null {
  const cross = state[CROSS_KEY]
  return cross?.kind === 'cross' ? cross : null
}

/** The state a block reads: the chart that set the click filter is not filtered by it. */
export function stateForBlock(state: FilterState, blockId: string): FilterState {
  const cross = crossFilter(state)
  if (!cross || cross.fromBlockId !== blockId) return state
  const { [CROSS_KEY]: _cross, ...rest } = state
  return rest
}

/** Rows of one dataset that pass every active filter listing it, and the click filter. */
export function filterRows(dataset: Dataset, filters: DataFilter[] | undefined, state: FilterState): DataRow[] {
  const active = (filters ?? []).filter(
    (f) => f.datasetIds.includes(dataset.id) && isFilterActive(state[f.id]),
  )
  const cross = crossFilter(state)
  const crossColumn = cross && dataset.columns.some((c) => c.key === cross.column) ? cross : null
  if (active.length === 0 && !crossColumn) return dataset.rows
  return dataset.rows.filter((row) => {
    if (crossColumn) {
      const cell = row[crossColumn.column]
      if (cell === null || cell === undefined || String(cell) !== crossColumn.value) return false
    }
    return active.every((filter) => {
      const choice = state[filter.id]
      const cell = row[filter.column]
      if (cell === null || cell === undefined) return false
      if (choice.kind === 'select') return String(cell) === choice.value
      if (choice.kind === 'multi') return choice.values.includes(String(cell))
      if (choice.kind !== 'date-range') return true
      const value = String(cell)
      if (choice.from !== null && value < choice.from) return false
      if (choice.to !== null && value > choice.to) return false
      return true
    })
  })
}

// ---- Date ranges: presets and the period before

const DAY_MS = 86_400_000

/** An ISO day moved by `days` (negative goes back). */
export function addDays(iso: string, days: number): string {
  const date = utcDate(iso)
  if (!date) return iso
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

/** Days from `from` to `to`, both counted. */
export function daySpan(from: string, to: string): number {
  const a = utcDate(from)
  const b = utcDate(to)
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1
}

export const DATE_PRESETS = [
  { id: 'last-7', label: 'Last 7 days' },
  { id: 'last-28', label: 'Last 28 days' },
  { id: 'last-90', label: 'Last 90 days' },
  { id: 'month', label: 'This month' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'ytd', label: 'Year to date' },
] as const
export type DatePreset = (typeof DATE_PRESETS)[number]['id']

/**
 * A preset's range, counted back from the LATEST date in the data (a dashboard is a snapshot:
 * "last 28 days" means the 28 days the data ends with, not the 28 before today).
 */
export function presetRange(preset: DatePreset, bounds: { min: string; max: string }): { from: string; to: string } {
  const to = bounds.max
  const [y, m] = to.split('-')
  let from = to
  switch (preset) {
    case 'last-7':
      from = addDays(to, -6)
      break
    case 'last-28':
      from = addDays(to, -27)
      break
    case 'last-90':
      from = addDays(to, -89)
      break
    case 'month':
      from = `${y}-${m}-01`
      break
    case 'quarter': {
      const q = Math.floor((Number(m) - 1) / 3) * 3 + 1
      from = `${y}-${String(q).padStart(2, '0')}-01`
      break
    }
    case 'ytd':
      from = `${y}-01-01`
      break
  }
  return { from: from < bounds.min ? bounds.min : from, to }
}

/** Which preset a range is, if any. */
export function matchPreset(range: { from: string | null; to: string | null }, bounds: { min: string; max: string } | null): DatePreset | null {
  if (!bounds || range.from === null) return null
  for (const p of DATE_PRESETS) {
    const r = presetRange(p.id, bounds)
    if (r.from === range.from && (range.to ?? bounds.max) === r.to) return p.id
  }
  return null
}

/**
 * The window just before a dataset's active date range, the same number of days long, as a
 * state to measure against; null when no date range on that dataset is narrowed.
 */
export function previousPeriod(
  dashboard: Dashboard,
  datasetId: string | undefined,
  state: FilterState,
): { state: FilterState; from: string; to: string; column: string; days: number } | null {
  if (!datasetId) return null
  for (const filter of dashboard.filters ?? []) {
    const choice = state[filter.id]
    if (filter.type !== 'date-range' || !filter.datasetIds.includes(datasetId)) continue
    if (!choice || choice.kind !== 'date-range' || !isFilterActive(choice)) continue
    const bounds = dateBounds(dashboard, filter)
    const from = choice.from ?? bounds?.min
    const to = choice.to ?? bounds?.max
    if (!from || !to) continue
    const length = daySpan(from, to)
    if (length <= 0) continue
    const prevTo = addDays(from, -1)
    const prevFrom = addDays(from, -length)
    return {
      state: { ...state, [filter.id]: { kind: 'date-range', from: prevFrom, to: prevTo }, [COMPARE_KEY]: { kind: 'compare', on: false } },
      from: prevFrom,
      to: prevTo,
      column: filter.column,
      days: length,
    }
  }
  return null
}

export const compareOn = (state: FilterState) => {
  const choice = state[COMPARE_KEY]
  return choice?.kind === 'compare' && choice.on
}

export function datasetRows(dashboard: Dashboard, datasetId: string | undefined, state: FilterState): DataRow[] {
  const dataset = findDataset(dashboard, datasetId)
  return dataset ? filterRows(dataset, dashboard.filters, state) : []
}

/** A select filter's choices: the distinct values of its column across its datasets, in order seen. */
export function filterOptions(dashboard: Dashboard, filter: DataFilter): string[] {
  const seen = new Set<string>()
  for (const id of filter.datasetIds) {
    for (const row of findDataset(dashboard, id)?.rows ?? []) {
      const cell = row[filter.column]
      if (cell !== null && cell !== undefined) seen.add(String(cell))
    }
  }
  return [...seen]
}

/** The earliest and latest date in a date-range filter's column, across its datasets. */
export function dateBounds(dashboard: Dashboard, filter: DataFilter): { min: string; max: string } | null {
  let min: string | null = null
  let max: string | null = null
  for (const id of filter.datasetIds) {
    for (const row of findDataset(dashboard, id)?.rows ?? []) {
      const cell = row[filter.column]
      if (typeof cell !== 'string') continue
      if (min === null || cell < min) min = cell
      if (max === null || cell > max) max = cell
    }
  }
  return min !== null && max !== null ? { min, max } : null
}

// ---- Aggregation

/** Combine a column's cells. Nulls are skipped; nothing to combine is `null`, never 0. */
export function aggregate(cells: Cell[], agg: Agg): number | null {
  if (agg === 'count') return cells.filter((c) => c !== null && c !== undefined).length
  const values = cells.filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
  if (values.length === 0) return null
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'last':
      return values[values.length - 1]
  }
}

export function measure(rows: DataRow[], m: Measure): number | null {
  return aggregate(
    rows.map((row) => row[m.column] ?? null),
    m.agg,
  )
}

export function kpiValue(rows: DataRow[], value: KpiValue): number | null {
  if ('literal' in value) return value.literal
  if ('ratio' in value) {
    const numerator = measure(rows, value.ratio.numerator)
    const denominator = measure(rows, value.ratio.denominator)
    if (numerator === null || denominator === null || denominator === 0) return null
    return numerator / denominator
  }
  return measure(rows, value)
}

export type Group = { key: string | number; rows: DataRow[] }

/**
 * Rows grouped by one column. `sorted` orders groups ascending (numbers numerically, strings
 * and ISO dates lexically); otherwise groups keep the order their key first appears in.
 * Rows with no value in the column are left out.
 */
export function groupRows(rows: DataRow[], column: string, sorted: boolean): Group[] {
  const groups = new Map<string | number, DataRow[]>()
  for (const row of rows) {
    const key = row[column]
    if (key === null || key === undefined) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  const out = [...groups].map(([key, groupRowsList]) => ({ key, rows: groupRowsList }))
  if (sorted) out.sort((a, b) => compareCells(a.key, b.key))
  return out
}

function compareCells(a: Cell, b: Cell): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), LOCALE)
}

// ---- KPIs

export type DeltaResult = {
  /** Relative change (0.062 = +6.2%) for `percent`, the difference for `absolute`. */
  change: number
  direction: 'up' | 'down' | 'flat'
  sentiment: 'good' | 'bad' | 'neutral'
  /** "+6.2%", "−1,204", "+1.2 pp". */
  text: string
  /** "vs Nov 2", "vs goal". */
  label: string
}

export type KpiResult = {
  value: number | null
  /** The comparison value: the previous period's, or the target. */
  base: number | null
  delta: DeltaResult | null
  /** One point per sparkline group, oldest first. Empty without a sparkline. */
  trend: Array<{ key: string | number; value: number | null }>
  /** The latest group's key, when the tile shows one period. */
  period: string | number | null
  /** How many rows went into the value. */
  rowCount: number
}

export function kpiResult(dashboard: Dashboard, block: KpiBlock, state: FilterState): KpiResult {
  const rows = datasetRows(dashboard, block.datasetId, state)
  const dataset = findDataset(dashboard, block.datasetId)
  const sparkType = block.sparkline ? findColumn(dataset, block.sparkline)?.type : undefined

  let value: number | null
  let previous: number | null = null
  let previousKey: string | number | null = null
  let period: string | number | null = null
  let rowCount = rows.length
  let trend: KpiResult['trend'] = []

  if (block.sparkline && !('literal' in block.value)) {
    const groups = groupRows(rows, block.sparkline, true)
    trend = groups.map((g) => ({ key: g.key, value: kpiValue(g.rows, block.value) }))
    const last = groups[groups.length - 1]
    const before = groups[groups.length - 2]
    value = last ? kpiValue(last.rows, block.value) : null
    period = last?.key ?? null
    rowCount = last?.rows.length ?? 0
    if (before) {
      previous = kpiValue(before.rows, block.value)
      previousKey = before.key
    }
  } else {
    value = kpiValue(rows, block.value)
  }

  let base: number | null = null
  let defaultLabel = ''
  if (block.delta) {
    if (block.delta.vs === 'previous') {
      base = previous
      defaultLabel =
        previousKey === null ? '' : `vs ${formatKey(previousKey, sparkType ?? 'string', true)}`
    } else {
      base = block.delta.vs
      defaultLabel = `vs ${formatValue(block.delta.vs, block.format, dashboard.currency)}`
    }
  }

  const delta =
    block.delta && value !== null && base !== null
      ? computeDelta(value, base, {
          format: block.delta.format,
          good: block.delta.good ?? 'up',
          valueFormat: block.format,
          currency: dashboard.currency,
          label: block.delta.label ?? defaultLabel,
        })
      : null

  // Compare to previous period: the same measure over the window before the range wins over the
  // block's own comparison.
  if (compareOn(state) && !('literal' in block.value) && value !== null) {
    const before = previousPeriod(dashboard, block.datasetId, state)
    const previousValue = before ? kpiResult(dashboard, block, before.state).value : null
    if (before && previousValue !== null) {
      const compared = computeDelta(value, previousValue, {
        format: block.delta?.format ?? 'percent',
        good: block.delta?.good ?? 'up',
        valueFormat: block.format,
        currency: dashboard.currency,
        label: `vs ${formatDateRange(before.from, before.to)}`,
      })
      return { value, base: previousValue, delta: compared, trend, period, rowCount }
    }
  }

  return { value, base, delta, trend, period, rowCount }
}

export function computeDelta(
  value: number,
  base: number,
  options: {
    format: 'percent' | 'absolute'
    good: 'up' | 'down'
    valueFormat: ValueFormat
    currency?: string
    label: string
  },
): DeltaResult | null {
  let change: number
  if (options.format === 'percent') {
    if (base === 0) return null
    change = (value - base) / Math.abs(base)
  } else {
    change = value - base
  }
  const magnitude = (amount: number) =>
    options.format === 'percent'
      ? formatPercent(amount)
      : options.valueFormat === 'percent'
        ? `${trimNumber(amount * 100, 1)} pp`
        : formatValue(amount, options.valueFormat, options.currency)
  // A change too small to show ("+0 pp") is no change: the arrow must agree with the digits.
  if (magnitude(Math.abs(change)) === magnitude(0)) change = 0
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
  const sentiment = direction === 'flat' ? 'neutral' : direction === options.good ? 'good' : 'bad'
  const sign = change > 0 ? '+' : change < 0 ? '−' : ''
  return { change, direction, sentiment, text: `${sign}${magnitude(Math.abs(change))}`, label: options.label }
}

/** The format a KPI's number uses when the column alone decides. */
export function defaultFormat(type: ColumnType | undefined): ValueFormat {
  if (type === 'currency') return 'currency'
  if (type === 'percent') return 'percent'
  return 'number'
}

// ---- Charts

export type ChartSeries = {
  key: string
  label: string
  /** The same measure over the period before (compare to previous period), drawn dashed. */
  previous?: boolean
  /** A fitted trendline (not data): drawn thin and dashed. */
  trend?: boolean
  /** Drawn against the right-hand value axis. */
  axis?: 'right'
}
export type ChartData = {
  /** One object per x: `x` holds the x value, `s0…sN` each series' value. */
  rows: Array<Record<string, string | number | null>>
  series: ChartSeries[]
  xType: ColumnType
}

export const MAX_SPLIT_SERIES = 12

export function chartData(dashboard: Dashboard, block: ChartBlock, state: FilterState): ChartData {
  const dataset = findDataset(dashboard, block.datasetId)
  const rows = datasetRows(dashboard, block.datasetId, stateForBlock(state, block.id))
  return chartFromRows(dataset, block, rows)
}

/** The label of the bucket `topN` folds the smaller categories into. */
export const OTHER_LABEL = 'Other'

/** A chart's points from given rows (the chart's own filters already applied). */
export function chartFromRows(dataset: Dataset | undefined, block: ChartBlock, rows: DataRow[]): ChartData {
  const xType = findColumn(dataset, block.x)?.type ?? 'string'
  const agg = block.agg ?? 'sum'

  if (block.type === 'scatter') {
    const first = block.series[0]
    const points = rows
      .filter((r) => typeof r[block.x] === 'number' && typeof r[first.key] === 'number')
      .map((r) => ({ x: r[block.x] as number, s0: r[first.key] as number }))
      .sort((a, b) => a.x - b.x)
    const series: ChartSeries[] = [{ key: 's0', label: first.label }]
    if (block.trendline && points.length > 1) {
      const fit = linearFit(points.map((p) => [p.x, p.s0] as const))
      if (fit) {
        points.forEach((p) => Object.assign(p, { t0: fit.slope * p.x + fit.intercept }))
        series.push({ key: 't0', label: `${first.label} trend`, trend: true })
      }
    }
    return { rows: points, series, xType }
  }

  // Dates and numbers read left to right in order; categories keep the dataset's order.
  let groups = groupRows(rows, block.x, xType !== 'string')
  let other: DataRow[] | null = null
  // Top N: the N largest categories by the first series (all series summed when split).
  if (block.topN !== undefined && xType === 'string' && groups.length > block.topN) {
    const sizeKey = block.series[0].key
    const ranked = groups
      .map((g) => ({ g, size: aggregate(g.rows.map((r) => r[sizeKey] ?? null), agg) ?? -Infinity }))
      .sort((a, b) => b.size - a.size)
    const keep = new Set(ranked.slice(0, block.topN).map((r) => r.g))
    other = groups.filter((g) => !keep.has(g)).flatMap((g) => g.rows)
    groups = groups.filter((g) => keep.has(g))
  }
  const buckets: Array<{ key: string | number; rows: DataRow[]; other?: boolean }> = [...groups]
  if (other && other.length) buckets.push({ key: OTHER_LABEL, rows: other, other: true })

  let series: ChartSeries[]
  let out: Array<Record<string, string | number | null>>
  if (block.split) {
    const splitKey = block.split
    const values = groupRows(rows, splitKey, false)
      .slice(0, MAX_SPLIT_SERIES)
      .map((g) => String(g.key))
    series = values.map((v, i) => ({ key: `s${i}`, label: v }))
    const column = block.series[0].key
    out = buckets.map((g) => {
      const row: Record<string, string | number | null> = { x: g.key }
      if (g.other) row[OTHER_FLAG] = 1
      values.forEach((v, i) => {
        row[`s${i}`] = aggregate(
          g.rows.filter((r) => String(r[splitKey]) === v).map((r) => r[column] ?? null),
          agg,
        )
      })
      return row
    })
  } else {
    const single = block.type === 'pie' || block.type === 'donut' || block.type === 'funnel'
    series = (single ? block.series.slice(0, 1) : block.series).map((s, i) => ({
      key: `s${i}`,
      label: s.label,
      ...(s.axis === 'right' ? { axis: 'right' as const } : {}),
    }))
    const columns = block.series.map((s) => s.key)
    out = buckets.map((g) => {
      const row: Record<string, string | number | null> = { x: g.key }
      if (g.other) row[OTHER_FLAG] = 1
      series.forEach((s, i) => {
        row[s.key] = aggregate(
          g.rows.map((r) => r[columns[i]] ?? null),
          agg,
        )
      })
      return row
    })
  }

  // Sorting: "Other" always stays last.
  if (block.sort) {
    const tail = out.filter((r) => r[OTHER_FLAG])
    const head = out.filter((r) => !r[OTHER_FLAG])
    const size = (r: Record<string, string | number | null>) =>
      series.reduce((sum, s) => sum + (typeof r[s.key] === 'number' ? (r[s.key] as number) : 0), 0)
    if (block.sort === 'x') head.sort((a, b) => compareCells(a.x as Cell, b.x as Cell))
    else head.sort((a, b) => (block.sort === 'value-asc' ? size(a) - size(b) : size(b) - size(a)))
    out = [...head, ...tail]
  }

  // Trendline: a least-squares line through the first series, over the points in order.
  if (block.trendline && !block.split && out.length > 1) {
    const pairs = out.flatMap((r, i) => (typeof r.s0 === 'number' ? [[i, r.s0] as const] : []))
    const fit = linearFit(pairs)
    if (fit) {
      out = out.map((r, i) => ({ ...r, t0: fit.slope * i + fit.intercept }))
      series = [...series, { key: 't0', label: `${series[0].label} trend`, trend: true }]
    }
  }

  return { rows: out, series, xType }
}

/** Marks the "Other" row of a top-N chart: it is not one category, so it never filters or drills. */
export const OTHER_FLAG = '__other'
export const isOtherRow = (row: Record<string, unknown>) => Boolean(row[OTHER_FLAG])

/** Least squares over (x, y) pairs; null with fewer than two distinct x. */
export function linearFit(points: ReadonlyArray<readonly [number, number]>): { slope: number; intercept: number } | null {
  const n = points.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let den = 0
  for (const [x, y] of points) {
    num += (x - mx) * (y - my)
    den += (x - mx) * (x - mx)
  }
  if (den === 0) return null
  const slope = num / den
  return { slope, intercept: my - slope * mx }
}

/**
 * Small multiples: the chart drawn once per value of its `facet` column (at most MAX_FACETS,
 * in the order values first appear; dates and numbers ascending), each from that value's rows.
 */
export function chartFacets(
  dashboard: Dashboard,
  block: ChartBlock,
  state: FilterState,
): Array<{ key: string | number; label: string; data: ChartData }> {
  if (!block.facet) return []
  const dataset = findDataset(dashboard, block.datasetId)
  const rows = datasetRows(dashboard, block.datasetId, stateForBlock(state, block.id))
  const type = findColumn(dataset, block.facet)?.type ?? 'string'
  return groupRows(rows, block.facet, type !== 'string')
    .slice(0, MAX_FACETS)
    .map((g) => ({ key: g.key, label: formatKey(g.key, type), data: chartFromRows(dataset, block, g.rows) }))
}

/** A log axis cannot show zero or less: the chart then draws linear and says why. */
export function logScaleUsable(data: ChartData): boolean {
  return data.rows.every((row) =>
    data.series.every((s) => {
      const v = row[s.key]
      return typeof v !== 'number' || v > 0
    }),
  )
}

/** Chart types that can draw the period before beside the period shown. */
const COMPARABLE: ReadonlySet<ChartBlock['type']> = new Set(['bar', 'line', 'area', 'combo'])

export type ChartComparison = { data: ChartData; compare: { from: string; to: string } | null }

/**
 * A chart's data with "Compare to previous period" applied: when the toggle is on and a date
 * range narrows the chart's dataset, the first series measured over the window just before is
 * added as a `previous` series. An x on the range's own date column is shifted forward by the
 * range's length (so Nov 9 lines up with Oct 26 for a 14-day range); any other x (categories)
 * is matched as is. Unsplit bar, line, area and combo charts only; nothing lines up is no
 * comparison.
 */
export function chartComparison(dashboard: Dashboard, block: ChartBlock, state: FilterState): ChartComparison {
  const data = chartData(dashboard, block, state)
  if (!compareOn(state) || block.split || !COMPARABLE.has(block.type) || data.rows.length === 0) {
    return { data, compare: null }
  }
  const before = previousPeriod(dashboard, block.datasetId, stateForBlock(state, block.id))
  if (!before) return { data, compare: null }
  const previous = chartData(dashboard, block, before.state)
  const shift = block.x === before.column
  const byKey = new Map<string, number | null>()
  for (const row of previous.rows) {
    const key = shift && typeof row.x === 'string' ? addDays(row.x, before.days) : String(row.x)
    byKey.set(key, typeof row.s0 === 'number' ? row.s0 : null)
  }
  let matched = 0
  const rows = data.rows.map((row) => {
    const value = byKey.get(String(row.x)) ?? null
    if (value !== null) matched++
    return { ...row, p0: value }
  })
  if (matched === 0) return { data, compare: null }
  const label = `${data.series[0].label}, ${formatDateRange(before.from, before.to)}`
  return {
    data: { ...data, rows, series: [...data.series, { key: 'p0', label, previous: true }] },
    compare: { from: before.from, to: before.to },
  }
}

// ---- Conditional colour

export type Tone = 'good' | 'bad' | 'warn' | 'info'
type Rule = { op: '>' | '>=' | '<' | '<=' | '=' | '!='; value: number | string; tone: Tone; label?: string }

/** Does a value meet a rule? Numbers compare as numbers, text case-sensitively and only by = / !=. */
export function ruleMatches(rule: Rule, value: Cell | undefined): boolean {
  if (value === null || value === undefined) return false
  if (typeof rule.value === 'string' || typeof value === 'string') {
    const same = String(value) === String(rule.value)
    return rule.op === '=' ? same : rule.op === '!=' ? !same : false
  }
  switch (rule.op) {
    case '>':
      return value > rule.value
    case '>=':
      return value >= rule.value
    case '<':
      return value < rule.value
    case '<=':
      return value <= rule.value
    case '=':
      return value === rule.value
    case '!=':
      return value !== rule.value
  }
}

/** The first rule a value meets (rules read in order, like a spreadsheet's), or null. */
export function firstRule<R extends Rule>(rules: readonly R[] | undefined, value: Cell | undefined): R | null {
  for (const rule of rules ?? []) if (ruleMatches(rule, value)) return rule
  return null
}

export const TONE_WORD: Record<Tone, string> = { good: 'good', bad: 'needs attention', warn: 'watch', info: 'note' }

/** How a KPI's rule reads aloud: its own label, else the tone in words. */
export const ruleWord = (rule: Rule) => rule.label?.trim() || TONE_WORD[rule.tone]

/** How a combo chart draws each series: as given, else bars first and lines after. */
export function comboKinds(block: ChartBlock): Array<'bar' | 'line'> {
  return block.series.map((s, i) => s.as ?? (i === 0 ? 'bar' : 'line'))
}

export type FunnelStep = {
  key: string | number
  value: number
  /** Share of the first step (1 for the first), or null when the first is 0. */
  ofFirst: number | null
  /** Share of the step before (null for the first, or when that one is 0). */
  ofPrevious: number | null
}

/** A funnel's steps in order, from the chart's first series. Steps with no value are left out. */
export function funnelSteps(data: ChartData): FunnelStep[] {
  const points = data.rows
    .map((row) => ({ key: row.x as string | number, value: row.s0 }))
    .filter((p): p is { key: string | number; value: number } => typeof p.value === 'number')
  const first = points[0]?.value ?? 0
  return points.map((p, i) => {
    const previous = i > 0 ? points[i - 1].value : null
    return {
      key: p.key,
      value: p.value,
      ofFirst: first > 0 ? p.value / first : null,
      ofPrevious: previous !== null && previous > 0 ? p.value / previous : null,
    }
  })
}

/**
 * Where an annotation sits among a chart's x values: on its own value when shown, else (dates and
 * numbers, which read in order) on the first x after it. Null when it falls past the end or the
 * axis is categories.
 */
export function snapToX(keys: Array<string | number>, x: string | number, ordered: boolean): string | number | null {
  const exact = keys.find((k) => String(k) === String(x))
  if (exact !== undefined) return exact
  if (!ordered) return null
  const after = keys.find((k) => compareCells(k, x) > 0)
  return after ?? null
}

/**
 * A heatmap scale over a column's cells: each number maps to 0 (lowest) … 1 (highest); a column
 * of one value maps to 0.5. Anything not a number maps to null.
 */
export function heatScale(cells: Array<Cell | undefined>): (cell: Cell | undefined) => number | null {
  const values = cells.filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
  if (values.length === 0) return () => null
  const min = Math.min(...values)
  const max = Math.max(...values)
  return (cell) => {
    if (typeof cell !== 'number' || !Number.isFinite(cell)) return null
    return max === min ? 0.5 : (cell - min) / (max - min)
  }
}

/** An axis tick: always short ("$80K", "45K", "12%"). */
export function formatAxis(value: number, format: ValueFormat, currency = 'USD'): string {
  if (format === 'percent') return formatPercent(value)
  if (format === 'currency' && Math.abs(value) >= 1000) {
    return numberFormat(`axis-${currency}`, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
  return formatValue(value, format === 'currency' ? 'currency' : 'compact', currency)
}

/** The format a chart's values take: from its first series column. */
export function chartValueFormat(dashboard: Dashboard, block: ChartBlock): ValueFormat {
  if (block.valueFormat) return block.valueFormat
  const type = findColumn(findDataset(dashboard, block.datasetId), block.series[0].key)?.type
  if (type === 'currency') return 'currency'
  if (type === 'percent') return 'percent'
  return 'compact'
}

/**
 * The format of one drawn series (`s0`…): the chart's valueFormat when set, else that series'
 * own column (a right-axis "Orders" beside "Revenue" reads as a count, not dollars).
 */
export function seriesValueFormat(dashboard: Dashboard, block: ChartBlock, seriesKey: string): ValueFormat {
  if (block.valueFormat || block.split || !/^s\d+$/.test(seriesKey)) return chartValueFormat(dashboard, block)
  const series = block.series[Number(seriesKey.slice(1))]
  const type = series ? findColumn(findDataset(dashboard, block.datasetId), series.key)?.type : undefined
  if (type === 'currency') return 'currency'
  if (type === 'percent') return 'percent'
  return 'compact'
}

// ---- Tables

export function sortRows(rows: DataRow[], column: string, dir: 'asc' | 'desc'): DataRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row[column]
      const y = b.row[column]
      const xEmpty = x === null || x === undefined
      const yEmpty = y === null || y === undefined
      // Empty cells sink, whichever way the column is sorted.
      if (xEmpty || yEmpty) return xEmpty === yEmpty ? a.index - b.index : xEmpty ? 1 : -1
      const order = compareCells(x, y)
      return order === 0 ? a.index - b.index : order * sign
    })
    .map(({ row }) => row)
}

export function paginate<T>(rows: T[], page: number, pageSize: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const clamped = Math.min(Math.max(0, page), pages - 1)
  return { rows: rows.slice(clamped * pageSize, (clamped + 1) * pageSize), page: clamped, pages }
}

export function tableColumns(dashboard: Dashboard, block: TableBlock): DataColumn[] {
  const dataset = findDataset(dashboard, block.datasetId)
  if (!dataset) return []
  if (!block.columns) return dataset.columns
  return block.columns
    .map((key) => findColumn(dataset, key))
    .filter((c): c is DataColumn => c !== undefined)
}

// ---- Formatting

const cache = new Map<string, Intl.NumberFormat>()
function numberFormat(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let format = cache.get(key)
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, options)
    cache.set(key, format)
  }
  return format
}

function trimNumber(value: number, digits: number): string {
  return numberFormat(`n${digits}`, { maximumFractionDigits: digits }).format(value)
}

/** 0.1234 → "12.3%". */
export function formatPercent(fraction: number): string {
  return `${trimNumber(fraction * 100, 1)}%`
}

export function formatValue(value: number | null | undefined, format: ValueFormat, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY
  switch (format) {
    case 'integer':
      return numberFormat('int', { maximumFractionDigits: 0 }).format(value)
    case 'compact':
      if (Math.abs(value) < 1000) return trimNumber(value, Math.abs(value) < 10 ? 2 : 1)
      return numberFormat('compact', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    case 'currency': {
      const abs = Math.abs(value)
      if (abs >= 100_000) {
        return numberFormat(`cc-${currency}`, {
          style: 'currency',
          currency,
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(value)
      }
      const digits = abs >= 1000 || Number.isInteger(value) ? 0 : 2
      return numberFormat(`c${digits}-${currency}`, {
        style: 'currency',
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value)
    }
    case 'percent':
      return formatPercent(value)
    case 'number':
      return trimNumber(value, Math.abs(value) >= 100 ? 0 : 2)
  }
}

const dateFormats = {
  short: new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', month: 'short', day: 'numeric' }),
  long: new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }),
  // Date and time apart: ICU versions disagree on the joiner ("," or " at") when combined.
  stampDate: new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }),
  stampTime: new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
  }),
}

function utcDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

/** "2026-11-09" → "Nov 9, 2026" (or "Nov 9" when `short`). Anything else is returned as-is. */
export function formatDate(iso: string, short = false): string {
  const date = utcDate(iso)
  if (!date) return iso
  return (short ? dateFormats.short : dateFormats.long).format(date)
}

/** "Oct 5 – Nov 9, 2026"; the year once when both ends share it. */
export function formatDateRange(from: string, to: string): string {
  if (from === to) return formatDate(from)
  const a = utcDate(from)
  const b = utcDate(to)
  if (!a || !b) return `${from} – ${to}`
  if (a.getUTCFullYear() === b.getUTCFullYear()) return `${formatDate(from, true)} – ${formatDate(to)}`
  return `${formatDate(from)} – ${formatDate(to)}`
}

/** The as-of stamp: a date reads as a calendar day, a date-time in Pacific time. */
export function formatAsOf(asOf: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return formatDate(asOf)
  const date = new Date(asOf)
  if (Number.isNaN(date.getTime())) return asOf
  return `${dateFormats.stampDate.format(date)}, ${dateFormats.stampTime.format(date)} PT`
}

/** A group or axis key: dates read as dates, numbers formatted. */
export function formatKey(key: string | number, type: ColumnType, short = false): string {
  if (type === 'date' && typeof key === 'string') return formatDate(key, short)
  if (typeof key === 'number') return formatCell(key, type)
  return key
}

export function formatCell(value: Cell | undefined, type: ColumnType, currency?: string): string {
  if (value === null || value === undefined) return EMPTY
  if (typeof value === 'string') return type === 'date' ? formatDate(value) : value
  if (type === 'currency') {
    return numberFormat(`cell-${currency ?? 'USD'}`, {
      style: 'currency',
      currency: currency ?? 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  }
  if (type === 'percent') return formatPercent(value)
  return trimNumber(value, Number.isInteger(value) ? 0 : 2)
}

// ---- Provenance

/**
 * The time window a block's numbers cover. A date-range filter on its dataset wins (the range
 * chosen, its open ends filled from the data); then the source's own `window`; then the span
 * of the dataset's first date column in the rows shown.
 */
export function blockWindow(dashboard: Dashboard, block: DataBlock, state: FilterState): string | null {
  const datasetId = blockDatasetId(block)
  const dataset = findDataset(dashboard, datasetId)
  for (const filter of dashboard.filters ?? []) {
    const choice = state[filter.id]
    if (filter.type !== 'date-range' || !dataset || !filter.datasetIds.includes(dataset.id)) continue
    if (!choice || choice.kind !== 'date-range' || !isFilterActive(choice)) continue
    const bounds = dateBounds(dashboard, filter)
    const from = choice.from ?? bounds?.min
    const to = choice.to ?? bounds?.max
    if (from && to) return formatDateRange(from, to)
  }
  const source = findSource(dashboard, blockSourceId(dashboard, block))
  if (source?.window) return source.window
  const dateColumn = dataset?.columns.find((c) => c.type === 'date')
  if (!dataset || !dateColumn) return null
  const dates = filterRows(dataset, dashboard.filters, state)
    .map((r) => r[dateColumn.key])
    .filter((v): v is string => typeof v === 'string')
    .sort()
  if (dates.length === 0) return null
  return formatDateRange(dates[0], dates[dates.length - 1])
}

const AGG_WORD: Record<Agg, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
  last: 'Latest',
  count: 'Count',
}

function describeMeasure(dataset: Dataset | undefined, m: Measure): string {
  const column = findColumn(dataset, m.column)
  return `${AGG_WORD[m.agg].toLowerCase()} of ${column?.label ?? m.column}`
}

/** How a KPI's number is worked out, in one sentence: "Sum of Active users over 3 rows …". */
export function explainKpi(dashboard: Dashboard, block: KpiBlock, state: FilterState): string {
  const dataset = findDataset(dashboard, block.datasetId)
  const result = kpiResult(dashboard, block, state)
  const v = block.value
  let how: string
  if ('literal' in v) how = 'A fixed number, as reported by the source'
  else if ('ratio' in v) {
    how = `${capitalise(describeMeasure(dataset, v.ratio.numerator))} divided by ${describeMeasure(dataset, v.ratio.denominator)}`
  } else how = capitalise(describeMeasure(dataset, v))
  const parts = [how]
  if (!('literal' in v)) {
    const sparkType = block.sparkline ? findColumn(dataset, block.sparkline)?.type : undefined
    const where =
      result.period !== null && block.sparkline
        ? ` for ${findColumn(dataset, block.sparkline)?.label ?? block.sparkline} ${formatKey(result.period, sparkType ?? 'string')}`
        : ''
    parts.push(`over ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}${where}`)
  }
  const filters = activeFilterSummary(dashboard, block.datasetId, state)
  if (filters) parts.push(`(${filters})`)
  return `${parts.join(' ')}.`
}

/** "Platform: Web; Weeks: Oct 5 – Nov 9, 2026", for the filters that touch a dataset. */
export function activeFilterSummary(dashboard: Dashboard, datasetId: string | undefined, state: FilterState): string {
  if (!datasetId) return ''
  const parts: string[] = []
  for (const filter of dashboard.filters ?? []) {
    const choice = state[filter.id]
    if (!filter.datasetIds.includes(datasetId) || !isFilterActive(choice)) continue
    if (choice.kind === 'select') parts.push(`${filter.label}: ${choice.value}`)
    else if (choice.kind === 'multi') parts.push(`${filter.label}: ${choice.values.join(', ')}`)
    else if (choice.kind === 'date-range') {
      const bounds = dateBounds(dashboard, filter)
      const from = choice.from ?? bounds?.min
      const to = choice.to ?? bounds?.max
      if (from && to) parts.push(`${filter.label}: ${formatDateRange(from, to)}`)
    }
  }
  const cross = crossFilter(state)
  const dataset = findDataset(dashboard, datasetId)
  if (cross && dataset?.columns.some((c) => c.key === cross.column)) {
    const type = findColumn(dataset, cross.column)?.type ?? 'string'
    parts.push(`${cross.label}: ${formatKey(cross.value, type)}`)
  }
  return parts.join('; ')
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const SUMMARY_LIMIT = 1600

/** A short plain-text account of a block as shown, for "Ask Buffy". Never more than ~800 chars. */
export function describeBlock(dashboard: Dashboard, block: DataBlock, state: FilterState): string {
  const source = findSource(dashboard, blockSourceId(dashboard, block))
  const window = blockWindow(dashboard, block, state)
  const filters = activeFilterSummary(dashboard, blockDatasetId(block), state)
  const provenance = [
    source ? `Source: ${source.label}` : '',
    window ? `Window: ${window}` : '',
    filters ? `Filters: ${filters}` : '',
  ]
    .filter(Boolean)
    .join('. ')

  let body: string
  switch (block.kind) {
    case 'kpi': {
      const r = kpiResult(dashboard, block, state)
      body = `${block.label}: ${formatValue(r.value, block.format, dashboard.currency)}`
      if (r.delta) body += ` (${r.delta.text} ${r.delta.label}, ${r.delta.direction})`
      const rule = firstRule(block.rules, r.value)
      if (rule) body += `. Flagged: ${ruleWord(rule)}`
      if (r.trend.length > 1) {
        body += `. Trend: ${r.trend
          .map((p) => formatValue(p.value, block.format, dashboard.currency))
          .join(', ')}`
      }
      body += `. ${explainKpi(dashboard, block, state)}`
      break
    }
    case 'chart': {
      body = describeChart(dashboard, block, state)
      break
    }
    case 'table': {
      const rows = datasetRows(dashboard, block.datasetId, state)
      const columns = tableColumns(dashboard, block)
      body = `Table "${block.title}", ${rows.length} rows; columns ${columns.map((c) => c.label).join(', ')}.`
      const sorted = block.sort ? sortRows(rows, block.sort.column, block.sort.dir) : rows
      const sample = sorted
        .slice(0, 3)
        .map((r) => columns.map((c) => formatCell(r[c.key], c.type, dashboard.currency)).join(' | '))
      if (sample.length) body += ` First rows: ${sample.join('; ')}.`
      break
    }
    case 'text':
      body = block.markdown.replace(/\s+/g, ' ').trim()
      break
    case 'section':
      body = `Section "${block.title}"${block.description ? `: ${block.description}` : ''}.`
      break
  }
  // The body gives way first: where the numbers came from always survives the cap.
  const tail = provenance ? ` ${provenance}.` : ''
  const room = SUMMARY_LIMIT - tail.length
  const clipped = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body
  return `${clipped}${tail}`
}

/**
 * "Explain this chart": what it plots and how rows combine, each series' total, range and
 * change from first to last point, the reference lines and annotations, the comparison when
 * one is drawn, and the last points.
 */
export function describeChart(dashboard: Dashboard, block: ChartBlock, state: FilterState): string {
  const { data, compare } = chartComparison(dashboard, block, state)
  const format = chartValueFormat(dashboard, block)
  const dataset = findDataset(dashboard, block.datasetId)
  const xLabel = findColumn(dataset, block.x)?.label ?? block.x
  const show = (value: number | null) => formatValue(value, format, dashboard.currency)
  const parts: string[] = []
  const plotted = data.series.filter((s) => !s.previous && !s.trend)
  parts.push(
    `${capitalise(block.type.replace('-', ' '))} chart "${block.title}", ${plotted.map((s) => s.label).join(', ')} by ${xLabel}, ${data.rows.length} points.`,
  )
  if (block.split) {
    parts.push(`One series per ${findColumn(dataset, block.split)?.label ?? block.split}.`)
  }
  if (block.type !== 'scatter') {
    parts.push(`Rows sharing a ${xLabel} are combined by ${AGG_WORD[block.agg ?? 'sum'].toLowerCase()}.`)
    const ordered = data.xType !== 'string'
    for (const s of plotted.slice(0, 4)) {
      const values = data.rows.map((r) => r[s.key]).filter((v): v is number => typeof v === 'number')
      if (values.length === 0) continue
      const min = Math.min(...values)
      const max = Math.max(...values)
      const lowAt = data.rows.find((r) => r[s.key] === min)?.x as string | number
      const highAt = data.rows.find((r) => r[s.key] === max)?.x as string | number
      const total = values.reduce((a, b) => a + b, 0)
      // A total of rates or averages means nothing: those read as their average.
      const additive = (block.agg === undefined || block.agg === 'sum' || block.agg === 'count') && format !== 'percent'
      const overall = additive ? `total ${show(total)}` : `average ${show(total / values.length)}`
      let line = `${s.label}: ${overall}, high ${show(max)} (${formatKey(highAt, data.xType, true)}), low ${show(min)} (${formatKey(lowAt, data.xType, true)})`
      if (ordered && values.length > 1 && values[0] !== 0) {
        line += `, ${formatPercent((values[values.length - 1] - values[0]) / Math.abs(values[0]))} first to last`
      }
      parts.push(`${line}.`)
    }
  }
  if (block.references?.length) {
    parts.push(`Target lines: ${block.references.map((r) => `${r.label ? `${r.label} ` : ''}${show(r.value)}`).join(', ')}.`)
  }
  if (block.annotations?.length) {
    parts.push(`Marked: ${block.annotations.map((a) => `${a.label} (${formatKey(a.x, data.xType, true)})`).join(', ')}.`)
  }
  if (compare) parts.push(`Dashed: the same measure over ${formatDateRange(compare.from, compare.to)}.`)
  const points = data.rows.slice(-8).map((row) => {
    const x = formatKey(row.x as string | number, data.xType, true)
    const ys = data.series.map((s) => show(row[s.key] as number | null))
    return `${x}: ${ys.join(' / ')}`
  })
  if (points.length) parts.push(`${data.rows.length > 8 ? 'Last 8: ' : ''}${points.join('; ')}.`)
  if (block.note) parts.push(`Note: ${block.note}`)
  return parts.join(' ')
}

export function blockTitle(block: DataBlock): string {
  switch (block.kind) {
    case 'kpi':
      return block.label
    case 'text':
      return block.markdown.replace(/[#*_`>]/g, '').trim().split('\n')[0].slice(0, 80)
    default:
      return block.title
  }
}

// ---- Freshness (agent-refreshed data: nothing on the page fetches)

const HOUR_MS = 3_600_000

export type Freshness = {
  /** When the rows were pulled: the dataset's own stamp, else the page's asOf. Null when unknown. */
  fetchedAt: string | null
  /** Whether the stamp is the dataset's own (true) or the page's asOf (false). */
  own: boolean
  ageHours: number | null
  staleAfterHours: number | null
  /** Older than its recipe allows. Never stale without a threshold or a stamp. */
  stale: boolean
  /** "Nov 14, 2026, 3:00 PM PT" (or a calendar day). */
  label: string
  /** "3 days ago", "just now"; empty when unknown. */
  age: string
}

/** Milliseconds since the epoch for an ISO date (start of that UTC day) or date-time; null if unreadable. */
export function stampTime(iso: string): number | null {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso)
  return Number.isNaN(t) ? null : t
}

/** "just now", "40 minutes ago", "5 hours ago", "3 days ago". */
export function formatAge(hours: number): string {
  if (hours < 1 / 60) return 'just now'
  if (hours < 1) {
    const m = Math.round(hours * 60)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (hours < 48) {
    const h = Math.round(hours)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  const d = Math.round(hours / 24)
  return `${d} days ago`
}

export function datasetFreshness(dashboard: Dashboard, dataset: Dataset, now: number): Freshness {
  const own = dataset.provenance?.fetchedAt
  const fetchedAt = own ?? dashboard.asOf ?? null
  const staleAfterHours = dataset.refresh?.staleAfterHours ?? null
  const at = fetchedAt === null ? null : stampTime(fetchedAt)
  // A date-only stamp means some time that day: age it from the day's end, never from its start.
  const effective = at === null || fetchedAt === null ? null : /T/.test(fetchedAt) ? at : at + 24 * HOUR_MS - 1
  const ageHours = effective === null ? null : Math.max(0, (now - effective) / HOUR_MS)
  return {
    fetchedAt,
    own: own !== undefined,
    ageHours,
    staleAfterHours,
    stale: ageHours !== null && staleAfterHours !== null && ageHours > staleAfterHours,
    label: fetchedAt === null ? '' : formatAsOf(fetchedAt),
    age: ageHours === null ? '' : formatAge(ageHours),
  }
}

/** The freshness behind a block's numbers: its dataset's, or the page's asOf for a literal KPI. */
export function blockFreshness(dashboard: Dashboard, block: DataBlock, now: number): Freshness | null {
  const dataset = findDataset(dashboard, blockDatasetId(block))
  if (dataset) return datasetFreshness(dashboard, dataset, now)
  if (block.kind !== 'kpi' || !dashboard.asOf) return null
  const at = stampTime(dashboard.asOf)
  const ageHours = at === null ? null : Math.max(0, (now - at) / HOUR_MS)
  return {
    fetchedAt: dashboard.asOf,
    own: false,
    ageHours,
    staleAfterHours: null,
    stale: false,
    label: formatAsOf(dashboard.asOf),
    age: ageHours === null ? '' : formatAge(ageHours),
  }
}

/** Datasets older than their recipe allows, in page order. */
export function staleDatasets(dashboard: Dashboard, now: number): string[] {
  return dashboard.datasets.filter((d) => datasetFreshness(dashboard, d, now).stale).map((d) => d.id)
}

/** The page's own stamp: the oldest dataset stamp when datasets carry them, else asOf. */
export function pageFreshness(dashboard: Dashboard, now: number): { label: string; stale: number; oldest: Freshness | null } {
  let oldest: Freshness | null = null
  let stale = 0
  for (const dataset of dashboard.datasets) {
    const f = datasetFreshness(dashboard, dataset, now)
    if (f.stale) stale++
    if (f.fetchedAt === null) continue
    if (!oldest || (stampTime(f.fetchedAt) ?? 0) < (stampTime(oldest.fetchedAt ?? '') ?? 0)) oldest = f
  }
  const label = oldest?.label ?? (dashboard.asOf ? formatAsOf(dashboard.asOf) : '')
  return { label, stale, oldest }
}

/**
 * A refresh recipe as typed in a form: blank fields dropped, null when there is no recipe. The
 * typed `how` replaces the legacy free-text file and command (a form never writes those again).
 */
export function cleanRefresh(input: { recipe: string; how?: RecipeHow | null; staleAfterHours?: number | null }): DatasetRefresh | null {
  const recipe = input.recipe.trim().slice(0, 2000)
  if (!recipe) return null
  const out: DatasetRefresh = { recipe }
  if (input.how) out.how = input.how
  const hours = input.staleAfterHours
  if (hours !== null && hours !== undefined && Number.isFinite(hours) && hours >= 1) out.staleAfterHours = Math.min(Math.round(hours), 24 * 366)
  return out
}

// ---- Tables: formats, totals, search, TSV

/** How a table cell reads: the block's format for that column when it sets one, else by type. */
export function formatTableCell(block: TableBlock, column: DataColumn, value: Cell | undefined, currency?: string): string {
  const format = block.formats?.[column.key]
  if (format && typeof value === 'number') return formatValue(value, format, currency)
  return formatCell(value, column.type, currency)
}

export type TableTotal = { value: number | null; agg: 'sum' | 'avg' }

/**
 * A totals row: sums for number and currency columns, averages for percent (a sum of rates means
 * nothing). Columns in `skip` (calculated per row, like a ratio) get no total: summing a per-row
 * formula is rarely the formula over the total.
 */
export function tableTotals(columns: DataColumn[], rows: DataRow[], skip: ReadonlySet<string> = new Set()): Map<string, TableTotal> {
  const out = new Map<string, TableTotal>()
  for (const column of columns) {
    if (!isNumericType(column.type) || skip.has(column.key)) continue
    const agg = column.type === 'percent' ? 'avg' : 'sum'
    out.set(column.key, { value: aggregate(rows.map((r) => r[column.key] ?? null), agg), agg })
  }
  return out
}

/** Rows whose shown text contains every word of the query (case-insensitive). */
export function searchRows(rows: DataRow[], columns: DataColumn[], query: string, currency?: string): DataRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return rows
  return rows.filter((row) => {
    const text = columns
      .map((c) => {
        const v = row[c.key]
        return v === null || v === undefined ? '' : `${String(v)} ${formatCell(v, c.type, currency)}`
      })
      .join(' ')
      .toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/**
 * One TSV cell: tabs and line breaks become spaces; text a spreadsheet would run as a formula
 * gets a leading `'`. A number's shown text ("-2", "-$5.00") is never guarded: it is a value.
 */
export function tsvCell(cell: string | { text: string; numeric: true }): string {
  const text = typeof cell === 'string' ? cell : cell.text
  const flat = text.replace(/[\t\r\n]+/g, ' ')
  // Text only (export-safe.ts): a formatted number such as -5 stays a value.
  return typeof cell === 'string' ? formulaSafeCell(flat) : flat
}

/** A table as shown (formatted cells), tab-separated, for pasting into a spreadsheet. */
export function toTsv(header: string[], body: Array<Array<string | { text: string; numeric: true }>>): string {
  return [header, ...body].map((line) => line.map(tsvCell).join('\t')).join('\n')
}

// ---- Explaining a single number

/** How one chart point is worked out: "Sum of Active users over 3 rows where Week is Nov 9 …". */
export function explainChartPoint(dashboard: Dashboard, block: ChartBlock, state: FilterState, x: string | number): string {
  const dataset = findDataset(dashboard, block.datasetId)
  const own = stateForBlock(state, block.id)
  const rows = datasetRows(dashboard, block.datasetId, own)
  const xCol = findColumn(dataset, block.x)
  const matching = rows.filter((r) => r[block.x] !== null && r[block.x] !== undefined && String(r[block.x]) === String(x))
  const agg = AGG_WORD[block.agg ?? 'sum'].toLowerCase()
  const what = block.split
    ? `${findColumn(dataset, block.series[0].key)?.label ?? block.series[0].key}, one series per ${findColumn(dataset, block.split)?.label ?? block.split}`
    : block.series.map((s) => findColumn(dataset, s.key)?.label ?? s.key).join(', ')
  const calcs = block.series
    .map((s) => dataset?.calculated?.find((c) => c.key === s.key))
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => `${c.label} = ${c.expr}`)
  const filters = activeFilterSummary(dashboard, block.datasetId, own)
  return [
    `${capitalise(agg)} of ${what} over ${matching.length} ${matching.length === 1 ? 'row' : 'rows'} where ${xCol?.label ?? block.x} is ${formatKey(x, xCol?.type ?? 'string')}`,
    calcs.length ? `; calculated per row as ${calcs.join('; ')}` : '',
    filters ? ` (${filters})` : '',
    '.',
  ].join('')
}

/** Where one table cell comes from: a stored value, or its calculation. */
export function explainCell(dashboard: Dashboard, datasetId: string, columnKey: string): string {
  const dataset = findDataset(dashboard, datasetId)
  const calc = dataset?.calculated?.find((c) => c.key === columnKey)
  const source = findSource(dashboard, dataset?.sourceId)
  if (calc) return `${calc.label} is calculated for each row: ${calc.expr}.`
  const column = findColumn(dataset, columnKey)
  return `${column?.label ?? columnKey} is a stored value in ${dataset?.title ?? datasetId}${source ? `, from ${source.label}` : ''}.`
}

// ---- The agent's readout: computed values, so it can check its own output

/** Things worth fixing on a page as computed, in plain words (the agent reads these first). */
export function dashboardChecks(dashboard: Dashboard, now: number): string[] {
  const out: string[] = []
  const state = defaultFilterState(dashboard)
  const doubts = new Map(datasetDoubts(dashboard).map((d) => [d.datasetId, d]))
  for (const dataset of dashboard.datasets) {
    const f = datasetFreshness(dashboard, dataset, now)
    if (f.stale) out.push(`dataset ${dataset.id} is stale: fetched ${f.age}, its recipe allows ${f.staleAfterHours} hours`)
    const doubt = doubts.get(dataset.id)
    if (doubt?.edited) out.push(`dataset ${dataset.id} was edited by hand (${doubt.edited.by}, ${doubt.edited.at}) and no longer matches its source`)
    if (doubt?.failed) out.push(`dataset ${dataset.id}: the last refresh failed (${doubt.failed.slice(0, 200)})`)
    if (doubt?.voidCertificate) out.push(`dataset ${dataset.id} changed since the owner certified it`)
    for (const problem of doubt?.checks ?? []) out.push(`dataset ${dataset.id} ${problem}`)
    if (dataset.rows.length === 0 && dashboard.blocks.some((b) => blockDatasetId(b) === dataset.id)) {
      out.push(`dataset ${dataset.id} has no rows but blocks read it`)
    }
    if (dataset.rows.length > 0) {
      for (const calc of dataset.calculated ?? []) {
        const empty = dataset.rows.filter((row) => row[calc.key] === null || row[calc.key] === undefined).length
        if (empty === dataset.rows.length) {
          out.push(`calculated column ${dataset.id}.${calc.key} is empty on every row (a missing input or a division by zero?)`)
        } else if (empty > 0) {
          // A per-row null is a missing input or a division by zero there: worth knowing, not always wrong.
          out.push(`calculated column ${dataset.id}.${calc.key} is empty on ${empty} of ${dataset.rows.length} rows`)
        }
      }
    }
  }
  for (const block of dashboard.blocks) {
    if (block.kind === 'kpi') {
      if (kpiResult(dashboard, block, state).value === null) out.push(`kpi ${block.id} shows no value`)
    } else if (block.kind === 'chart') {
      const data = chartData(dashboard, block, state)
      if (data.rows.length === 0) out.push(`chart ${block.id} has no points`)
      else if (block.scale === 'log' && !logScaleUsable(data)) out.push(`chart ${block.id} asks for a log scale but has values of 0 or less; it draws linear`)
      else if (data.rows.every((r) => data.series.every((s) => r[s.key] === null))) out.push(`chart ${block.id} has points but every value is empty`)
    } else if (block.kind === 'table') {
      if (datasetRows(dashboard, block.datasetId, state).length === 0) out.push(`table ${block.id} has no rows`)
    }
  }
  return out
}

/** A compact per-series account: points, total or average, low, high, first and last. */
function seriesLine(data: ChartData, key: string, label: string, show: (v: number | null) => string, additive: boolean): string {
  const values = data.rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number')
  if (values.length === 0) return `${label}: no values`
  const total = values.reduce((a, b) => a + b, 0)
  const x = (row: Record<string, unknown> | undefined) =>
    row ? formatKey(row.x as string | number, data.xType, true) : ''
  const first = data.rows.find((r) => typeof r[key] === 'number')
  const last = [...data.rows].reverse().find((r) => typeof r[key] === 'number')
  return `${label}: ${additive ? `total ${show(total)}` : `avg ${show(total / values.length)}`}, low ${show(Math.min(...values))}, high ${show(Math.max(...values))}, first ${show(values[0])} (${x(first)}), last ${show(values[values.length - 1])} (${x(last)})`
}

export const READOUT_LIMIT = 6000

/**
 * What the page computes, as the agent's `read_artifact` sees it: checks first, then each
 * dataset's freshness, each KPI's value and change, and each chart's series. Default filters
 * and parameters; calculated columns computed. Capped at `limit` characters.
 */
export function dashboardReadout(stored: Dashboard, now: number, limit = READOUT_LIMIT): string {
  // Calculated columns are computed here exactly as the page computes them.
  const dashboard = materializeDashboard(stored)
  const state = defaultFilterState(dashboard)
  const lines: string[] = []
  const checks = dashboardChecks(dashboard, now)
  lines.push(checks.length ? `Checks: ${checks.join('; ')}.` : 'Checks: nothing to flag.')
  const fresh = dashboard.datasets.map((d) => {
    const f = datasetFreshness(dashboard, d, now)
    const recipe = d.refresh ? `, ${d.refresh.how ? `${d.refresh.how.kind} ` : ''}recipe${d.refresh.staleAfterHours ? ` (stale after ${d.refresh.staleAfterHours}h)` : ''}` : ', no recipe'
    const change = d.lastChange
      ? `, last change ${d.lastChange.at}: +${d.lastChange.added} -${d.lastChange.removed} ~${d.lastChange.changed} =${d.lastChange.unchanged}${d.lastChange.keyed ? '' : ' (unkeyed)'}`
      : ''
    const run = d.lastRun ? `, last run ${d.lastRun.status} ${d.lastRun.at}` : ''
    const mark = certification(d) === 'valid' ? ', certified' : certification(d) === 'void' ? ', certificate void' : ''
    const edited = d.edited ? `, EDITED by ${d.edited.by}` : ''
    return `${d.id} ${f.fetchedAt ? `fetched ${f.fetchedAt}${f.own ? '' : ' (page asOf)'}${f.stale ? ' STALE' : ''}` : 'no fetch time'}${recipe}${edited}${run}${change}${mark}`
  })
  if (fresh.length) lines.push(`Freshness: ${fresh.join('; ')}.`)
  for (const block of dashboard.blocks) {
    if (block.kind === 'kpi') {
      const r = kpiResult(dashboard, block, state)
      const rule = firstRule(block.rules, r.value)
      lines.push(
        `kpi ${block.id} = ${formatValue(r.value, block.format, dashboard.currency)}${r.value === null ? '' : ` (raw ${Number(r.value.toPrecision(12))})`}${r.delta ? `, ${r.delta.text} ${r.delta.label}` : ''}${rule ? `, flagged ${ruleWord(rule)}` : ''}${r.period !== null ? `, period ${r.period}` : ''}, ${r.rowCount} rows`,
      )
    } else if (block.kind === 'chart') {
      const data = chartData(dashboard, block, state)
      const series = data.series
        .filter((s) => !s.trend)
        .slice(0, 4)
        .map((s) => {
          const format = s.previous ? chartValueFormat(dashboard, block) : seriesValueFormat(dashboard, block, s.key)
          const show = (v: number | null) => formatValue(v, format, dashboard.currency)
          const additive = (block.agg === undefined || block.agg === 'sum' || block.agg === 'count') && format !== 'percent'
          return seriesLine(data, s.key, s.label, show, additive)
        })
      const facets = block.facet ? `, ${chartFacets(dashboard, block, state).length} small multiples` : ''
      lines.push(`chart ${block.id} (${block.type}) ${data.rows.length} points${facets}: ${series.join(' | ')}`)
    } else if (block.kind === 'table') {
      lines.push(`table ${block.id}: ${datasetRows(dashboard, block.datasetId, state).length} rows`)
    }
  }
  const text = lines.join('\n')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}
