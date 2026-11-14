import { describe, expect, test } from 'bun:test'

import { serializeLogData, toJsonSafeLogData } from '../log-data'

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

  // A failed auth insert's params are OAuth tokens (2026-10-19).
  test('a short failed query drops its params everywhere', () => {
    const error = Object.assign(
      new Error(
        'Failed query: insert into "account" values ($1)\nparams: ya29.secret',
      ),
      { query: 'insert into "account" values ($1)', params: ['ya29.secret'] },
    )
    const serialized = serializeLogData({ error })!
    expect(serialized).not.toContain('ya29.secret')
    expect(JSON.parse(serialized).error.params).toBe('[1 params omitted]')
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

  // Historical shape of the CLI's `Agent execution failed` payload, pre-2026-10-23.
  // Measured 2026-10-14: 171 of 281 rows in one hour (61%, 149 distinct users) reached
  // Axiom with no queryable error, agent or run id, because `messageHistory`
  // and `systemPrompt` alone run past the cap and the whole payload collapsed
  // to one `preview` string.
  test('an oversized payload keeps the fields that identify it', () => {
    const row = parse({
      error: new Error('The operation timed out.'),
      agentType: 'base3-free-catalog',
      agentId: 'main-agent',
      runId: '01a13ac8-f860-7923-8467-2bd9285a595e',
      totalSteps: 14,
      creditsUsed: 20,
      systemPrompt: 'x'.repeat(40_000),
      messageHistory: Array.from({ length: 400 }, (_, i) => ({
        role: 'user',
        content: `turn ${i} ${'y'.repeat(300)}`,
      })),
    })
    // The small fields a query needs, every one of which used to be lost.
    expect(row.error.message).toBe('The operation timed out.')
    expect(row.agentType).toBe('base3-free-catalog')
    expect(row.agentId).toBe('main-agent')
    expect(row.runId).toBe('01a13ac8-f860-7923-8467-2bd9285a595e')
    expect(row.totalSteps).toBe(14)
    expect(row.creditsUsed).toBe(20)
    // The payloads are what got dropped, and the row says so by name, so
    // "no error" and "the error did not fit" stay distinguishable.
    expect(row._truncated).toBe(true)
    expect(Object.keys(row._omitted)).toContain('messageHistory')
    expect(row.messageHistory).toBeUndefined()
    expect(row.original_bytes).toBeGreaterThan(64_000)
    // Never collapses to the old whole-payload preview when a field fits.
    expect(row.preview).toBeUndefined()
  })

  test('still respects the byte cap', () => {
    const serialized = serializeLogData({
      runId: 'r',
      a: 'x'.repeat(50_000),
      b: 'y'.repeat(50_000),
      c: 'z'.repeat(50_000),
    })!
    expect(serialized.length).toBeLessThanOrEqual(64_000)
    const row = JSON.parse(serialized)
    expect(row.runId).toBe('r')
    // One of the three big fields fits in the remaining budget; the rest are
    // named rather than silently absent.
    expect(Object.keys(row._omitted).length).toBeGreaterThanOrEqual(2)
  })

  test('one field larger than the cap still leaves a readable head', () => {
    const row = parse({ blob: 'x'.repeat(200_000) })
    expect(row._truncated).toBe(true)
    expect(typeof row.preview).toBe('string')
    expect(row.original_bytes).toBeGreaterThan(200_000)
  })

  test('an oversized string or array still collapses to a preview', () => {
    const fromString = JSON.parse(serializeLogData('x'.repeat(100_000))!)
    expect(fromString._truncated).toBe(true)
    expect(typeof fromString.preview).toBe('string')
    const fromArray = parse(Array.from({ length: 20_000 }, (_, i) => i))
    expect(fromArray._truncated).toBe(true)
    expect(typeof fromArray.preview).toBe('string')
  })
})

describe('toJsonSafeLogData', () => {
  // The CLI ships this payload to `/api/logs`, so it is stringified once
  // before the sink's serializer ever runs. Measured 2026-10-14: 49 of 205
  // `[ads] Failed to fetch ad` rows in one hour arrived as `err: {}`.
  test('an error survives a JSON round trip to another process', () => {
    const wire = JSON.parse(
      JSON.stringify(toJsonSafeLogData({ err: new TypeError('fetch failed') })),
    )
    expect(wire.err.name).toBe('TypeError')
    expect(wire.err.message).toBe('fetch failed')
  })

  // Bun's fetch errors: `code`/`errno`/`path` are enumerable and already
  // reached Axiom, the reason did not.
  test('a bun network error keeps its code and gains its message', () => {
    const err = Object.assign(
      new Error('Unable to connect. Is the computer able to access the url?'),
      { code: 'ECONNRESET', errno: 0, path: 'https://freebuff.com/api/ads' },
    )
    const wire = JSON.parse(JSON.stringify(toJsonSafeLogData({ err })))
    expect(wire.err.code).toBe('ECONNRESET')
    expect(wire.err.path).toBe('https://freebuff.com/api/ads')
    expect(wire.err.message).toContain('Unable to connect')
  })

  test('redacts on the client, before the payload leaves the machine', () => {
    const err = Object.assign(new Error('refused'), {
      url: 'https://freebuff.com/api/ads?auth_code=secret',
      headers: { authorization: 'Bearer abc' },
    })
    const wire = JSON.parse(JSON.stringify(toJsonSafeLogData({ err })))
    expect(wire.err.url).toBe('https://freebuff.com/api/ads')
    expect(wire.err.headers.authorization).toBe('[redacted]')
  })

  test('tolerates a circular payload and passes scalars through', () => {
    const data: Record<string, unknown> = { a: 1 }
    data.self = data
    expect(toJsonSafeLogData(data)).toEqual({ a: 1, self: '[Circular]' })
    expect(toJsonSafeLogData('plain')).toBe('plain')
    expect(toJsonSafeLogData(undefined)).toBeUndefined()
  })
})
