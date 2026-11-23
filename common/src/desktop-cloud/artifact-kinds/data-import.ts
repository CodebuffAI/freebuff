/**
 * Freebuff Data: rows from pasted or uploaded delimited text (CSV or TSV) into a dashboard's
 * datasets, with column types inferred. Pure; shared by the Data pane (paste, Import CSV) and
 * the agent's import ops. Everything it produces passes `parseDashboard`: keys match the id rule,
 * dates are "YYYY-MM-DD", percents are fractions, currency is a number in major units, and the
 * row, column and cell caps hold.
 */

import { z } from 'zod/v4'
import {
  isNumericType,
  MAX_COLUMNS,
  MAX_DATASETS,
  MAX_ROWS_PER_DATASET,
  MAX_SOURCES,
  type Cell,
  type ColumnType,
  type Dashboard,
  type DataColumn,
  type DataRow,
  type Dataset,
} from './data'
import { readDelimited } from './sheet-delimited'

export const MAX_CELL_CHARS = 1000

/** Text split into rows of fields: a tab anywhere in the first line means TSV, else CSV. Blank lines go. */
export function parseTable(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.includes('\t') ? '\t' : ','
  return readDelimited(text, delimiter).filter((row) => row.some((field) => field.trim() !== ''))
}

export type ParsedNumber = { value: number; style: 'number' | 'currency' | 'percent' }

/** "1,234", "$1,234.50", "(12)", "12.5%", "-3e2". Not a number: null. */
export function parseNumberCell(raw: string): ParsedNumber | null {
  let text = raw.trim()
  if (text === '') return null
  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1).trim()
  }
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = !negative
    text = text.slice(1).trim()
  } else if (text.startsWith('+')) text = text.slice(1).trim()
  let style: ParsedNumber['style'] = 'number'
  if (/^[$€£¥]/.test(text)) {
    style = 'currency'
    text = text.slice(1).trim()
  }
  if (text.endsWith('%')) {
    if (style === 'currency') return null
    style = 'percent'
    text = text.slice(0, -1).trim()
  }
  // Thousands separators only between digit groups of three.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '')
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null
  let value = Number(text)
  if (!Number.isFinite(value)) return null
  if (negative) value = -value
  if (style === 'percent') value = value / 100
  return { value, style }
}

const pad = (n: number) => String(n).padStart(2, '0')

function isoDay(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

/** "2026-11-09", "2026/11/09", "11/9/2026" (US order), "2026-11-09T08:00:00Z" → "2026-11-09". Else null. */
export function parseDateCell(raw: string): string | null {
  const text = raw.trim()
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text)
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (m) return isoDay(Number(m[3]), Number(m[1]), Number(m[2]))
  return null
}

/**
 * The type a column's raw values read as. Every non-empty value must agree: all dates → date;
 * all numbers → percent if every one ends in "%", currency if any carries a currency sign, else
 * number. A value with a leading zero ("02139") makes it text. Anything else (or nothing at all)
 * is a string column.
 */
export function inferColumnType(values: string[]): ColumnType {
  const present = values.map((v) => v.trim()).filter((v) => v !== '')
  if (present.length === 0) return 'string'
  if (present.every((v) => parseDateCell(v) !== null)) return 'date'
  // Codes with a leading zero (ZIP codes, ids like "007") are text, not numbers.
  if (present.some((v) => /^[+-]?0\d/.test(v))) return 'string'
  const numbers = present.map(parseNumberCell)
  if (numbers.every((n) => n !== null)) {
    if (numbers.every((n) => n!.style === 'percent')) return 'percent'
    if (numbers.some((n) => n!.style === 'currency') && numbers.every((n) => n!.style !== 'percent')) return 'currency'
    if (numbers.some((n) => n!.style === 'percent')) return 'string'
    return 'number'
  }
  return 'string'
}

/**
 * One raw field as a cell of `type`. Empty is null. A number column reads "12.5%" as 0.125;
 * a percent column reads a bare "12.5" as already a fraction only when it is at most 1, else as
 * percent points. A field that does not fit its column is `ok: false` (its cell is null).
 */
