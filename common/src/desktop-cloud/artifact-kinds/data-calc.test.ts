import { describe, expect, test } from 'bun:test'

import { parseDashboard, type Dashboard } from './data'
import {
  calcReferences,
  evaluateCalc,
  materializeDashboard,
  paramValues,
  parseCalc,
  stripCalculated,
  type CalcNode,
} from './data-calc'

/**
 * A body as stored before round 3 (round-2 fields included: combo, span, references,
 * annotations, heatmap, display "trend"), frozen as JSON text. It must parse, and parse to
 * exactly itself: round 3 adds only optional keys and no defaults.
 */
const PRE_R3_BODY = `{"version":1,"title":"Ops","layout":"grid","sources":[{"id":"wh","label":"Warehouse"}],
"datasets":[{"id":"d","sourceId":"wh","columns":[{"key":"week","label":"Week","type":"date"},{"key":"users","label":"Users","type":"number"},{"key":"rev","label":"Revenue","type":"currency"},{"key":"plat","label":"Platform","type":"string"}],
"rows":[{"week":"2026-11-02","users":100,"rev":500,"plat":"Web"},{"week":"2026-11-09","users":120,"rev":660,"plat":"CLI"}]}],
"blocks":[{"kind":"kpi","id":"k","label":"Users","datasetId":"d","value":{"column":"users","agg":"sum"},"sparkline":"week","display":"trend","delta":{"vs":"previous","format":"percent"},"format":"integer","sourceId":"wh","span":2},
{"kind":"chart","id":"c","title":"Mix","type":"combo","datasetId":"d","x":"week","series":[{"key":"users","label":"Users","as":"bar"},{"key":"rev","label":"Revenue","as":"line"}],"sourceId":"wh","span":3,"references":[{"value":110,"label":"Goal"}],"annotations":[{"x":"2026-11-09","label":"Launch"}]},
{"kind":"table","id":"t","title":"Rows","datasetId":"d","heatmap":["users"],"span":4}],
"filters":[{"id":"range","label":"Weeks","datasetIds":["d"],"column":"week","type":"date-range"}]}`

const evaluate = (source: string, row: Record<string, string | number | null> = {}, params: Record<string, number> = {}) => {
  const parsed = parseCalc(source)
  if (!parsed.ok) throw new Error(parsed.error)
  return evaluateCalc(parsed.node, row, params)
}

const parseError = (source: string) => {
  const parsed = parseCalc(source)
  return parsed.ok ? null : parsed.error
}

