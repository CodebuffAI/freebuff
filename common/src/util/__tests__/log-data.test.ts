import { describe, expect, test } from 'bun:test'

import { serializeLogData } from '../log-data'

const parse = (data: unknown) => JSON.parse(serializeLogData(data)!)

describe('serializeLogData', () => {
  // JSON.stringify(new Error('x')) is '{}': the reason never reached Axiom.
  test('an error keeps its name and message', () => {
    const row = parse({ error: new TypeError('fetch failed') })
    expect(row.error.name).toBe('TypeError')
    expect(row.error.message).toBe('fetch failed')
    expect(typeof row.error.stack).toBe('string')
  })

  test('keeps the fields a library adds, and walks the cause', () => {
    const cause = Object.assign(new Error('canceling statement'), {
      code: '57014',
    })
    const error = Object.assign(new Error('Failed query', { cause }), {
      query: 'select 1',
    })
    const row = parse({ error })
    expect(row.error.query).toBe('select 1')
    expect(row.error.cause.message).toBe('canceling statement')
    expect(row.error.cause.code).toBe('57014')
  })

  // The 2026-10-02 ad-revenue rollup failure: a bulk insert's DrizzleQueryError
  // was 522 KB of SQL and params, the row was cut at the data cap, and the
  // Postgres reason on `cause` never reached Axiom.
  test('a huge failed query keeps its cause and drops the payload', () => {
    const cause = Object.assign(
      new Error('insert or update violates foreign key constraint'),
      { code: '23503', constraint_name: 'ad_revenue_user_daily_user_id_fk' },
    )
    const placeholders = Array.from({ length: 25_000 }, (_, i) => `$${i + 1}`)
    const query = `insert into "ad_revenue_user_daily" values (${placeholders.join(', ')})`
    const params = Array.from({ length: 25_000 }, (_, i) => `user-${i}`)
    const error = Object.assign(
      new Error(`Failed query: ${query}\nparams: ${params.join(',')}`, {
        cause,
      }),
      { query, params },
    )
    const serialized = serializeLogData({ error })!
    expect(serialized.length).toBeLessThan(10_000)
    const row = JSON.parse(serialized)
    expect(row._truncated).toBeUndefined()
    expect(row.error.cause.code).toBe('23503')
    expect(row.error.cause.constraint_name).toBe(
      'ad_revenue_user_daily_user_id_fk',
    )
    expect(
      row.error.query.startsWith('insert into "ad_revenue_user_daily"'),
    ).toBe(true)
    expect(row.error.params).toBe('[25000 params omitted]')
    expect(row.error.message.length).toBeLessThan(2_100)
  })

  test('a short failed query keeps its params', () => {
    const error = Object.assign(new Error('Failed query: select $1'), {
      query: 'select $1',
      params: ['x'],
    })
    expect(parse({ error }).error.params).toEqual(['x'])
  })

  test('trims a long stack', () => {
    const error = new Error('deep')
    error.stack = `Error: deep\n${'    at frame (file.ts:1:1)\n'.repeat(500)}`
    expect(parse({ error }).error.stack.length).toBeLessThanOrEqual(2_000)
  })

  test('plain payloads are unchanged', () => {
    expect(serializeLogData({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}')
    expect(serializeLogData('text')).toBe('text')
    expect(serializeLogData(null)).toBeNull()
  })

  test('a circular error does not throw', () => {
    const error = new Error('loop') as Error & { self?: unknown }
    error.self = error
    expect(parse({ error }).error.message).toBe('loop')
  })
})