export function coerceCell(raw: string, type: ColumnType): { cell: Cell; ok: boolean } {
  const text = raw.trim()
  if (text === '') return { cell: null, ok: true }
  if (type === 'string') return { cell: raw.slice(0, MAX_CELL_CHARS), ok: true }
  if (type === 'date') {
    const day = parseDateCell(text)
    return day === null ? { cell: null, ok: false } : { cell: day, ok: true }
  }
  const parsed = parseNumberCell(text)
  if (!parsed) return { cell: null, ok: false }
  if (type === 'percent' && parsed.style !== 'percent' && Math.abs(parsed.value) > 1) {
    return { cell: parsed.value / 100, ok: true }
  }
  return { cell: parsed.value, ok: true }
}

/** A column key from a header: letters, digits, "_" and "-", at most 64, unique among `taken`. */
export function columnKey(header: string, taken: Set<string>): string {
  const base =
    header
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 56) || 'col'
  return uniqueId(base, taken)
}

/** `base`, or `base_2`, `base_3`… whichever is free. Adds it to `taken`. */
export function uniqueId(base: string, taken: Set<string>): string {
  const root = base.slice(0, 60) || 'id'
  let candidate = root
  for (let n = 2; taken.has(candidate); n++) candidate = `${root}_${n}`
  taken.add(candidate)
  return candidate
}

export type TableImport = { dataset: Dataset; warnings: string[] }

/**
 * A new dataset from a table whose first row is the header. Types are inferred per column;
 * columns past MAX_COLUMNS and rows past MAX_ROWS_PER_DATASET are dropped with a warning.
 */
export function datasetFromTable(
  table: string[][],
  meta: { id: string; sourceId: string; title?: string },
): TableImport | { error: string } {
  if (table.length === 0) return { error: 'There is nothing to import.' }
  const warnings: string[] = []
  const header = table[0]
  let width = Math.max(...table.map((row) => row.length))
  if (width > MAX_COLUMNS) {
    warnings.push(`Kept the first ${MAX_COLUMNS} of ${width} columns.`)
    width = MAX_COLUMNS
  }
  let body = table.slice(1)
  if (body.length > MAX_ROWS_PER_DATASET) {
    warnings.push(`Kept the first ${MAX_ROWS_PER_DATASET} of ${body.length} rows.`)
    body = body.slice(0, MAX_ROWS_PER_DATASET)
  }
  const taken = new Set<string>()
  const columns: DataColumn[] = []
  for (let i = 0; i < width; i++) {
    const label = (header[i] ?? '').trim().slice(0, 200) || `Column ${i + 1}`
    columns.push({
      key: columnKey(label === `Column ${i + 1}` ? `col_${i + 1}` : label, taken),
      label,
      type: inferColumnType(body.map((row) => row[i] ?? '')),
    })
  }
  const { rows } = coerceRows(columns, body, (_, i) => i)
  return { dataset: { id: meta.id, sourceId: meta.sourceId, ...(meta.title ? { title: meta.title } : {}), columns, rows }, warnings }
}

function coerceRows(
  columns: DataColumn[],
  body: string[][],
  fieldIndex: (column: DataColumn, columnIndex: number) => number | undefined,
): { rows: DataRow[]; rejected: number } {
  let rejected = 0
  const rows = body.map((fields) => {
    const row: DataRow = {}
    columns.forEach((column, i) => {
      const at = fieldIndex(column, i)
      if (at === undefined) return
      const { cell, ok } = coerceCell(fields[at] ?? '', column.type)
      if (!ok) rejected++
      row[column.key] = cell
    })
    return row
  })
  return { rows, rejected }
}

const norm = (text: string) => text.trim().toLowerCase()

/**
 * Rows for an existing dataset from a table. When the first row names the dataset's columns
 * (by key or label: every field in it does, or at least half the columns match), fields map by
 * name and that row is the header; otherwise fields map by position and every row is data.
 */
export function rowsFromTable(
  dataset: Dataset,
  table: string[][],
): { rows: DataRow[]; rejected: number; header: boolean } {
  const first = table[0] ?? []
  const names = first.map(norm)
  const byName = new Map<string, number>()
  for (const column of dataset.columns) {
    const at = names.findIndex((name) => name === norm(column.key) || name === norm(column.label))
    if (at !== -1) byName.set(column.key, at)
  }
  // A header names columns: every field it has does (a subset is fine), or at least half of them match.
  const known = new Set(dataset.columns.flatMap((c) => [norm(c.key), norm(c.label)]))
  const allNamed = names.some((n) => n !== '') && names.every((n) => n === '' || known.has(n))
  const header = byName.size > 0 && (allNamed || byName.size >= Math.ceil(dataset.columns.length / 2))
  const body = header ? table.slice(1) : table
  const { rows, rejected } = coerceRows(dataset.columns, body, (column, i) =>
    header ? byName.get(column.key) : i,
  )
  return { rows, rejected, header }
}

