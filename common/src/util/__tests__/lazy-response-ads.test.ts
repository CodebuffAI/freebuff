import { describe, expect, it } from 'bun:test'

import { responseAdDisplayCount } from '../lazy-response-ads'

describe('responseAdDisplayCount', () => {
  it('returns eligibleCount when poolSize is at or above the max', () => {
    expect(
      responseAdDisplayCount({ eligibleCount: 5, poolSize: 100 }),
    ).toBe(5)
  })

  it('clamps to poolSize when poolSize is below the max', () => {
    expect(responseAdDisplayCount({ eligibleCount: 10, poolSize: 3 })).toBe(3)
  })

  it('returns 0 when eligibleCount is NaN', () => {
    expect(responseAdDisplayCount({ eligibleCount: NaN, poolSize: 10 })).toBe(0)
  })

  it('returns 0 when poolSize is NaN', () => {
    expect(responseAdDisplayCount({ eligibleCount: 5, poolSize: NaN })).toBe(0)
  })

  it('returns 0 when eligibleCount is Infinity', () => {
    expect(
      responseAdDisplayCount({ eligibleCount: Infinity, poolSize: 10 }),
    ).toBe(0)
  })

  it('returns 0 when poolSize is Infinity', () => {
    expect(
      responseAdDisplayCount({ eligibleCount: 5, poolSize: Infinity }),
    ).toBe(0)
  })

  it('returns 0 when both inputs are negative', () => {
    expect(
      responseAdDisplayCount({ eligibleCount: -5, poolSize: -10 }),
    ).toBe(0)
  })

  it('floors fractional inputs', () => {
    expect(
      responseAdDisplayCount({ eligibleCount: 5.7, poolSize: 3.2 }),
    ).toBe(3)
  })
})
