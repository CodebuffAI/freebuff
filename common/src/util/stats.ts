/**
 * Small, dependency-free statistics for experiment readouts and eval gates.
 *
 * `wilsonInterval` moved here from `freebuff/web/src/server/ad-serving/intent/
 * stats.ts` (which re-exports it) so Postgres-side readouts
 * (`packages/internal/src/experiments/readout.ts`) can share it.
 */

const Z_95 = 1.959964

export type WilsonInterval = {
  readonly value: number
  readonly lower: number
  readonly upper: number
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function validProportion(successes: number, trials: number): boolean {
  return (
    Number.isFinite(successes) &&
    Number.isFinite(trials) &&
    trials > 0 &&
    successes >= 0 &&
    successes <= trials
  )
}

/** Unrounded Wilson bounds; callers have already validated the inputs. */
function wilsonRaw(successes: number, trials: number, z = Z_95) {
  const p = successes / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const centre = (p + z2 / (2 * trials)) / denominator
  const half =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denominator
  return {
    p,
    lower: Math.max(0, centre - half),
    upper: Math.min(1, centre + half),
  }
}

/** Wilson score interval at 95%. `null` when there are no trials. */
export function wilsonInterval(
  successes: number,
  trials: number,
): WilsonInterval | null {
  if (!validProportion(successes, trials)) return null
  const { p, lower, upper } = wilsonRaw(successes, trials)
  return { value: round6(p), lower: round6(lower), upper: round6(upper) }
}

export type DifferenceInterval = {
  /** p1 - p2 */
  readonly difference: number
  readonly lower: number
  readonly upper: number
}

/**
 * 95% interval for the difference of two independent proportions, p1 - p2,
 * by Newcombe's hybrid score method (method 10, Newcombe 1998), built from
 * the two Wilson intervals. Well-behaved at small counts and near 0 or 1,
 * where the Wald interval is not. `null` when either arm has no trials.
 * Pass `z` for another level (2.241403 for 97.5%, a Bonferroni-corrected
 * comparison of two treatment arms).
 */
export function newcombeDifference(
  successes1: number,
  trials1: number,
  successes2: number,
  trials2: number,
  z = Z_95,
): DifferenceInterval | null {
  if (
    !validProportion(successes1, trials1) ||
    !validProportion(successes2, trials2)
  ) {
    return null
  }
  const a = wilsonRaw(successes1, trials1, z)
  const b = wilsonRaw(successes2, trials2, z)
  const d = a.p - b.p
  const lower = d - Math.sqrt((a.p - a.lower) ** 2 + (b.upper - b.p) ** 2)
  const upper = d + Math.sqrt((a.upper - a.p) ** 2 + (b.p - b.lower) ** 2)
  return {
    difference: round6(d),
    lower: round6(Math.max(-1, lower)),
    upper: round6(Math.min(1, upper)),
  }
}

export type SampleRatioCheck = {
  readonly chiSquare: number
  readonly degreesOfFreedom: number
  /** Probability of a split at least this uneven if assignment is healthy. */
  readonly pValue: number
}

/**
 * Sample-ratio-mismatch check: Pearson chi-square goodness of fit of the
 * observed per-arm counts against the configured weights. A tiny p-value
 * (conventionally < 0.001) means assignment or logging is broken and the
 * experiment's comparison cannot be trusted. `null` with fewer than two
 * weighted arms or no observations.
 */
export function sampleRatioMismatch(
  observed: readonly number[],
  weights: readonly number[],
): SampleRatioCheck | null {
  if (observed.length !== weights.length) {
    throw new Error('observed and weights must have the same length')
  }
  const total = observed.reduce((sum, n) => sum + n, 0)
  const weightTotal = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0 || weightTotal <= 0) return null
  let chiSquare = 0
  let cells = 0
  for (let i = 0; i < observed.length; i++) {
    if (weights[i] <= 0) continue
    const expected = (total * weights[i]) / weightTotal
    chiSquare += (observed[i] - expected) ** 2 / expected
    cells++
  }
  if (cells < 2) return null
  const degreesOfFreedom = cells - 1
  return {
    chiSquare: round6(chiSquare),
    degreesOfFreedom,
    pValue: round6(chiSquareSurvival(chiSquare, degreesOfFreedom)),
  }
}

