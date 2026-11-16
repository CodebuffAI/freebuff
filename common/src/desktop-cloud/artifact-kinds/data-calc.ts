/**
 * Freebuff Data: calculated columns and parameters. A small, safe expression language (no
 * `eval`, no property access, no loops) that the schema checks and the app evaluates per row.
 *
 *   [revenue] / [users]                      a column, in square brackets (ids may hold "-")
 *   [price] * (1 + {growth})                 a dashboard parameter, in braces
 *   IF([latency] > {slow_ms}, "slow", "ok")  functions: IF, ROUND, ABS, MIN, MAX, COALESCE,
 *                                            AND, OR, NOT, FLOOR, CEIL
 *   [first] & " " & [last]                   & joins text
 *
 * Operators by precedence (low to high): comparison (= != <> < <= > >=), & (join), + -, * / %,
 * ^ (right-associative), unary - and +. A missing cell, a division by zero or anything
 * non-finite is null, and null spreads through arithmetic (COALESCE picks the first non-null).
 * A calculated column may read the dataset's stored columns and calculated columns listed
 * before it, never itself or a later one, so there are no cycles.
 *
 * Pure (no React, no DOM): the server validates with exactly the rules the app computes by.
 */

import type { Cell, Dashboard, DataColumn, DataRow, Dataset } from './data'

export const MAX_EXPR_LENGTH = 500
const MAX_DEPTH = 32

// ---- AST

export type CalcNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'col'; key: string }
  | { t: 'param'; id: string }
  | { t: 'neg'; x: CalcNode }
  | { t: 'bin'; op: string; a: CalcNode; b: CalcNode }
  | { t: 'call'; fn: CalcFunction; args: CalcNode[] }

export const CALC_FUNCTIONS = ['IF', 'ROUND', 'ABS', 'MIN', 'MAX', 'COALESCE', 'AND', 'OR', 'NOT', 'FLOOR', 'CEIL'] as const
export type CalcFunction = (typeof CALC_FUNCTIONS)[number]

const ARITY: Record<CalcFunction, [number, number]> = {
  IF: [2, 3],
  ROUND: [1, 2],
  ABS: [1, 1],
  MIN: [1, 16],
  MAX: [1, 16],
  COALESCE: [1, 16],
  AND: [1, 16],
  OR: [1, 16],
  NOT: [1, 1],
  FLOOR: [1, 1],
  CEIL: [1, 1],
}

export type CalcParse = { ok: true; node: CalcNode } | { ok: false; error: string }

type Token =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'col'; v: string }
  | { k: 'param'; v: string }
  | { k: 'name'; v: string }
  | { k: 'op'; v: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/

function tokenize(source: string): Token[] | string {
  const out: Token[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}'
      const end = source.indexOf(close, i + 1)
      if (end === -1) return `"${c}" at ${i + 1} has no closing "${close}"`
      const name = source.slice(i + 1, end).trim()
      if (!ID.test(name)) return `"${c}${name}${close}" is not a ${c === '[' ? 'column' : 'parameter'} id`
      out.push({ k: c === '[' ? 'col' : 'param', v: name })
      i = end + 1
      continue
    }
    if (c === '"') {
      let text = ''
      let j = i + 1
      for (; j < source.length; j++) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') {
            text += '"'
            j++
            continue
          }
          break
        }
        text += source[j]
      }
      if (j >= source.length) return 'a text in quotes is not closed'
      out.push({ k: 'str', v: text })
      i = j + 1
      continue
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i))
    if (num) {
      out.push({ k: 'num', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))
    if (name) {
      out.push({ k: 'name', v: name[0] })
      i += name[0].length
      continue
    }
    const two = source.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>') {
      out.push({ k: 'op', v: two === '<>' ? '!=' : two })
      i += 2
      continue
    }
    if ('+-*/%^&=<>(),'.includes(c)) {
      out.push({ k: 'op', v: c })
      i++
      continue
    }
    return `unexpected "${c}" at ${i + 1}`
  }
  return out
}

