/**
 * Freebuff Data: the authoring edits a person makes by hand in the Data pane (add a block from
 * the picker, rebind it, resize, duplicate, add a source, edit rows). Pure; each returns a new
 * dashboard (or the same one when nothing changed). The builders keep the rules
 * `parseDashboard` checks: a bound block takes its dataset's source, a split chart has one
 * series, pie/donut/funnel never split, scatter has a numeric x, "previous" needs a sparkline.
 */

import {
  isNumericType,
  MAX_BLOCKS,
  MAX_ROWS_PER_DATASET,
  MAX_SOURCES,
  MAX_SPAN,
  type Agg,
  type Cell,
  type ChartBlock,
  type ChartType,
  type ColumnType,
  type Dashboard,
  type DataBlock,
  type DataColumn,
  type Dataset,
  type KpiBlock,
  type TableBlock,
  type ValueFormat,
} from './data'
import { coerceCell, uniqueId } from './data-import'

export type BlockKind = DataBlock['kind']

// ---- Grid span

/** How many of the 4 grid columns a block fills: its `span`, else the kind's default. */
export function blockSpan(block: DataBlock): number {
  if (block.span !== undefined) return block.span
  if (block.kind === 'kpi') return 1
  if (block.kind === 'chart') return block.size === 'full' ? 4 : 2
  return 4
}

export function setBlockSpan(dashboard: Dashboard, blockId: string, span: number): Dashboard {
  const next = Math.max(1, Math.min(MAX_SPAN, Math.round(span)))
  return mapBlock(dashboard, blockId, (block) => {
    if (blockSpan(block) === next) return block
    // `size` is left as stored: `span` wins wherever both are read.
    return { ...block, span: next }
  })
}

// ---- Insert, duplicate, replace

export function blockIds(dashboard: Dashboard): Set<string> {
  return new Set(dashboard.blocks.map((b) => b.id))
}

/** Insert a block after `afterId` (or at the end). Refused (same dashboard) at the block cap. */
export function insertBlock(dashboard: Dashboard, block: DataBlock, afterId?: string | null): Dashboard {
  if (dashboard.blocks.length >= MAX_BLOCKS || blockIds(dashboard).has(block.id)) return dashboard
  const blocks = [...dashboard.blocks]
  const at = afterId ? blocks.findIndex((b) => b.id === afterId) : -1
  blocks.splice(at === -1 ? blocks.length : at + 1, 0, block)
  return { ...dashboard, blocks }
}

export function replaceBlock(dashboard: Dashboard, block: DataBlock): Dashboard {
  return mapBlock(dashboard, block.id, () => block)
}

const COPY_SUFFIX = ' (copy)'

/** A copy of a block, with a fresh id and "(copy)" on its title, right after it. */
export function duplicateBlock(dashboard: Dashboard, blockId: string): { dashboard: Dashboard; id: string | null } {
  const block = dashboard.blocks.find((b) => b.id === blockId)
  if (!block || dashboard.blocks.length >= MAX_BLOCKS) return { dashboard, id: null }
  const id = uniqueId(`${block.id.slice(0, 50)}-copy`, blockIds(dashboard))
  const retitle = (title: string) => `${title.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`
  let copy: DataBlock
  switch (block.kind) {
    case 'kpi':
      copy = { ...structuredClone(block), id, label: retitle(block.label) }
      break
    case 'text':
      copy = { ...structuredClone(block), id }
      break
    default:
      copy = { ...structuredClone(block), id, title: retitle(block.title) }
  }
  return { dashboard: insertBlock(dashboard, copy, blockId), id }
}

// ---- Starter blocks (the picker)

const firstOf = (dataset: Dataset | undefined, test: (type: ColumnType) => boolean) =>
  dataset?.columns.find((c) => test(c.type))

/** The x a new chart uses: the first date column, else the first string column, else the first column. */
function defaultX(dataset: Dataset): DataColumn {
  return firstOf(dataset, (t) => t === 'date') ?? firstOf(dataset, (t) => t === 'string') ?? dataset.columns[0]
}

