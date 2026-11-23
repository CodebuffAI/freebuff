/**
 * Running a connected recipe (data-connect.ts), the pure parts: filling its `{{blanks}}`, turning
 * the integration's results into rows (`mapIntegrationRows`), and, for the owner's "Test", an
 * outline of a result's shape to map from. The server route (artifact-data-refresh.ts) does the
 * calls; nothing here fetches.
 *
 * Every refusal is one of `ConnectProblem`'s fixed codes with fixed words (`connectProblemText`):
 * what reaches a dashboard's `lastRun.message`, which every viewer sees, is never a provider's
 * error text or any part of a payload.
 */

import { blankValue, type RecipeOptions } from './data-recipe'
import {
  INTEGRATION_MAX_ROWS,
  pathSegments,
  type IntegrationCall,
  type IntegrationMap,
  type IntegrationRecipe,
} from './data-connect'
import type { Cell, ColumnType, Dashboard, DataColumn, DataRow } from './data'

/** Mirrors data-recipe.ts SAFE_ARG_VALUE: a blank's value is plain text, never syntax. */
const SAFE_VALUE = /^[A-Za-z0-9 _.:,@/+=]{0,120}$/
const BLANK = /\{\{([A-Za-z0-9_-]+)\}\}/g
const WHOLE_BLANK = /^\{\{([A-Za-z0-9_-]+)\}\}$/
const MAX_CELL_CHARS = 1000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

export type ConnectProblem =
  | 'not_connected'
  | 'pending'
  | 'not_read_only'
  | 'blank_unsafe'
  | 'call_failed'
  | 'too_large'
  | 'no_list'
  | 'unknown_column'
  | 'bad_rows'
  | 'checks_failed'
  | 'timeout'
  | 'unavailable'
  | 'changed'

const PROBLEM_TEXT: Record<ConnectProblem, string> = {
  not_connected: "The source app isn't connected on the owner's account any more.",
  pending: 'The connected source is waiting for the owner to approve it.',
  not_read_only: 'A call in the recipe could change data in the app, so it was not run.',
  blank_unsafe: 'A filter value cannot go into the source call (plain letters, digits and _.:,@/+= only).',
  call_failed: 'The source app returned an error.',
  too_large: 'The source returned too much data. Narrow the call (fewer items or a filter).',
  no_list: "The source's answer had no list of records where the recipe expects one.",
  unknown_column: 'The recipe maps a column the dataset does not have.',
  bad_rows: "The mapped rows don't fit the dataset's columns.",
  checks_failed: "The new rows break the dataset's checks, so the old rows were kept.",
  timeout: 'The source took too long to answer.',
  unavailable: 'Integrations are unavailable right now. Try again.',
  changed: 'The recipe changed while it ran. Refresh again.',
}

/** The fixed words for a problem: safe for any viewer. */
export const connectProblemText = (problem: ConnectProblem) => PROBLEM_TEXT[problem]

/** One call's outcome, as integrations `run` returns it ({tool, account?, data} or {tool, error}). */
export type IntegrationCallOutcome = { tool: string; account?: string; data?: unknown; error?: string }

/**
 * A recipe's calls with their blanks filled from the reader's values (`options`), or the
 * defaults when there are none. A value must be plain text (`SAFE_VALUE`, not starting with
 * "-"); a string that is exactly one parameter's blank becomes that number.
 */
export function fillIntegrationCalls(
  dashboard: Dashboard,
  how: IntegrationRecipe,
  options: RecipeOptions = {},
): { calls: IntegrationCall[] } | { problem: 'blank_unsafe' } {
  let unsafe = false
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = WHOLE_BLANK.exec(value)
      if (whole && dashboard.params?.some((p) => p.id === whole[1])) {
        const number = Number(blankValue(dashboard, whole[1]!, options))
        if (Number.isFinite(number)) return number
      }
      return value.replace(BLANK, (_match, id: string) => {
        const text = blankValue(dashboard, id, options) ?? ''
        if (!SAFE_VALUE.test(text) || text.startsWith('-')) unsafe = true
        return text
      })
    }
    if (Array.isArray(value)) return value.map(fill)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fill(item)]))
    return value
  }
  const calls = how.calls.map((call) => ({ ...call, arguments: fill(call.arguments) as Record<string, unknown> }))
  return unsafe ? { problem: 'blank_unsafe' } : { calls }
}

/** The value at a path, or undefined. Own properties only. */
export function readPath(value: unknown, path: string): unknown {
  const segments = pathSegments(path)
  if (!segments) return undefined
  let current = value
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current
}

const NUMERIC = new Set<ColumnType>(['number', 'currency', 'percent'])
const NUMBER_TEXT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