/** Parse an expression. Never throws; an error says what is wrong in plain words. */
export function parseCalc(source: string): CalcParse {
  if (source.length > MAX_EXPR_LENGTH) return { ok: false, error: `an expression is at most ${MAX_EXPR_LENGTH} characters` }
  const tokens = tokenize(source)
  if (typeof tokens === 'string') return { ok: false, error: tokens }
  if (tokens.length === 0) return { ok: false, error: 'the expression is empty' }
  let pos = 0
  let depth = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => {
    const t = tokens[pos]
    return t?.k === 'op' && t.v === v
  }
  class Fail extends Error {}
  const fail = (message: string): never => {
    throw new Fail(message)
  }
  const enter = () => {
    if (++depth > MAX_DEPTH) fail('the expression is nested too deeply')
  }

  const binary = (ops: string[], next: () => CalcNode) => (): CalcNode => {
    let left = next()
    for (let t = peek(); t?.k === 'op' && ops.includes(t.v); t = peek()) {
      pos++
      const op = t.v
      left = { t: 'bin', op, a: left, b: next() }
    }
    return left
  }

  const primary = (): CalcNode => {
    enter()
    try {
      const t = tokens[pos++]
      if (!t) return fail('the expression ends too soon')
      switch (t.k) {
        case 'num':
          return { t: 'num', v: t.v }
        case 'str':
          return { t: 'str', v: t.v }
        case 'col':
          return { t: 'col', key: t.v }
        case 'param':
          return { t: 'param', id: t.v }
        case 'name': {
          const fn = t.v.toUpperCase()
          if (fn === 'TRUE' || fn === 'FALSE') return { t: 'num', v: fn === 'TRUE' ? 1 : 0 }
          if (!(CALC_FUNCTIONS as readonly string[]).includes(fn)) {
            return fail(`unknown name "${t.v}" (columns go in [brackets], parameters in {braces})`)
          }
          if (!isOp('(')) return fail(`${fn} needs "(" after it`)
          pos++
          const args: CalcNode[] = []
          if (!isOp(')')) {
            for (;;) {
              args.push(comparison())
              if (isOp(',')) {
                pos++
                continue
              }
              break
            }
          }
          if (!isOp(')')) return fail(`${fn}( is not closed`)
          pos++
          const [min, max] = ARITY[fn as CalcFunction]
          if (args.length < min || args.length > max) {
            return fail(`${fn} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? '' : 's'}`)
          }
          return { t: 'call', fn: fn as CalcFunction, args }
        }
        case 'op':
          if (t.v === '(') {
            const inner = comparison()
            if (!isOp(')')) return fail('a "(" is not closed')
            pos++
            return inner
          }
          if (t.v === '-' || t.v === '+') {
            const x = power()
            return t.v === '-' ? { t: 'neg', x } : x
          }
          return fail(`unexpected "${t.v}"`)
      }
    } finally {
      depth--
    }
  }

  // ^ binds tightest and is right-associative; unary minus is read in primary.
  const power = (): CalcNode => {
    const base = primary()
    if (isOp('^')) {
      pos++
      enter()
      try {
        return { t: 'bin', op: '^', a: base, b: power() }
      } finally {
        depth--
      }
    }
    return base
  }
  const product = binary(['*', '/', '%'], power)
  const sum = binary(['+', '-'], product)
  const join = binary(['&'], sum)
  const comparison = binary(['=', '!=', '<', '<=', '>', '>='], join)

  try {
    const node = comparison()
    if (pos < tokens.length) {
      const t = tokens[pos]
      return { ok: false, error: `unexpected ${t.k === 'op' ? `"${t.v}"` : 'value'} after the expression` }
    }
    return { ok: true, node }
  } catch (error) {
    if (error instanceof Fail) return { ok: false, error: error.message }
    throw error
  }
}

/** Every column and parameter an expression reads. */
export function calcReferences(node: CalcNode): { columns: Set<string>; params: Set<string> } {
  const columns = new Set<string>()
  const params = new Set<string>()
  const walk = (n: CalcNode) => {
    if (n.t === 'col') columns.add(n.key)
    else if (n.t === 'param') params.add(n.id)
    else if (n.t === 'neg') walk(n.x)
    else if (n.t === 'bin') {
      walk(n.a)
      walk(n.b)
    } else if (n.t === 'call') n.args.forEach(walk)
  }
  walk(node)
  return { columns, params }
}