export function formatForColumn(type: ColumnType | undefined): ValueFormat {
  if (type === 'currency') return 'currency'
  if (type === 'percent') return 'percent'
  return 'compact'
}

/**
 * A valid new block of `kind`, bound to `datasetId` (or the first dataset) with sensible
 * defaults the person then edits. KPI with no dataset is a literal 0 on the first source; a
 * chart needs a dataset with a numeric column, a table any dataset: otherwise null.
 */
export function starterBlock(dashboard: Dashboard, kind: BlockKind, datasetId?: string): DataBlock | null {
  const id = uniqueId(kind === 'kpi' ? 'kpi' : kind, blockIds(dashboard))
  const dataset = dashboard.datasets.find((d) => d.id === datasetId) ?? dashboard.datasets[0]
  switch (kind) {
    case 'text':
      return { kind: 'text', id, markdown: 'Write a note about what the numbers show.' }
    case 'section':
      return { kind: 'section', id, title: 'New section' }
    case 'table':
      return dataset ? { kind: 'table', id, title: dataset.title ?? 'Table', datasetId: dataset.id } : null
    case 'kpi': {
      const numeric = firstOf(dataset, isNumericType)
      if (!dataset || !numeric) {
        const sourceId = dashboard.sources[0]?.id
        if (!sourceId) return null
        return { kind: 'kpi', id, label: 'New number', value: { literal: 0 }, format: 'number', sourceId }
      }
      const date = firstOf(dataset, (t) => t === 'date')
      const block: KpiBlock = {
        kind: 'kpi',
        id,
        label: numeric.label,
        datasetId: dataset.id,
        value: { column: numeric.key, agg: 'sum' },
        format: formatForColumn(numeric.type),
        sourceId: dataset.sourceId,
      }
      if (date) {
        block.sparkline = date.key
        block.delta = { vs: 'previous', format: 'percent' }
      }
      return block
    }
    case 'chart': {
      const numeric = firstOf(dataset, isNumericType)
      if (!dataset || !numeric) return null
      const x = defaultX(dataset)
      return {
        kind: 'chart',
        id,
        title: `${numeric.label} by ${x.label}`.slice(0, 200),
        type: x.type === 'date' ? 'line' : 'bar',
        datasetId: dataset.id,
        x: x.key,
        series: [{ key: numeric.key, label: numeric.label }],
        sourceId: dataset.sourceId,
      }
    }
  }
}

// ---- Binding

export type KpiBinding = {
  datasetId: string
  column: string
  agg: Agg
  format: ValueFormat
  /** A column to trend over, or null for none. */
  sparkline: string | null
  /** Show the change against the period before (needs a sparkline). */
  compare: boolean
  display: 'tile' | 'trend'
}

export type ChartBinding = {
  datasetId: string
  type: ChartType
  x: string
  series: string[]
  agg: Agg
  split: string | null
}

const columnIn = (dataset: Dataset, key: string | null | undefined) =>
  key ? dataset.columns.find((c) => c.key === key) : undefined