/**
 * The standard normal quantile (probit): the z with P(Z <= z) = p, for
 * 0 < p < 1. Acklam's rational approximation, relative error under 1.2e-9
 * across the whole range, which is far below what a sample size needs.
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new Error(`inverseNormalCdf needs 0 < p < 1, got ${p}`)
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ]
  const low = 0.02425
  // The tails: one rational function in sqrt(-2 log p), mirrored.
  const tail = (q: number) => {
    const t = Math.sqrt(-2 * Math.log(q))
    return (
      (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) /
      ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1)
    )
  }
  if (p < low) return tail(p)
  if (p > 1 - low) return -tail(1 - p)
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  )
}

export type SampleSizeInput = {
  /** The control arm's expected rate, 0 < baseline < 1. */
  readonly baseline: number
  /**
   * The smallest absolute change worth detecting, as a proportion (0.01 is one
   * percentage point). Either sign; baseline + effect must stay inside (0, 1).
   */
  readonly effect: number
  /** Treatment arms beside control; the significance level is split across them. */
  readonly treatmentArms?: number
  /** Two-sided significance level before the split. Default 0.05. */
  readonly alpha?: number
  /** Probability of detecting `effect` when it is real. Default 0.8. */
  readonly power?: number
}

/**
 * Users each arm needs for a two-sided two-proportion z-test (normal
 * approximation, equal arms), rounded up:
 *
 *   n = (z_{1-α/2} √(2 p̄(1-p̄)) + z_{1-β} √(p1(1-p1) + p2(1-p2)))² / δ²
 *
 * with p1 = baseline, p2 = baseline + δ and p̄ their mean. With k treatment
 * arms α becomes α / k (Bonferroni), as the readout's verdict rules divide it.
 * At a 28% baseline and a one-point effect this is about 32,000 per arm.
 */
export function sampleSizePerArm(input: SampleSizeInput): number {
  const { baseline: p1, effect: delta } = input
  const treatmentArms = input.treatmentArms ?? 1
  const alpha = input.alpha ?? 0.05
  const power = input.power ?? 0.8
  const p2 = p1 + delta
  if (!(p1 > 0 && p1 < 1)) {
    throw new Error(`baseline must be between 0 and 1, got ${p1}`)
  }
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error(`effect must be a non-zero number, got ${delta}`)
  }
  if (!(p2 > 0 && p2 < 1)) {
    throw new Error(
      `baseline + effect must be between 0 and 1, got ${round6(p2)}`,
    )
  }
  if (!Number.isInteger(treatmentArms) || treatmentArms < 1) {
    throw new Error(
      `treatmentArms must be a positive integer, got ${treatmentArms}`,
    )
  }
  if (!(alpha > 0 && alpha < 1) || !(power > 0 && power < 1)) {
    throw new Error('alpha and power must be between 0 and 1')
  }
  const zAlpha = inverseNormalCdf(1 - alpha / treatmentArms / 2)
  const zBeta = inverseNormalCdf(power)
  const mean = (p1 + p2) / 2
  const root =
    zAlpha * Math.sqrt(2 * mean * (1 - mean)) +
    zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
  return Math.ceil((root * root) / (delta * delta))
}

/**
 * One arm's per-opportunity revenue, as sums: `n` opportunities (no-fills
 * included, at revenue 0), `sum` = sum of revenue r_i and `sumSquares` =
 * sum of r_i^2, all in one unit (cents). Sums add across days and
 * placements, so rollup rows combine by addition before this is called.
 */
export type RevenueSums = {
  readonly n: number
  readonly sum: number
  readonly sumSquares: number
}

export type RevenuePerThousand = {
  /** 1,000 x mean revenue per opportunity. */
  readonly value: number
  /** Standard error of `value`. */
  readonly standardError: number
  readonly lower: number
  readonly upper: number
}

