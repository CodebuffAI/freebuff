import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { uuidv7 } from '../uuidv7'

const RFC_9562_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const zeros = (bytes: Uint8Array) => bytes.fill(0)
const ones = (bytes: Uint8Array) => bytes.fill(0xff)

describe('uuidv7', () => {
  it('is a well-formed version-7, variant-10 UUID', () => {
    for (let i = 0; i < 1000; i++) {
      expect(uuidv7()).toMatch(RFC_9562_V7)
    }
  })

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const ms = Date.UTC(2026, 9, 1, 22, 0, 0, 123)
    const id = uuidv7(ms, zeros)
    const encoded = parseInt(id.replace(/-/g, '').slice(0, 12), 16)
    expect(encoded).toBe(ms)
  })

  it('keeps version and variant bits whatever the random source returns', () => {
    expect(uuidv7(0, zeros)).toBe('00000000-0000-7000-8000-000000000000')
    expect(uuidv7(0, ones)).toBe('00000000-0000-7fff-bfff-ffffffffffff')
  })

  it('sorts by creation time as a plain string', () => {
    const earlier = uuidv7(1_759_356_000_000, ones)
    const later = uuidv7(1_759_356_000_001, zeros)
    expect(earlier < later).toBe(true)
  })

  it('is unique across many ids in the same millisecond', () => {
    const now = Date.now()
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(now)))
    expect(ids.size).toBe(10_000)
  })

  it('passes the zod uuid validators the run and step schemas use', () => {
    const id = uuidv7()
    expect(z.string().uuid().safeParse(id).success).toBe(true)
    expect(z.uuid().safeParse(id).success).toBe(true)
  })
})