// ---- Evaluation

type Value = number | string | null

const own = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key)

const finite = (n: number): number | null => (Number.isFinite(n) ? n : null)
const truthy = (v: Value) => (typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v !== '' : false)
const asNumber = (v: Value): number | null => {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** One expression over one row. Never throws; anything undefined is null. */
export function evaluateCalc(node: CalcNode, row: DataRow, params: Record<string, number>): Value {
  switch (node.t) {
    case 'num':
      return node.v
    case 'str':
      return node.v
    case 'col': {
      const cell = own(row, node.key) ? row[node.key] : null
      return cell === undefined ? null : cell
    }
    case 'param':
      return own(params, node.id) && Number.isFinite(params[node.id]) ? params[node.id] : null
    case 'neg': {
      const x = asNumber(evaluateCalc(node.x, row, params))
      return x === null ? null : -x
    }
    case 'bin': {
      const a = evaluateCalc(node.a, row, params)
      const b = evaluateCalc(node.b, row, params)
      if (node.op === '&') return `${a ?? ''}${b ?? ''}`
      if (['=', '!=', '<', '<=', '>', '>='].includes(node.op)) {
        if (a === null || b === null) return node.op === '=' ? (a === b ? 1 : 0) : node.op === '!=' ? (a === b ? 0 : 1) : null
        const x = asNumber(a)
        const y = asNumber(b)
        const order =
          x !== null && y !== null ? x - y : String(a).localeCompare(String(b), 'en-US', { sensitivity: 'accent' })
        switch (node.op) {
          case '=':
            return order === 0 ? 1 : 0
          case '!=':
            return order !== 0 ? 1 : 0
          case '<':
            return order < 0 ? 1 : 0
          case '<=':
            return order <= 0 ? 1 : 0
          case '>':
            return order > 0 ? 1 : 0
          default:
            return order >= 0 ? 1 : 0
        }
      }
      const x = asNumber(a)
      const y = asNumber(b)
      if (x === null || y === null) return null
      switch (node.op) {
        case '+':
          return finite(x + y)
        case '-':
          return finite(x - y)
        case '*':
          return finite(x * y)
        case '/':
          return y === 0 ? null : finite(x / y)
        case '%':
          return y === 0 ? null : finite(x % y)
        default:
          return finite(x ** y)
      }
    }
    case 'call': {
      const arg = (i: number) => evaluateCalc(node.args[i], row, params)
      const nums = () => node.args.map((_, i) => asNumber(arg(i))).filter((n): n is number => n !== null)
      switch (node.fn) {
        case 'IF':
          return truthy(arg(0)) ? arg(1) : node.args.length > 2 ? arg(2) : null
        case 'ROUND': {
          const x = asNumber(arg(0))
          const digits = node.args.length > 1 ? asNumber(arg(1)) : 0
          if (x === null || digits === null) return null
          const f = 10 ** Math.max(-10, Math.min(10, Math.trunc(digits)))
          return finite(Math.round(x * f) / f)
        }
        case 'ABS': {
          const x = asNumber(arg(0))
          return x === null ? null : Math.abs(x)
        }
        case 'FLOOR': {
          const x = asNumber(arg(0))
          return x === null ? null : Math.floor(x)
        }
        case 'CEIL': {
          const x = asNumber(arg(0))
          return x === null ? null : Math.ceil(x)
        }
        case 'MIN': {
          const values = nums()
          return values.length ? Math.min(...values) : null
        }
        case 'MAX': {
          const values = nums()
          return values.length ? Math.max(...values) : null
        }
        case 'COALESCE':
          for (let i = 0; i < node.args.length; i++) {
            const v = arg(i)
            if (v !== null && v !== '') return v
          }
          return null
        case 'AND':
          return node.args.every((_, i) => truthy(arg(i))) ? 1 : 0
        case 'OR':
          return node.args.some((_, i) => truthy(arg(i))) ? 1 : 0
        case 'NOT':
          return truthy(arg(0)) ? 0 : 1
      }
    }
  }
}

// ---- Dashboards

export type CalculatedColumn = NonNullable<Dataset['calculated']>[number]

/** A parameter's value as the reader set it, else its default. */
export function paramValues(dashboard: Dashboard, chosen: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {}
  for (const param of dashboard.params ?? []) {
    const value = own(chosen, param.id) ? chosen[param.id] : param.default
    out[param.id] = Number.isFinite(value) ? value : param.default
  }
  return out
}

function cellFor(value: Value, type: CalculatedColumn['type']): Cell {
  if (value === null) return null
  if (type === 'string') return typeof value === 'number' ? String(value) : value
  return asNumber(value)
}

/**
 * The dashboard as the page shows it: every dataset's calculated columns appended to its
 * columns, their values computed into each row. Never stored (see `stripCalculated`). A
 * dataset without calculated columns is returned as is.
 */
export function materializeDashboard(dashboard: Dashboard, chosen: Record<string, number> = {}): Dashboard {
  if (!dashboard.datasets.some((d) => d.calculated?.length)) return dashboard
  const params = paramValues(dashboard, chosen)
  return {
    ...dashboard,
    datasets: dashboard.datasets.map((dataset) => {
      const calculated = dataset.calculated ?? []
      if (calculated.length === 0) return dataset
      const stored = new Set(dataset.columns.map((c) => c.key))
      const parsed = calculated
        .filter((c) => !stored.has(c.key))
        .map((c) => ({ column: c, node: parseCalc(c.expr) }))
      const columns: DataColumn[] = [
        ...dataset.columns,
        ...parsed.map(({ column }) => ({ key: column.key, label: column.label, type: column.type })),
      ]
      const rows = dataset.rows.map((row) => {
        const next: DataRow = { ...row }
        for (const { column, node } of parsed) {
          next[column.key] = node.ok ? cellFor(evaluateCalc(node.node, next, params), column.type) : null
        }
        return next
      })
      return { ...dataset, columns, rows }
    }),
  }
}

/** Undo `materializeDashboard`: calculated values never reach a stored body. */
export function stripCalculated(dashboard: Dashboard): Dashboard {
  if (!dashboard.datasets.some((d) => d.calculated?.length)) return dashboard
  return {
    ...dashboard,
    datasets: dashboard.datasets.map((dataset) => {
      const keys = new Set((dataset.calculated ?? []).map((c) => c.key))
      if (keys.size === 0 || !dataset.columns.some((c) => keys.has(c.key))) return dataset
      return {
        ...dataset,
        columns: dataset.columns.filter((c) => !keys.has(c.key)),
        rows: dataset.rows.map((row) => {
          const next: DataRow = {}
          for (const [key, value] of Object.entries(row)) if (!keys.has(key)) next[key] = value
          return next
        }),
      }
    }),
  }
}

/**
 * What is wrong with a dataset's calculated columns, each `[index, field, message]`: the
 * expression must parse, read only known columns (stored, or calculated earlier) and declared
 * parameters, and its key must not shadow a stored column.
 */
export function calculatedIssues(
  dataset: Dataset,
  paramIds: ReadonlySet<string>,
): Array<{ index: number; field: 'key' | 'expr'; message: string }> {
  const issues: Array<{ index: number; field: 'key' | 'expr'; message: string }> = []
  const known = new Set(dataset.columns.map((c) => c.key))
  ;(dataset.calculated ?? []).forEach((column, index) => {
    if (column.key === '__proto__' || column.key === 'constructor' || column.key === 'prototype') {
      issues.push({ index, field: 'key', message: `"${column.key}" is reserved; choose another key` })
      return
    }
    if (known.has(column.key)) {
      issues.push({ index, field: 'key', message: `"${column.key}" is already a column of dataset "${dataset.id}"` })
      return
    }
    const parsed = parseCalc(column.expr)
    if (!parsed.ok) issues.push({ index, field: 'expr', message: parsed.error })
    else {
      const refs = calcReferences(parsed.node)
      for (const key of refs.columns) {
        if (key === column.key) issues.push({ index, field: 'expr', message: `"${key}" cannot read itself` })
        else if (!known.has(key)) {
          issues.push({
            index,
            field: 'expr',
            message: `unknown column [${key}] (a calculation reads stored columns and calculated ones listed before it)`,
          })
        }
      }
      for (const id of refs.params) {
        if (!paramIds.has(id)) issues.push({ index, field: 'expr', message: `unknown parameter {${id}}` })
      }
    }
    known.add(column.key)
  })
  return issues
}

// ---- Edits (the agent's ops and the app's; the whole body is validated after)

export type CalcEdit = { ok: true; dashboard: Dashboard } | { ok: false; error: string }

const datasetIndex = (dashboard: Dashboard, datasetId: string) => dashboard.datasets.findIndex((d) => d.id === datasetId)
const noDataset = (dashboard: Dashboard, datasetId: string): CalcEdit => ({
  ok: false,
  error: `there is no dataset "${datasetId}"; datasets are ${dashboard.datasets.map((d) => d.id).join(', ') || 'none'}`,
})

/** Add a calculated column, or replace the one with its key (in place). `after` places a new one. */
export function setCalculated(
  dashboard: Dashboard,
  datasetId: string,
  column: CalculatedColumn,
  after?: string,
): CalcEdit {
  const index = datasetIndex(dashboard, datasetId)
  if (index === -1) return noDataset(dashboard, datasetId)
  const dataset = dashboard.datasets[index]
  const list = [...(dataset.calculated ?? [])]
  const at = list.findIndex((c) => c.key === column.key)
  if (at !== -1) list[at] = column
  else if (after === undefined) list.push(column)
  else {
    const before = after === '' ? -1 : list.findIndex((c) => c.key === after)
    if (after !== '' && before === -1) return { ok: false, error: `there is no calculated column "${after}" to insert after` }
    list.splice(before + 1, 0, column)
  }
  const datasets = [...dashboard.datasets]
  datasets[index] = { ...dataset, calculated: list }
  return { ok: true, dashboard: { ...dashboard, datasets } }
}

export function removeCalculated(dashboard: Dashboard, datasetId: string, key: string): CalcEdit {
  const index = datasetIndex(dashboard, datasetId)
  if (index === -1) return noDataset(dashboard, datasetId)
  const dataset = dashboard.datasets[index]
  if (!(dataset.calculated ?? []).some((c) => c.key === key)) {
    return { ok: false, error: `dataset "${datasetId}" has no calculated column "${key}"` }
  }
  const list = (dataset.calculated ?? []).filter((c) => c.key !== key)
  const datasets = [...dashboard.datasets]
  const { calculated: _old, ...rest } = dataset
  datasets[index] = list.length ? { ...dataset, calculated: list } : rest
  return { ok: true, dashboard: { ...dashboard, datasets } }
}

type Param = NonNullable<Dashboard['params']>[number]

export function setParam(dashboard: Dashboard, param: Param): CalcEdit {
  const list = [...(dashboard.params ?? [])]
  const at = list.findIndex((p) => p.id === param.id)
  if (at === -1) list.push(param)
  else list[at] = param
  return { ok: true, dashboard: { ...dashboard, params: list } }
}

/** Remove a parameter no calculation reads. */
export function removeParam(dashboard: Dashboard, id: string): CalcEdit {
  if (!(dashboard.params ?? []).some((p) => p.id === id)) return { ok: false, error: `there is no parameter "${id}"` }
  const readers: string[] = []
  for (const dataset of dashboard.datasets) {
    for (const column of dataset.calculated ?? []) {
      const parsed = parseCalc(column.expr)
      if (parsed.ok && calcReferences(parsed.node).params.has(id)) readers.push(`${dataset.id}.${column.key}`)
    }
  }
  if (readers.length) return { ok: false, error: `{${id}} is read by ${readers.join(', ')}; change those first` }
  const list = (dashboard.params ?? []).filter((p) => p.id !== id)
  const { params: _old, ...rest } = dashboard
  return { ok: true, dashboard: list.length ? { ...dashboard, params: list } : rest }
}