/** A KPI rebound to new choices, every rule kept. Null when the dataset or column is unusable. */
export function bindKpi(dashboard: Dashboard, block: KpiBlock, binding: KpiBinding): KpiBlock | null {
  const dataset = dashboard.datasets.find((d) => d.id === binding.datasetId)
  if (!dataset) return null
  const column = columnIn(dataset, binding.column) ?? firstOf(dataset, isNumericType) ?? dataset.columns[0]
  const numeric = isNumericType(column.type)
  // sum/avg/min/max need numbers; count and last work on anything.
  const agg: Agg = numeric || binding.agg === 'count' || binding.agg === 'last' ? binding.agg : 'count'
  const sparkline = columnIn(dataset, binding.sparkline)?.key
  // The measure the form shows is the value's own, or a ratio's numerator. Unchanged, the value
  // stays exactly as stored (a ratio stays a ratio when only the trend or format changes).
  const shown = 'column' in block.value ? block.value : 'ratio' in block.value ? block.value.ratio.numerator : null
  const same = block.datasetId === dataset.id && shown?.column === column.key && shown.agg === agg
  const next: KpiBlock = {
    kind: 'kpi',
    id: block.id,
    label: block.label,
    datasetId: dataset.id,
    value: same ? block.value : { column: column.key, agg },
    format: binding.format,
    sourceId: dataset.sourceId,
  }
  if (block.note) next.note = block.note
  if (block.span !== undefined) next.span = block.span
  // Conditional colour reads the number, whatever it is bound to: it survives a rebind.
  if (block.rules) next.rules = block.rules
  if (sparkline) {
    next.sparkline = sparkline
    if (binding.display === 'trend') next.display = 'trend'
  }
  if (block.delta && block.delta.vs !== 'previous') {
    // A target comparison ("vs 500") needs no sparkline and survives any rebind.
    next.delta = block.delta
  } else if (sparkline && binding.compare) {
    next.delta = block.delta?.vs === 'previous' ? block.delta : { vs: 'previous', format: 'percent' }
  }
  return next
}

/** The chart types a binding can use: split rules out pie, donut and funnel; scatter needs numeric x. */
export function chartTypesFor(xType: ColumnType | undefined, split: boolean, seriesCount: number): ChartType[] {
  const types: ChartType[] = ['bar', 'horizontal-bar', 'stacked-bar', 'line', 'area']
  if (!split && seriesCount >= 2) types.push('combo')
  if (!split) types.push('pie', 'donut', 'funnel')
  if (xType !== undefined && isNumericType(xType)) types.push('scatter')
  return types
}

/** A chart rebound to new choices, every rule kept. Null when nothing numeric is left to draw. */
export function bindChart(dashboard: Dashboard, block: ChartBlock, binding: ChartBinding): ChartBlock | null {
  const dataset = dashboard.datasets.find((d) => d.id === binding.datasetId)
  if (!dataset) return null
  const x = columnIn(dataset, binding.x) ?? defaultX(dataset)
  const labels = new Map(block.series.map((s) => [s.key, s]))
  let series = binding.series
    .map((key) => columnIn(dataset, key))
    .filter((c): c is DataColumn => c !== undefined && isNumericType(c.type))
    .map((c) => {
      const old = labels.get(c.key)
      // A series keeps its own label (the person may have renamed it) and its bar/line choice.
      return { key: c.key, label: old?.label ?? c.label, ...(old?.as ? { as: old.as } : {}), ...(old?.axis ? { axis: old.axis } : {}) }
    })
  if (series.length === 0) {
    const numeric = firstOf(dataset, isNumericType)
    if (!numeric) return null
    series = [{ key: numeric.key, label: numeric.label }]
  }
  let split = columnIn(dataset, binding.split)?.key
  if (split === x.key) split = undefined
  if (split) series = series.slice(0, 1)
  const allowed = chartTypesFor(x.type, Boolean(split), series.length)
  let type = binding.type
  if (!allowed.includes(type)) {
    // Keep the split when the person just chose one; fall back to the nearest drawable type.
    type = type === 'scatter' || type === 'pie' || type === 'donut' || type === 'funnel' || type === 'combo' ? 'bar' : allowed[0]
  }
  if (type === 'scatter') split = undefined
  const next: ChartBlock = {
    kind: 'chart',
    id: block.id,
    title: block.title,
    type,
    datasetId: dataset.id,
    x: x.key,
    series: series.map(({ key, label, as, axis }) => ({
      key,
      label,
      ...(type === 'combo' && as ? { as } : {}),
      ...(axis && !split && RIGHT_AXIS_TYPES.has(type) ? { axis } : {}),
    })),
    sourceId: dataset.sourceId,
  }
  if (binding.agg !== 'sum') next.agg = binding.agg
  if (split) next.split = split
  for (const key of ['note', 'size', 'span', 'references', 'annotations', 'valueFormat', 'sort'] as const) {
    if (block[key] !== undefined) Object.assign(next, { [key]: block[key] })
  }
  return keepChartOptions(next, block, dataset)
}

