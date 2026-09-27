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