describe('calculated columns: the expression language', () => {
  test('arithmetic follows precedence; ^ is right-associative; unary minus', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7)
    expect(evaluate('(1 + 2) * 3')).toBe(9)
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512)
    expect(evaluate('-2 + 5')).toBe(3)
    expect(evaluate('7 % 3')).toBe(1)
    expect(evaluate('1.5e2 / 3')).toBe(50)
  })

  test('columns in brackets (ids may hold "-"), parameters in braces', () => {
    expect(evaluate('[rev] / [users-total]', { rev: 600, 'users-total': 120 })).toBe(5)
    expect(evaluate('[price] * (1 + {growth})', { price: 100 }, { growth: 0.1 })).toBeCloseTo(110)
    expect(evaluate('{missing} + 1')).toBeNull()
  })

  test('null spreads; division by zero is null; COALESCE picks the first value', () => {
    expect(evaluate('[a] + 1', { a: null })).toBeNull()
    expect(evaluate('[nope] * 2', {})).toBeNull()
    expect(evaluate('1 / 0')).toBeNull()
    expect(evaluate('COALESCE([a], [b], 0)', { a: null, b: 4 })).toBe(4)
    expect(evaluate('10 ^ 400')).toBeNull()
  })

  test('comparisons, IF and logic; text joins with &', () => {
    expect(evaluate('IF([ms] > {slow}, "slow", "ok")', { ms: 900 }, { slow: 500 })).toBe('slow')
    expect(evaluate('IF([ms] > {slow}, "slow", "ok")', { ms: 100 }, { slow: 500 })).toBe('ok')
    expect(evaluate('[plat] = "web"', { plat: 'Web' })).toBe(1)
    expect(evaluate('[plat] <> "Web"', { plat: 'Web' })).toBe(0)
    expect(evaluate('AND(1, [x] >= 2, NOT(0))', { x: 2 })).toBe(1)
    expect(evaluate('OR(0, FALSE)')).toBe(0)
    expect(evaluate('[a] & " / " & [b]', { a: 'x', b: 3 })).toBe('x / 3')
    expect(evaluate('IF(0, 1)')).toBeNull()
  })

  test('functions', () => {
    expect(evaluate('ROUND(2.345, 2)')).toBe(2.35)
    expect(evaluate('ROUND(1234, -2)')).toBe(1200)
    expect(evaluate('ABS(-3) + FLOOR(2.7) + CEIL(0.2)')).toBe(6)
    expect(evaluate('MIN(3, [x], 9)', { x: 1 })).toBe(1)
    expect(evaluate('MAX([x], [y])', { x: null, y: 2 })).toBe(2)
  })

  test('the row and parameters are read as own properties only', () => {
    expect(evaluate('[constructor] + 1', {})).toBeNull()
    expect(evaluate('[__proto__]', {})).toBeNull()
    expect(evaluate('{toString}', {}, {})).toBeNull()
  })

  test('bad input says what is wrong, never throws', () => {
    expect(parseError('')).toContain('empty')
    expect(parseError('[a')).toContain('closing')
    expect(parseError('users + 1')).toContain('unknown name "users"')
    expect(parseError('ROUND(1, 2, 3)')).toContain('ROUND takes 1 to 2 arguments')
    expect(parseError('1 +')).toContain('ends too soon')
    expect(parseError('(1 + 2')).toContain('not closed')
    expect(parseError('1 2')).toContain('after the expression')
    expect(parseError('"open')).toContain('not closed')
    expect(parseError('1 ; 2')).toContain('unexpected ";"')
    expect(parseError('x'.repeat(501))).toContain('at most 500')
    expect(parseError(`${'('.repeat(40)}1${')'.repeat(40)}`)).toContain('nested too deeply')
    expect(parseError('[a b]')).toContain('not a column id')
  })

  test('references lists every column and parameter read', () => {
    const parsed = parseCalc('IF([a] > {t}, [b], MAX([c], {u}))')
    if (!parsed.ok) throw new Error(parsed.error)
    const refs = calcReferences(parsed.node as CalcNode)
    expect([...refs.columns].sort()).toEqual(['a', 'b', 'c'])
    expect([...refs.params].sort()).toEqual(['t', 'u'])
  })
})

