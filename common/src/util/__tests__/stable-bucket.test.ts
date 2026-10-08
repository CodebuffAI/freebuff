import { describe, expect, test } from 'bun:test'

import {
  armForBucket,
  EXPERIMENT_BUCKETS,
  experimentBucket,
  validateArmWeights,
} from '../stable-bucket'

describe('experimentBucket', () => {
  test('is deterministic and in range', () => {
    const a = experimentBucket('save_offer_holdout_2026_10', 'user-1')
    expect(experimentBucket('save_offer_holdout_2026_10', 'user-1')).toBe(a)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(EXPERIMENT_BUCKETS)
  })

  test('the salt changes the bucket', () => {
    let differ = 0
    for (let i = 0; i < 100; i++) {
      if (experimentBucket('a', `u${i}`) !== experimentBucket('b', `u${i}`)) {
        differ++
      }
    }
    expect(differ).toBeGreaterThan(95)
  })

  test('is uniform within 1% over 100k shared-prefix ids', () => {
    const n = 100_000
    const deciles = new Array(10).fill(0)
    for (let i = 0; i < n; i++) {
      // Shared prefix + changing tail: the shape raw FNV-1a gets wrong.
      const bucket = experimentBucket('salt_2026_10', `user_00000000${i}`)
      deciles[Math.floor(bucket / 1000)]++
    }
    for (const count of deciles) {
      expect(Math.abs(count / n - 0.1)).toBeLessThan(0.01)
    }
    // A 20% holdout lands within 1 point of 20%.
    let control = 0
    for (let i = 0; i < n; i++) {
      if (experimentBucket('holdout', `id-${i}`) < 2000) control++
    }
    expect(Math.abs(control / n - 0.2)).toBeLessThan(0.01)
  })
})

describe('armForBucket', () => {
  const arms = [
    { name: 'control', bps: 2000 },
    { name: 'offer', bps: 8000 },
  ]

  test('walks arms in order by cumulative weight', () => {
    expect(armForBucket(arms, 0)).toBe('control')
    expect(armForBucket(arms, 1999)).toBe('control')
    expect(armForBucket(arms, 2000)).toBe('offer')
    expect(armForBucket(arms, 9999)).toBe('offer')
  })

  test('order is part of the definition', () => {
    const reversed = [arms[1], arms[0]]
    expect(armForBucket(reversed, 0)).toBe('offer')
    expect(armForBucket(reversed, 8000)).toBe('control')
  })

  test('a zero-weight arm is never chosen', () => {
    const withZero = [
      { name: 'control', bps: 5000 },
      { name: 'paused', bps: 0 },
      { name: 'offer', bps: 5000 },
    ]
    for (let b = 0; b < EXPERIMENT_BUCKETS; b += 37) {
      expect(armForBucket(withZero, b)).not.toBe('paused')
    }
    expect(armForBucket(withZero, 5000)).toBe('offer')
  })

  test('a short sum falls through to the last arm', () => {
    expect(
      armForBucket(
        [
          { name: 'control', bps: 10 },
          { name: 'offer', bps: 10 },
        ],
        9999,
      ),
    ).toBe('offer')
  })

  test('throws on no arms', () => {
    expect(() => armForBucket([], 0)).toThrow()
  })
})

describe('validateArmWeights', () => {
  test('accepts a valid definition', () => {
    expect(
      validateArmWeights([
        { name: 'control', bps: 2000 },
        { name: 'offer_50', bps: 8000 },
      ]),
    ).toBeNull()
  })

  test('rejects bad sums, missing control, duplicates and bad names', () => {
    expect(
      validateArmWeights([
        { name: 'control', bps: 2000 },
        { name: 'offer', bps: 7999 },
      ]),
    ).toContain('sum')
    expect(
      validateArmWeights([
        { name: 'a', bps: 5000 },
        { name: 'b', bps: 5000 },
      ]),
    ).toContain('control')
    expect(
      validateArmWeights([
        { name: 'control', bps: 5000 },
        { name: 'control', bps: 5000 },
      ]),
    ).toContain('duplicate')
    expect(
      validateArmWeights([
        { name: 'control', bps: 5000 },
        { name: 'Offer!', bps: 5000 },
      ]),
    ).toContain('snake_case')
    expect(validateArmWeights([{ name: 'control', bps: 10000 }])).toContain(
      'two arms',
    )
  })
})
