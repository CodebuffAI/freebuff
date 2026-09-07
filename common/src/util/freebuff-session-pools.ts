import { applyFreebucksPriceChanges } from './freebuff-price-changes'
/**
 * Splitting a picker section's quota rows into "the pool this section is about"
 * and "the rows that answer to something stricter".
 *
 * Every client had the same shortcut: one section, one pool, so read any entry
 * and label the whole section from it. The CLI took `Object.values(...)[0]`,
 * Freebuff Web took the first Premium row with a quota. That held until
 * 2026-08-19, when DeepSeek got a one-a-day ceiling ON TOP of the premium pool
 * and two pools started appearing inside one section. The shortcut then reports
 * "1 of 5 used" beside a row that is already spent and greyed out, with nothing
 * saying why.
 *
 * The rule here is deliberately arithmetic rather than semantic: the section
 * header takes the pool that MOST of its rows belong to, and every other row
 * carries its own. No client needs to know that DeepSeek is the odd one, which
 * is the point — the next model to get its own ceiling is a server edit, and
 * installed clients render it on their next poll.
 *
 * Shared so the three pickers cannot drift into three different answers about
 * the same payload.
 */

import type {
  FreebuffFreebucksInfo,
  FreebuffSessionRateLimit,
} from '../types/freebuff-session'

export interface FreebuffSectionQuotas {
  /** The quota the section HEADER should show, or undefined when the section
   *  has no metered rows at all. */
  header: FreebuffSessionRateLimit | undefined
  /** Rows that answer to a different pool than the header, keyed by model id.
   *  A client renders these inline on the row itself. Empty in the ordinary
   *  one-pool case, which is what keeps this invisible until it is needed. */
  perModel: Record<string, FreebuffSessionRateLimit>
}

/**
 * Group `models`' quotas by pool and decide what the header speaks for.
 *
 * `quotas` is the server's `rateLimitsByModel`; `models` is the section's rows
 * in display order. Rows with no quota (unmetered models) are ignored — they
 * belong to no pool and need no label.
 */
export function getFreebuffSectionQuotas(
  models: readonly string[],
  quotas: Record<string, FreebuffSessionRateLimit> | undefined,
): FreebuffSectionQuotas {
  if (!quotas) return { header: undefined, perModel: {} }

  const rows = models
    .map((model) => quotas[model])
    .filter((quota): quota is FreebuffSessionRateLimit => Boolean(quota))
  if (rows.length === 0) return { header: undefined, perModel: {} }

  // Older servers send no `pool` at all. Falling back to one bucket reproduces
  // the previous behaviour exactly — header from the first row, nothing inline
  // — so a new client against an old server is no worse than before.
  const poolOf = (quota: FreebuffSessionRateLimit) => quota.pool ?? ''

  const counts = new Map<string, number>()
  for (const quota of rows) {
    counts.set(poolOf(quota), (counts.get(poolOf(quota)) ?? 0) + 1)
  }

  // Most rows wins; ties break toward the earlier row, so the answer follows
  // display order rather than Map iteration order.
  let headerPool = poolOf(rows[0]!)
  for (const quota of rows) {
    if ((counts.get(poolOf(quota)) ?? 0) > (counts.get(headerPool) ?? 0)) {
      headerPool = poolOf(quota)
    }
  }

  const header = rows.find((quota) => poolOf(quota) === headerPool)
  const perModel: Record<string, FreebuffSessionRateLimit> = {}
  for (const quota of rows) {
    if (poolOf(quota) !== headerPool) perModel[quota.model] = quota
  }
  return { header, perModel }
}

/**
 * "1 of 1 used" — the inline chip for a row on its own pool.
 *
 * Names the pool when the server supplied a label, because the number alone
 * does not explain why this row is spent while the section header says there is
 * room. Falls back to the bare count for older servers.
 */
export function formatFreebuffRowQuota(
  quota: FreebuffSessionRateLimit,
): string {
  const safeRecentCount = Number.isFinite(quota.recentCount) ? quota.recentCount : 0
  const safeLimit = Number.isFinite(quota.limit) ? quota.limit : 0
  const used = Math.min(safeRecentCount, safeLimit)
  const count = `${used} of ${safeLimit} ${quota.countsAdmissions ? 'starts' : 'used'}`
  return quota.poolLabel ? `${quota.poolLabel}: ${count}` : count
}

/** A projection of the server snapshot, not admission authority. Only the
 * applicable meter is returned, so labels and disabled state cannot disagree.
 * Legacy adapters may supply a remaining balance for snapshots without quotas. */
export function getFreebuffModelMeter({
  model,
  freebucks,
  quota,
  legacyRemaining,
}: {
  model: string | undefined
  freebucks?: FreebuffFreebucksInfo | null
  quota?: FreebuffSessionRateLimit
  legacyRemaining?: number
}) {
  if (freebucks) freebucks = applyFreebucksPriceChanges(freebucks)
  const price = model ? freebucks?.prices[model] : undefined
  if (price !== undefined && freebucks) {
    return {
      budget: { price, balance: freebucks.balance },
      canStart: freebucks.quotaExempt === true || freebucks.balance >= price,
    }
  }
  return {
    quota,
    canStart: quota
      ? quota.recentCount < quota.limit
      : legacyRemaining === undefined || legacyRemaining > 0,
  }
}