const STACK_TYPES: ReadonlySet<ChartType> = new Set(['bar', 'area', 'stacked-bar', 'horizontal-bar'])
const RIGHT_AXIS_TYPES: ReadonlySet<ChartType> = new Set(['bar', 'line', 'area', 'combo'])
const TREND_TYPES: ReadonlySet<ChartType> = new Set(['bar', 'line', 'area', 'combo', 'scatter'])

/**
 * The display options of `old` that still make sense on `next` (a new type, x or split): a
 * stack only on bars and areas, a log scale off pies and 100% stacks, top N on text x only, a
 * trendline unsplit, small multiples on a column that is not x or the split. Anything else is
 * dropped rather than refused, so a type switch always lands.
 */
export function keepChartOptions(next: ChartBlock, old: ChartBlock, dataset: Dataset): ChartBlock {
  const out: ChartBlock = { ...next }
  for (const key of ['stack', 'scale', 'topN', 'trendline', 'facet'] as const) delete out[key]
  const x = columnIn(dataset, out.x)
  if (old.stack && STACK_TYPES.has(out.type)) out.stack = old.stack
  if (old.scale === 'log' && out.stack !== 'percent' && !['pie', 'donut', 'funnel'].includes(out.type)) out.scale = 'log'
  if (old.topN !== undefined && x?.type === 'string' && out.type !== 'scatter') out.topN = old.topN
  if (old.trendline && !out.split && TREND_TYPES.has(out.type)) out.trendline = true
  if (old.facet && columnIn(dataset, old.facet) && old.facet !== out.x && old.facet !== out.split && out.type !== 'funnel') {
    out.facet = old.facet
  }
  if (out.split || !RIGHT_AXIS_TYPES.has(out.type)) out.series = out.series.map(({ axis: _axis, ...s }) => s)
  return out
}

/** A table rebound to a dataset and a column choice (empty or every column means "all"). */
export function bindTable(
  dashboard: Dashboard,
  block: TableBlock,
  binding: { datasetId: string; columns: string[]; heatmap: string[] },
): TableBlock | null {
  const dataset = dashboard.datasets.find((d) => d.id === binding.datasetId)
  if (!dataset) return null
  const columns = binding.columns.filter((key) => columnIn(dataset, key))
  const heatmap = binding.heatmap.filter((key) => {
    const c = columnIn(dataset, key)
    return c !== undefined && isNumericType(c.type)
  })
  const next: TableBlock = { kind: 'table', id: block.id, title: block.title, datasetId: dataset.id }
  if (columns.length > 0 && columns.length < dataset.columns.length) next.columns = columns
  if (block.sort && columnIn(dataset, block.sort.column)) next.sort = block.sort
  if (block.limit !== undefined) next.limit = block.limit
  if (block.span !== undefined) next.span = block.span
  if (heatmap.length > 0) next.heatmap = heatmap
  // Colour rules on a column the new dataset still has are kept.
  const rules = (block.rules ?? []).filter((rule) => columnIn(dataset, rule.column))
  if (rules.length > 0) next.rules = rules
  const formats = Object.fromEntries(
    Object.entries(block.formats ?? {}).filter(([key]) => {
      const c = columnIn(dataset, key)
      return c !== undefined && isNumericType(c.type)
    }),
  )
  if (Object.keys(formats).length > 0) next.formats = formats
  if (block.totals) next.totals = true
  if (block.pinFirst) next.pinFirst = true
  return next
}

// ---- Sources and rows

