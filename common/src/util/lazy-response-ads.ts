export type LazyResponseAdQueue<T extends { impUrl: string }> = {
  targetCounts: Map<string, number>
  attemptedCounts: Map<string, number>
  inFlight: Map<string, Promise<void>>
  usedImpUrls: Set<string>
}

/** Maximum number of unique ads auctioned for one assistant response. */
export const MAX_RESPONSE_AD_POOL_SIZE = 4

/**
 * Before the pool is full, only render ads that have actually loaded. Once all
 * four are available, fill every eligible slot by cycling that stable pool.
 */
export function responseAdDisplayCount(params: {
  eligibleCount: number
  poolSize: number
}): number {
  const eligibleCount = Math.max(0, Math.floor(params.eligibleCount))
  const poolSize = Math.max(0, Math.floor(params.poolSize))
  return poolSize >= MAX_RESPONSE_AD_POOL_SIZE
    ? eligibleCount
    : Math.min(eligibleCount, poolSize)
}

/** Return the exact pooled ad for a slot, repeating the pool in order. */
export function getResponseAdForSlot<T>(
  ads: readonly T[],
  slotIndex: number,
): T | undefined {
  if (ads.length === 0) return undefined
  return ads[Math.max(0, Math.floor(slotIndex)) % ads.length]
}

export function createLazyResponseAdQueue<
  T extends { impUrl: string },
>(): LazyResponseAdQueue<T> {
  return {
    targetCounts: new Map(),
    attemptedCounts: new Map(),
    inFlight: new Map(),
    usedImpUrls: new Set(),
  }
}

/**
 * Raise one response's target ad count and fetch exactly once for each newly
 * eligible slot, up to {@link MAX_RESPONSE_AD_POOL_SIZE}. Calls are serialized
 * per response so resolved ads retain their placement order. No-fill and
 * duplicate results still consume an attempt, preventing render-driven retry
 * loops.
 */
export function requestLazyResponseAds<T extends { impUrl: string }>(params: {
  queue: LazyResponseAdQueue<T>
  messageId: string
  count: number
  fetchOne: () => Promise<T | null>
  onAd: (ad: T) => void
}): Promise<void> | null {
  const { queue, messageId, fetchOne, onAd } = params
  const safeCount = Number.isFinite(params.count) ? params.count : 0
  const count = Math.min(
    MAX_RESPONSE_AD_POOL_SIZE,
    Math.max(0, Math.floor(safeCount)),
  )
  const previousTarget = queue.targetCounts.get(messageId) ?? 0
  if (count <= previousTarget) return queue.inFlight.get(messageId) ?? null

  queue.targetCounts.set(messageId, count)
  const existing = queue.inFlight.get(messageId)
  if (existing) return existing

  const task = (async () => {
    try {
      for (;;) {
        const target = queue.targetCounts.get(messageId) ?? 0
        const attempted = queue.attemptedCounts.get(messageId) ?? 0
        if (attempted >= target) break
        queue.attemptedCounts.set(messageId, attempted + 1)

        const ad = await fetchOne()
        if (!ad || queue.usedImpUrls.has(ad.impUrl)) continue

        queue.usedImpUrls.add(ad.impUrl)
        onAd(ad)
      }
    } finally {
      queue.inFlight.delete(messageId)
    }
  })()

  queue.inFlight.set(messageId, task)
  return task
}