/**
 * JSON rows as a table: an array of objects (or `{ "rows": [...] }`), its header the keys in the
 * order first seen. Values become text and are typed like CSV fields; nested values are refused.
 * Null when the text is not that shape.
 */
export function tableFromJson(text: string): string[][] | { error: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows)
      ? (value as { rows: unknown[] }).rows
      : null
  if (!rows) return { error: 'JSON data is an array of row objects, or {"rows": [...]}.' }
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: 'Every JSON row must be an object of column: value.' }
    for (const key of Object.keys(row)) if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  const body: string[][] = []
  for (const row of rows as Array<Record<string, unknown>>) {
    const line: string[] = []
    for (const key of keys) {
      const v = row[key]
      if (v === null || v === undefined) line.push('')
      else if (typeof v === 'string') line.push(v.slice(0, MAX_CELL_CHARS))
      else if (typeof v === 'number' || typeof v === 'boolean') line.push(String(v))
      else return { error: `"${key}" holds a nested value; flatten it to text or a number first.` }
    }
    body.push(line)
  }
  return [keys, ...body]
}

/** Pasted or uploaded text as a table: JSON rows when it is JSON, else CSV/TSV. */
export function parseImportText(text: string): string[][] | { error: string } {
  return tableFromJson(text) ?? parseTable(text)
}

export type ImportResult =
  | { ok: true; dashboard: Dashboard; message: string; datasetId: string }
  | { ok: false; error: string }

function plural(n: number, word: string) {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
}

/** Replace a dataset's rows with, or append, the rows in pasted CSV/TSV text. */
export function importRows(
  dashboard: Dashboard,
  datasetId: string,
  text: string,
  mode: 'replace' | 'append',
): ImportResult {
  const index = dashboard.datasets.findIndex((d) => d.id === datasetId)
  if (index === -1) return { ok: false, error: `There is no dataset "${datasetId}".` }
  const dataset = dashboard.datasets[index]
  const table = parseImportText(text)
  if ('error' in table) return { ok: false, error: table.error }
  const { rows, rejected } = rowsFromTable(dataset, table)
  if (rows.length === 0) return { ok: false, error: 'No rows found in the pasted text.' }
  const all = mode === 'append' ? [...dataset.rows, ...rows] : rows
  if (all.length > MAX_ROWS_PER_DATASET) {
    return { ok: false, error: `A dataset holds at most ${MAX_ROWS_PER_DATASET} rows; that would make ${all.length}.` }
  }
  const datasets = [...dashboard.datasets]
  datasets[index] = { ...dataset, rows: all }
  const verb = mode === 'append' ? 'Added' : 'Replaced with'
  const note = rejected > 0 ? ` ${plural(rejected, 'value')} did not fit its column and was left empty.` : ''
  return {
    ok: true,
    dashboard: { ...dashboard, datasets },
    datasetId,
    message: `${verb} ${plural(rows.length, 'row')}.${note}`,
  }
}

/** A file name or title as a dataset id: "Q3 revenue.csv" → "q3_revenue". */
export function datasetIdFrom(name: string, taken: Set<string>): string {
  return columnKey(name.replace(/\.(csv|tsv|txt|json)$/i, '') || 'data', taken)
}

/**
 * A new dataset (and, unless `sourceId` names an existing one, a new source) from CSV/TSV text
 * whose first row is the header.
 */
