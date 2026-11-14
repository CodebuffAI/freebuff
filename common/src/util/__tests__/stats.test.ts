import { describe, expect, test } from 'bun:test'

import {
  chiSquareSurvival,
  newcombeDifference,
  revenuePerThousand,
  revenueUplift,
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

describe('revenuePerThousand', () => {
  test('mean and standard error from the sums', () => {
    // r = [0, 0, 10, 30]: mean 10, sample variance 200, se sqrt(200 / 4).
    const out = revenuePerThousand({ n: 4, sum: 40, sumSquares: 1_000 })!
    const se = 1_000 * Math.sqrt(50)
    expect(out.value).toBe(10_000)
    expect(out.standardError).toBeCloseTo(se, 4)
    expect(out.lower).toBeCloseTo(10_000 - 1.959964 * se, 3)
    expect(out.upper).toBeCloseTo(10_000 + 1.959964 * se, 3)
  })

  test('constant revenue has zero width, never a negative variance', () => {
    const out = revenuePerThousand({ n: 3, sum: 0.3, sumSquares: 0.03 })!
    expect(out.value).toBeCloseTo(100, 6)
    expect(out.standardError).toBe(0)
  })

  test('null on too few or invalid sums', () => {
    expect(revenuePerThousand({ n: 1, sum: 5, sumSquares: 25 })).toBeNull()
    expect(revenuePerThousand({ n: 10, sum: -1, sumSquares: 1 })).toBeNull()
    expect(
      revenuePerThousand({ n: Number.NaN, sum: 1, sumSquares: 1 }),
    ).toBeNull()
  })

  test('matches the direct per-opportunity computation', () => {
    const values = [0, 0, 0, 0, 12, 0, 0, 3.5, 0, 0, 0, 40, 0, 0, 0.2]
    const n = values.length
    const sum = values.reduce((a, b) => a + b, 0)
    const mean = sum / n
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
    const out = revenuePerThousand({
      n,
      sum,
      sumSquares: values.reduce((a, b) => a + b * b, 0),
    })!
    expect(out.value).toBeCloseTo(1_000 * mean, 4)
    expect(out.standardError).toBeCloseTo(1_000 * Math.sqrt(variance / n), 4)
  })
})

describe('revenueUplift', () => {
  // uniform r = [0, 0, 10, 30], ranked r = [10, 10, 20, 40]: means 10 and 20,
  // both with sample variance 200.
  const uniform = { n: 4, sum: 40, sumSquares: 1_000 }
  const ranked = { n: 4, sum: 80, sumSquares: 2_200 }
  const se = 1_000 * Math.sqrt(50)

  test('difference with an independent-arm standard error', () => {
    const out = revenueUplift(ranked, uniform)!
    expect(out.ranked.value).toBe(20_000)
    expect(out.uniform.value).toBe(10_000)
    expect(out.difference.value).toBe(10_000)
    const diffSe = Math.sqrt(2) * se
    expect(out.difference.lower).toBeCloseTo(10_000 - 1.959964 * diffSe, 3)
    expect(out.difference.upper).toBeCloseTo(10_000 + 1.959964 * diffSe, 3)
  })

  test('ratio with a delta-method interval on the log scale', () => {
    const out = revenueUplift(ranked, uniform)!
    const logSe = Math.sqrt((se / 20_000) ** 2 + (se / 10_000) ** 2)
    expect(out.ratio!.value).toBe(2)
    expect(out.ratio!.lower).toBeCloseTo(2 * Math.exp(-1.959964 * logSe), 5)
    expect(out.ratio!.upper).toBeCloseTo(2 * Math.exp(1.959964 * logSe), 5)
    expect(out.ratio!.lower).toBeGreaterThan(0)
  })

  test('no ratio when the uniform arm earned nothing', () => {
    const out = revenueUplift(ranked, { n: 100, sum: 0, sumSquares: 0 })!
    expect(out.ratio).toBeNull()
    expect(out.difference.value).toBe(20_000)
  })

  test('null when an arm is empty', () => {
    expect(revenueUplift(ranked, { n: 0, sum: 0, sumSquares: 0 })).toBeNull()
  })
})