/** Add a source; returns its id (null at the cap or with an empty label). */
export function addSource(
  dashboard: Dashboard,
  input: { label: string; detail?: string; window?: string },
): { dashboard: Dashboard; id: string | null } {
  const label = input.label.trim().slice(0, 200)
  if (!label || dashboard.sources.length >= MAX_SOURCES) return { dashboard, id: null }
  const taken = new Set(dashboard.sources.map((s) => s.id))
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'source'
  const id = uniqueId(base, taken)
  const detail = input.detail?.trim().slice(0, 2000)
  const window = input.window?.trim().slice(0, 200)
  return {
    dashboard: {
      ...dashboard,
      sources: [...dashboard.sources, { id, label, ...(detail ? { detail } : {}), ...(window ? { window } : {}) }],
    },
    id,
  }
}

function mapDataset(dashboard: Dashboard, datasetId: string, fn: (dataset: Dataset) => Dataset): Dashboard {
  let changed = false
  const datasets = dashboard.datasets.map((d) => {
    if (d.id !== datasetId) return d
    const next = fn(d)
    if (next !== d) changed = true
    return next
  })
  return changed ? { ...dashboard, datasets } : dashboard
}

/**
 * Set one cell from typed text, read as its column's type. Returns the same dashboard when the
 * text does not fit (a word in a number column) or nothing changed.
 */
export function setCell(dashboard: Dashboard, datasetId: string, rowIndex: number, key: string, text: string): Dashboard {
  return mapDataset(dashboard, datasetId, (dataset) => {
    const column = dataset.columns.find((c) => c.key === key)
    const row = dataset.rows[rowIndex]
    if (!column || !row) return dataset
    const { cell, ok } = coerceCell(text, column.type)
    if (!ok || (row[key] ?? null) === cell) return dataset
    const rows = [...dataset.rows]
    rows[rowIndex] = { ...row, [key]: cell }
    return { ...dataset, rows }
  })
}

/** Append an empty row (every cell null). */
export function addRow(dashboard: Dashboard, datasetId: string): Dashboard {
  return mapDataset(dashboard, datasetId, (dataset) => {
    if (dataset.rows.length >= MAX_ROWS_PER_DATASET) return dataset
    const row: Record<string, Cell> = {}
    for (const c of dataset.columns) row[c.key] = null
    return { ...dataset, rows: [...dataset.rows, row] }
  })
}

export function removeRow(dashboard: Dashboard, datasetId: string, rowIndex: number): Dashboard {
  return mapDataset(dashboard, datasetId, (dataset) =>
    rowIndex < 0 || rowIndex >= dataset.rows.length
      ? dataset
      : { ...dataset, rows: dataset.rows.filter((_, i) => i !== rowIndex) },
  )
}

export function retitleDataset(dashboard: Dashboard, datasetId: string, title: string): Dashboard {
  const next = title.trim().slice(0, 200)
  return mapDataset(dashboard, datasetId, (dataset) => {
    if ((dataset.title ?? '') === next) return dataset
    if (!next) {
      const { title: _drop, ...rest } = dataset
      return rest
    }
    return { ...dataset, title: next }
  })
}

/** Blocks and filters that read a dataset: a dataset they use cannot be removed. */
export function datasetUsers(dashboard: Dashboard, datasetId: string): string[] {
  const users: string[] = []
  for (const b of dashboard.blocks) {
    if ((b.kind === 'kpi' || b.kind === 'chart' || b.kind === 'table') && b.datasetId === datasetId) users.push(b.id)
  }
  for (const f of dashboard.filters ?? []) if (f.datasetIds.includes(datasetId)) users.push(f.id)
  return users
}

export function removeDataset(dashboard: Dashboard, datasetId: string): Dashboard {
  if (datasetUsers(dashboard, datasetId).length > 0) return dashboard
  const datasets = dashboard.datasets.filter((d) => d.id !== datasetId)
  return datasets.length === dashboard.datasets.length ? dashboard : { ...dashboard, datasets }
}

function mapBlock(dashboard: Dashboard, blockId: string, fn: (block: DataBlock) => DataBlock): Dashboard {
  let changed = false
  const blocks = dashboard.blocks.map((block) => {
    if (block.id !== blockId) return block
    const next = fn(block)
    if (next !== block) changed = true
    return next
  })
  return changed ? { ...dashboard, blocks } : dashboard
}
