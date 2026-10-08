import { describe, expect, test } from 'bun:test'

import {
  chiSquareSurvival,
  newcombeDifference,
  sampleRatioMismatch,
  wilsonInterval,
} from '../stats'

describe('wilsonInterval', () => {
  test('matches the published 81/263 example', () => {
    // Newcombe (1998), Table I, method 3 (score): 0.2553 to 0.3662.
    const ci = wilsonInterval(81, 263)!
    expect(ci.value).toBeCloseTo(0.307985, 5)
    expect(ci.lower).toBeCloseTo(0.2553, 4)
    expect(ci.upper).toBeCloseTo(0.3662, 4)
  })

  test('edges', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    expect(wilsonInterval(3, 2)).toBeNull()
    expect(wilsonInterval(0, 10)!.lower).toBe(0)
    expect(wilsonInterval(10, 10)!.upper).toBe(1)
  })
})

describe('newcombeDifference', () => {
  test("matches Newcombe's 56/70 vs 48/80 example (method 10)", () => {
    const ci = newcombeDifference(56, 70, 48, 80)!
    expect(ci.difference).toBeCloseTo(0.2, 6)
    expect(ci.lower).toBeCloseTo(0.0524, 4)
    expect(ci.upper).toBeCloseTo(0.3339, 4)
  })

  test('is null without trials', () => {
    expect(newcombeDifference(1, 2, 0, 0)).toBeNull()
  })
})

describe('sampleRatioMismatch', () => {
  test('a perfect split has p = 1', () => {
    expect(sampleRatioMismatch([5000, 5000], [5000, 5000])).toEqual({
      chiSquare: 0,
      degreesOfFreedom: 1,
      pValue: 1,
    })
  })

  test('5100/4900 on 50/50 is chi-square 4, p ≈ 0.0455', () => {
    const srm = sampleRatioMismatch([5100, 4900], [5000, 5000])!
    expect(srm.chiSquare).toBe(4)
    expect(srm.pValue).toBeCloseTo(0.0455, 4)
  })

  test('weights are respected (20/80 holdout)', () => {
    const healthy = sampleRatioMismatch([2000, 8000], [2000, 8000])!
    expect(healthy.pValue).toBe(1)
    const broken = sampleRatioMismatch([2500, 7500], [2000, 8000])!
    expect(broken.pValue).toBeLessThan(0.001)
  })

  test('three arms use two degrees of freedom', () => {
    const srm = sampleRatioMismatch([100, 100, 130], [1, 1, 1])!
    expect(srm.degreesOfFreedom).toBe(2)
    // chi2 = (10² + 10² + 20²) / 110 = 5.4545…; Q(1, 2.727) = e^-2.727.
    expect(srm.pValue).toBeCloseTo(Math.exp(-600 / 220), 5)
  })

  test('null without data', () => {
    expect(sampleRatioMismatch([0, 0], [5000, 5000])).toBeNull()
  })
})

describe('chiSquareSurvival', () => {
  test('known critical values', () => {
    expect(chiSquareSurvival(3.841459, 1)).toBeCloseTo(0.05, 5)
    expect(chiSquareSurvival(10.827566, 1)).toBeCloseTo(0.001, 5)
    expect(chiSquareSurvival(5.991465, 2)).toBeCloseTo(0.05, 5)
    expect(chiSquareSurvival(0.5, 3)).toBeCloseTo(0.918891, 5)
  })
})