/** A value coerced to a column's type: a cell, or `undefined` when it cannot be one. */
export function coerceCell(value: unknown, type: ColumnType, scale?: number): Cell | undefined {
  if (value === null || value === undefined) return null
  if (NUMERIC.has(type)) {
    let n: number
    if (typeof value === 'number') n = value
    else if (typeof value === 'string') {
      const text = value.trim().replace(/^[$€£¥]/, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(/%$/, '')
      if (!NUMBER_TEXT.test(text)) return undefined
      n = Number(text)
    } else return undefined
    if (scale !== undefined) n *= scale
    return Number.isFinite(n) ? n : undefined
  }
  if (type === 'date') {
    if (typeof value === 'string') {
      const match = ISO_DATE.exec(value.trim())
      if (!match) return undefined
      const [, y, m, d] = match
      const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
      return date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d) ? `${y}-${m}-${d}` : undefined
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Epoch seconds or milliseconds.
      const ms = Math.abs(value) < 1e11 ? value * 1000 : value
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
    }
    return undefined
  }
  if (typeof value === 'string') return value.slice(0, MAX_CELL_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item)))
    return value.filter((item) => item !== null).join(', ').slice(0, MAX_CELL_CHARS)
  return undefined
}

export type MappedRows =
  | { ok: true; rows: DataRow[]; dropped: number; blanked: number }
  | { ok: false; problem: ConnectProblem }

/**
 * The rows a recipe's results make: for each call in order, the list at `map.records` in its
 * data, each record read into the mapped columns and coerced to the dataset's column types.
 * Any failed call, a truncated result (integrations cut an oversized one to a text preview),
 * or a missing list fails the whole run: a partial pull is never written as if it were whole.
 * A value that cannot be its column's type becomes empty (`blanked` counts them).
 */
export function mapIntegrationRows(
  outcomes: readonly IntegrationCallOutcome[],
  map: IntegrationMap,
  columns: readonly DataColumn[],
  maxRows = INTEGRATION_MAX_ROWS,
): MappedRows {
  const types = new Map(columns.map((c) => [c.key, c.type]))
  for (const column of map.columns) if (!types.has(column.key)) return { ok: false, problem: 'unknown_column' }
  const cap = Math.min(map.limit ?? INTEGRATION_MAX_ROWS, maxRows, INTEGRATION_MAX_ROWS)
  const rows: DataRow[] = []
  let total = 0
  let blanked = 0
  for (const outcome of outcomes) {
    if (outcome.error !== undefined || !('data' in outcome)) return { ok: false, problem: 'call_failed' }
    const data = outcome.data
    if (data && typeof data === 'object' && !Array.isArray(data) && (data as { truncated?: unknown }).truncated === true)
      return { ok: false, problem: 'too_large' }
    const records = readPath(data, map.records)
    if (!Array.isArray(records)) return { ok: false, problem: 'no_list' }
    for (const record of records) {
      total++
      if (rows.length >= cap) continue
      const row: DataRow = {}
      for (const column of map.columns) {
        const raw =
          column.path === '$account'
            ? (outcome.account ?? null)
            : column.path === '$tool'
              ? outcome.tool
              : column.path === '$index'
                ? rows.length
                : readPath(record, column.path)
        const cell = coerceCell(raw, types.get(column.key)!, column.scale)
        if (cell === undefined) blanked++
        row[column.key] = cell ?? null
      }
      rows.push(row)
    }
  }
  return { ok: true, rows, dropped: total - rows.length, blanked }
}

export type ShapeOutline = {
  /** Paths to lists in the data, with their lengths (largest first). */
  lists: Array<{ path: string; length: number }>
  /** Fields of the first record at `records`: path, JSON type and a short sample. */
  fields: Array<{ path: string; type: string; sample: string }>
}

const join = (base: string, key: string | number) =>
  typeof key === 'number' ? `${base}[${key}]` : base ? `${base}.${key}` : key

/**
 * For the owner's Test only: where the lists are in a result and what a record holds, so they
 * can pick `records` and each column's path. Bounded (depth, entries, sample length).
 */
export function outlineShape(data: unknown, records?: string, max = 60): ShapeOutline {
  const lists: ShapeOutline['lists'] = []
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 5 || lists.length >= 20) return
    if (Array.isArray(value)) {
      lists.push({ path, length: value.length })
      if (value.length && value[0] && typeof value[0] === 'object') visit(value[0], join(path, 0), depth + 1)
      return
    }
    if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value).slice(0, 40)) if (pathSegments(join(path, key))) visit(item, join(path, key), depth + 1)
  }
  visit(data, '', 0)
  lists.sort((a, b) => b.length - a.length)
  const fields: ShapeOutline['fields'] = []
  const list = readPath(data, records ?? lists[0]?.path ?? '')
  const first = Array.isArray(list) ? list.find((item) => item && typeof item === 'object') : undefined
  const walk = (value: unknown, path: string, depth: number) => {
    if (fields.length >= max) return
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3) {
      for (const [key, item] of Object.entries(value)) if (pathSegments(join(path, key))) walk(item, join(path, key), depth + 1)
      return
    }
    if (!path) return
    const type = value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
    fields.push({ path, type, sample: text.length > 40 ? `${text.slice(0, 39)}…` : text })
  }
  if (first) walk(first, '', 0)
  return { lists, fields }
}