describe('calculated columns and parameters in a dashboard', () => {
  const body = (): Dashboard => {
    const d = JSON.parse(PRE_R3_BODY) as Dashboard
    d.params = [{ id: 'target', label: 'Target per user', default: 5, min: 0, step: 0.5, format: 'currency' }]
    d.datasets[0].calculated = [
      { key: 'arpu', label: 'Revenue per user', type: 'currency', expr: '[rev] / [users]' },
      { key: 'gap', label: 'Gap to target', type: 'currency', expr: '[arpu] - {target}' },
      { key: 'hit', label: 'On target', type: 'string', expr: 'IF([gap] >= 0, "yes", "no")' },
    ]
    return d
  }

  test('a pre-round-3 body parses unchanged', () => {
    const input = JSON.parse(PRE_R3_BODY)
    const result = parseDashboard(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.dashboard).toEqual(input)
  })

  test('a body with calculated columns, parameters and rules parses', () => {
    const d = body()
    d.blocks.push({ kind: 'kpi', id: 'k2', label: 'ARPU', datasetId: 'd', value: { column: 'arpu', agg: 'avg' }, format: 'currency', sourceId: 'wh', rules: [{ op: '<', value: 5, tone: 'bad', label: 'Below target' }] })
    d.blocks.push({ kind: 'table', id: 't2', title: 'Hits', datasetId: 'd', columns: ['week', 'arpu', 'hit'], rules: [{ column: 'hit', op: '=', value: 'no', tone: 'warn' }] })
    d.filters = [...(d.filters ?? []), { id: 'hit', label: 'On target', datasetIds: ['d'], column: 'hit', type: 'select' }]
    const result = parseDashboard(d)
    expect(result.ok ? [] : result.issues).toEqual([])
  })

  test('the schema refuses bad calculations, parameters and rules, with paths', () => {
    const d = body()
    d.datasets[0].calculated!.push(
      { key: 'users', label: 'Clash', type: 'number', expr: '1' },
      { key: 'later', label: 'Reads later', type: 'number', expr: '[after] + {nope}' },
      { key: 'after', label: 'After', type: 'number', expr: '[after]' },
      { key: 'broken', label: 'Broken', type: 'number', expr: '1 +' },
    )
    d.params!.push({ id: 'p2', label: 'Bad', default: 10, max: 5 })
    d.blocks.push({ kind: 'table', id: 't2', title: 'T', datasetId: 'd', rules: [{ column: 'ghost', op: '>', value: 'x', tone: 'good' }] })
    d.blocks.push({ kind: 'chart', id: 'c2', title: 'Hits', type: 'bar', datasetId: 'd', x: 'week', series: [{ key: 'hit', label: 'Hit' }], sourceId: 'wh' })
    const result = parseDashboard(d)
    expect(result.ok).toBe(false)
    const issues = result.ok ? [] : result.issues
    expect(issues).toContain('datasets.0.calculated.3.key: "users" is already a column of dataset "d"')
    expect(issues.some((i) => i.startsWith('datasets.0.calculated.4.expr: unknown column [after]'))).toBe(true)
    expect(issues).toContain('datasets.0.calculated.4.expr: unknown parameter {nope}')
    expect(issues).toContain('datasets.0.calculated.5.expr: "after" cannot read itself')
    expect(issues).toContain('datasets.0.calculated.6.expr: the expression ends too soon')
    expect(issues).toContain('params.1.default: the default is above max')
    expect(issues).toContain('blocks.3.rules.0.column: unknown column "ghost" in dataset "d"')
    expect(issues.some((i) => i.startsWith('blocks.3.rules.0.value:'))).toBe(true)
    expect(issues).toContain('blocks.4.series.0.key: series "hit" must be numeric')
  })

  test('a stored row may not carry a calculated column', () => {
    const d = body()
    ;(d.datasets[0].rows[0] as Record<string, unknown>).arpu = 5
    const result = parseDashboard(d)
    expect(result.ok ? [] : result.issues).toContain('datasets.0.rows.0.arpu: "arpu" is not a column of dataset "d"')
  })

  test('materialize computes in order with parameter values; strip gives the stored body back', () => {
    const d = body()
    const shown = materializeDashboard(d)
    const ds = shown.datasets[0]
    expect(ds.columns.map((c) => c.key)).toEqual(['week', 'users', 'rev', 'plat', 'arpu', 'gap', 'hit'])
    expect(ds.rows.map((r) => [r.arpu, r.gap, r.hit])).toEqual([
      [5, 0, 'yes'],
      [5.5, 0.5, 'yes'],
    ])
    const stricter = materializeDashboard(d, { target: 5.25 })
    expect(stricter.datasets[0].rows.map((r) => r.hit)).toEqual(['no', 'yes'])
    expect(stripCalculated(shown)).toEqual(d)
    // Nothing to do is the same object.
    const plain = JSON.parse(PRE_R3_BODY) as Dashboard
    expect(materializeDashboard(plain)).toBe(plain)
    expect(stripCalculated(plain)).toBe(plain)
  })

  test('parameter values: the reader’s, else the default; unknown ids are ignored', () => {
    const d = body()
    expect(paramValues(d)).toEqual({ target: 5 })
    expect(paramValues(d, { target: 7, other: 1 })).toEqual({ target: 7 })
    expect(paramValues(d, { target: Number.NaN })).toEqual({ target: 5 })
  })
})

test('a calculated key that would touch the row prototype is refused', () => {
  const d = JSON.parse(PRE_R3_BODY) as Dashboard
  d.datasets[0].calculated = [{ key: '__proto__', label: 'Bad', type: 'number', expr: '1' }]
  const result = parseDashboard(d)
  expect(result.ok ? [] : result.issues).toContain('datasets.0.calculated.0.key: "__proto__" is reserved; choose another key')
})
