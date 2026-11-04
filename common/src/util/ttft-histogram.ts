/**
 * Log-scale bucketing for time-to-first-token samples.
 *
 * The /latency dashboard reports p50/p95 TTFT over a 24h window, but percentiles
 * are not additive: you cannot combine hourly p50s into a window p50. Storing a
 * histogram per (hour, model) is what makes the rollup summable — counts add, so
 * percentiles over any set of hours (and over any set of models) come from the
 * merged distribution rather than from the raw `message` table.
 *
 * Buckets are geometric, so the error is a fixed *relative* one at every
 * latency: a bucket spans BASE**i .. BASE**(i+1), and we report its geometric
 * midpoint, so a reported value is within ±1.5% of the true sample. That matters
 * more than absolute precision here — the page renders 1.9s and 3.0s, and models
 * are ranked against each other, so a constant relative error preserves both the
 * displayed figure and the ordering.
 *
 * These constants are baked into stored rows: `message_latency_bucket.bucket` is
 * an index in this scheme. Changing BASE or BUCKET_COUNT silently reinterprets
 * every existing row, so a change means re-rolling the retained window.
 */

/** Ratio between consecutive bucket edges. 1.03 => ±1.5% reported error. */
export const TTFT_HISTOGRAM_BASE = 1.03

/**
 * Number of buckets. 1.03**512 is ~3.7e6 ms (~62 min), well past any TTFT a
 * request can produce, so the top bucket only ever catches pathological rows.
 */
export const TTFT_HISTOGRAM_BUCKET_COUNT = 512

const LN_BASE = Math.log(TTFT_HISTOGRAM_BASE)

/**
 * Bucket index for a TTFT sample in milliseconds.
 *
 * Mirrors the SQL in scripts/rollup-freebuff-latency.ts — keep the two in step.
 * Sub-millisecond and zero samples land in bucket 0 rather than at -Infinity.
 */
export function ttftBucketIndex(ttftMs: number): number {
  const safeTtftMs = Number.isFinite(ttftMs) ? ttftMs : 0
  const index = Math.floor(Math.log(Math.max(safeTtftMs, 1)) / LN_BASE)
  return Math.min(TTFT_HISTOGRAM_BUCKET_COUNT - 1, Math.max(0, index))
}

/**
 * Representative latency for a bucket: the geometric midpoint, which is the
 * value minimizing worst-case relative error across the bucket's span.
 */
export function ttftBucketMs(bucket: number): number {
  return Math.round(Math.exp((bucket + 0.5) * LN_BASE))
}

/**
 * Percentile over a histogram given as [bucketIndex, count] pairs.
 *
 * Nearest-rank: the first bucket whose cumulative count reaches `quantile` of
 * the total. Returns null for an empty histogram. Pairs need not be sorted.
 */
export function ttftPercentileFromHistogram(
  buckets: Iterable<readonly [number, number]>,
  quantile: number,
): number | null {
  const sorted = [...buckets].sort((a, b) => a[0] - b[0])
  const total = sorted.reduce((sum, [, count]) => sum + count, 0)
  if (total === 0) return null

  const target = total * quantile
  let cumulative = 0
  for (const [bucket, count] of sorted) {
    cumulative += count
    if (cumulative >= target) return ttftBucketMs(bucket)
  }
  return ttftBucketMs(sorted[sorted.length - 1][0])
}