export type RevenueUplift = {
  readonly uniform: RevenuePerThousand
  readonly ranked: RevenuePerThousand
  /** ranked - uniform per 1,000 opportunities, 95% normal interval. */
  readonly difference: {
    readonly value: number
    readonly lower: number
    readonly upper: number
  }
  /**
   * ranked / uniform with a 95% interval from the delta method on the log
   * ratio; null when either arm's mean is 0.
   */
  readonly ratio: {
    readonly value: number
    readonly lower: number
    readonly upper: number
  } | null
}

function validSums(s: RevenueSums): boolean {
  return (
    Number.isFinite(s.n) &&
    Number.isFinite(s.sum) &&
    Number.isFinite(s.sumSquares) &&
    s.n >= 2 &&
    s.sum >= 0 &&
    s.sumSquares >= 0
  )
}

/** Unrounded mean and standard error, per 1,000 opportunities. */
function perThousandRaw(sums: RevenueSums): { value: number; se: number } {
  const mean = sums.sum / sums.n
  const variance = Math.max(
    0,
    (sums.sumSquares - (sums.sum * sums.sum) / sums.n) / (sums.n - 1),
  )
  return { value: 1_000 * mean, se: 1_000 * Math.sqrt(variance / sums.n) }
}

/**
 * Mean revenue per 1,000 opportunities with a 95% normal (CLT) interval.
 * The sample variance comes from the sums, (Q - S^2/n) / (n - 1), clamped at
 * 0 against rounding. Treats opportunities as independent, which ignores
 * clustering by user: read the interval as a lower bound on the true width.
 * `null` below two opportunities or on invalid sums.
 */
export function revenuePerThousand(
  sums: RevenueSums,
): RevenuePerThousand | null {
  if (!validSums(sums)) return null
  const { value, se } = perThousandRaw(sums)
  return {
    value: round6(value),
    standardError: round6(se),
    lower: round6(value - Z_95 * se),
    upper: round6(value + Z_95 * se),
  }
}

/**
 * The ranked arm's revenue uplift over the uniform (random) arm, per 1,000
 * opportunities: the difference with a 95% interval (independent arms,
 * se = sqrt(se_r^2 + se_u^2)), and the ratio with a 95% interval from the
 * delta method, var(log(m_r / m_u)) ~ (se_r / m_r)^2 + (se_u / m_u)^2,
 * exponentiated back (so it is asymmetric and never below 0). `null` when
 * either arm has under two opportunities.
 */
export function revenueUplift(
  ranked: RevenueSums,
  uniform: RevenueSums,
): RevenueUplift | null {
  const r = revenuePerThousand(ranked)
  const u = revenuePerThousand(uniform)
  if (!r || !u) return null
  const rr = perThousandRaw(ranked)
  const ur = perThousandRaw(uniform)
  const diff = rr.value - ur.value
  const diffSe = Math.sqrt(rr.se ** 2 + ur.se ** 2)
  let ratio: RevenueUplift['ratio'] = null
  if (rr.value > 0 && ur.value > 0) {
    const logSe = Math.sqrt((rr.se / rr.value) ** 2 + (ur.se / ur.value) ** 2)
    const logRatio = Math.log(rr.value / ur.value)
    ratio = {
      value: round6(rr.value / ur.value),
      lower: round6(Math.exp(logRatio - Z_95 * logSe)),
      upper: round6(Math.exp(logRatio + Z_95 * logSe)),
    }
  }
  return {
    uniform: u,
    ranked: r,
    difference: {
      value: round6(diff),
      lower: round6(diff - Z_95 * diffSe),
      upper: round6(diff + Z_95 * diffSe),
    },
    ratio,
  }
}

/** P(X >= x) for X ~ chi-square(k). */
export function chiSquareSurvival(x: number, k: number): number {
  if (x <= 0) return 1
  return regularizedGammaQ(k / 2, x / 2)
}

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Q(a, x) = Γ(a, x) / Γ(a), series below a + 1, continued fraction above. */
function regularizedGammaQ(a: number, x: number): number {
  const gln = logGamma(a)
  if (x < a + 1) {
    let sum = 1 / a
    let term = sum
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break
    }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - gln))
  }
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - gln) * h)
}
