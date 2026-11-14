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
function wilsonRaw(successes: number, trials: number) {
  const z = Z_95
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
 */
export function newcombeDifference(
  successes1: number,
  trials1: number,
  successes2: number,
  trials2: number,
): DifferenceInterval | null {
  if (
    !validProportion(successes1, trials1) ||
    !validProportion(successes2, trials2)
  ) {
    return null
  }
  const a = wilsonRaw(successes1, trials1)
  const b = wilsonRaw(successes2, trials2)
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