export function importDataset(
  dashboard: Dashboard,
  input: {
    text: string
    title?: string
    id?: string
    sourceId?: string
    source?: { label: string; detail?: string; window?: string }
  },
): ImportResult {
  if (dashboard.datasets.length >= MAX_DATASETS) {
    return { ok: false, error: `A dashboard holds at most ${MAX_DATASETS} datasets.` }
  }
  const taken = new Set(dashboard.datasets.map((d) => d.id))
  if (input.id !== undefined && taken.has(input.id)) {
    return { ok: false, error: `A dataset "${input.id}" exists already.` }
  }
  let sources = dashboard.sources
  let sourceId = input.sourceId
  if (sourceId !== undefined) {
    if (!sources.some((s) => s.id === sourceId)) return { ok: false, error: `There is no source "${sourceId}".` }
  } else {
    if (sources.length >= MAX_SOURCES) return { ok: false, error: `A dashboard holds at most ${MAX_SOURCES} sources.` }
    const label = (input.source?.label ?? input.title ?? 'Imported data').trim().slice(0, 200) || 'Imported data'
    sourceId = uniqueId(columnKey(label, new Set()), new Set(sources.map((s) => s.id)))
    sources = [
      ...sources,
      {
        id: sourceId,
        label,
        ...(input.source?.detail ? { detail: input.source.detail.slice(0, 2000) } : {}),
        ...(input.source?.window ? { window: input.source.window.slice(0, 200) } : {}),
      },
    ]
  }
  const id = input.id ?? datasetIdFrom(input.title ?? 'data', taken)
  const table = parseImportText(input.text)
  if ('error' in table) return { ok: false, error: table.error }
  const made = datasetFromTable(table, {
    id,
    sourceId,
    title: input.title?.trim().slice(0, 200) || undefined,
  })
  if ('error' in made) return { ok: false, error: made.error }
  if (made.dataset.rows.length === 0) return { ok: false, error: 'Found a header but no rows under it.' }
  const types = made.dataset.columns.filter((c) => isNumericType(c.type) || c.type === 'date').length
  const summary = `Imported ${plural(made.dataset.rows.length, 'row')} and ${plural(made.dataset.columns.length, 'column')} (${types} typed as numbers or dates).`
  return {
    ok: true,
    dashboard: { ...dashboard, sources, datasets: [...dashboard.datasets, made.dataset] },
    datasetId: id,
    message: [summary, ...made.warnings].join(' '),
  }
}

// ---- Agent op argument shapes (the coordinator wires these into kind-ops)

const opId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const MAX_IMPORT_CHARS = 900_000

/** Rows as JSON: an array of flat objects (the agent may send it as an array or as text). */
const jsonRows = z.union([z.string().min(1).max(MAX_IMPORT_CHARS), z.array(z.record(z.string(), z.unknown())).max(MAX_ROWS_PER_DATASET)])
const oneOf = (args: { csv?: string; json?: unknown }) => (args.csv === undefined) !== (args.json === undefined)
const ONE_OF = { message: 'pass exactly one of csv (CSV/TSV text) or json (row objects)' }
const textOf = (args: { csv?: string; json?: string | unknown[] }) =>
  args.csv ?? (typeof args.json === 'string' ? args.json : JSON.stringify(args.json ?? []))

export const importDatasetArgsSchema = z
  .object({
    csv: z.string().min(1).max(MAX_IMPORT_CHARS).optional(),
    json: jsonRows.optional(),
    id: opId.optional(),
    title: z.string().max(200).optional(),
    sourceId: opId.optional(),
    source: z
      .object({ label: z.string().min(1).max(200), detail: z.string().max(2000).optional(), window: z.string().max(200).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(oneOf, ONE_OF)

export const importRowsArgsSchema = z
  .object({
    datasetId: opId,
    csv: z.string().min(1).max(MAX_IMPORT_CHARS).optional(),
    json: jsonRows.optional(),
    mode: z.enum(['replace', 'append']),
  })
  .strict()
  .refine(oneOf, ONE_OF)

/** The `importDataset` agent op: a new dataset from CSV/TSV text (first row the header). */
export function importDatasetOp(dashboard: Dashboard, args: z.infer<typeof importDatasetArgsSchema>): ImportResult {
  return importDataset(dashboard, { text: textOf(args), id: args.id, title: args.title, sourceId: args.sourceId, source: args.source })
}

/** The `importRows` agent op: replace or append a dataset's rows from CSV/TSV text. */
export function importRowsOp(dashboard: Dashboard, args: z.infer<typeof importRowsArgsSchema>): ImportResult {
  return importRows(dashboard, args.datasetId, textOf(args), args.mode)
}
