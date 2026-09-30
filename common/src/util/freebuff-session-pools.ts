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
  FreebuffSessionRateLimitByModel,
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

  // A subscription-backed row is a PRIVATE allowance: `subscription` is the
  // whole of that row's `limit`, replacing the shared pool rather than adding
  // to it. Letting one speak for the section header prices everyone else's
  // rows off a number only the subscribed model can spend, so such rows are
  // never header candidates — they carry their own chip instead. Falls back to
  // the full set when every row is subscription-backed, where there is no
  // shared pool left for a header to describe.
  const candidates = rows.filter(
    (quota) => quota.entitlementBreakdown?.subscription === undefined,
  )
  const headerRows = candidates.length > 0 ? candidates : rows

  const counts = new Map<string, number>()
  for (const quota of headerRows) {
    counts.set(poolOf(quota), (counts.get(poolOf(quota)) ?? 0) + 1)
  }

  // Most rows wins; ties break toward the earlier row, so the answer follows
  // display order rather than Map iteration order.
  let headerPool = poolOf(headerRows[0]!)
  for (const quota of headerRows) {
    if ((counts.get(poolOf(quota)) ?? 0) > (counts.get(headerPool) ?? 0)) {
      headerPool = poolOf(quota)
    }
  }

  const header = headerRows.find((quota) => poolOf(quota) === headerPool)
  const perModel: Record<string, FreebuffSessionRateLimit> = {}
  for (const quota of rows) {
    if (quota === header) continue
    // Second clause covers an older server that sends no `pool` at all: the
    // subscription row would otherwise group with the free rows and vanish,
    // taking the subscriber's actual allowance off the screen.
    if (
      poolOf(quota) !== headerPool ||
      quota.entitlementBreakdown?.subscription !== undefined
    ) {
      perModel[quota.model] = quota
    }
  }
  return { header, perModel }
}

/**
 * The row that speaks for a surface's pool when the caller has only the
 * payload and no display-ordered model list — the CLI landing counter and the
 * session-ended banner, which both used `Object.values(...)[0]` and so read
 * whichever pool the server happened to serialize first.
 *
 * `prefer` narrows to a section's models (premium, say) and is ignored when it
 * matches nothing, which is what keeps the limited tier — no premium rows at
 * all — showing its own pool rather than nothing.
 */
export function getFreebuffSharedPoolQuota(
  quotas: FreebuffSessionRateLimitByModel | undefined,
  prefer?: (modelId: string) => boolean,
): FreebuffSessionRateLimit | undefined {
  if (!quotas) return undefined
  const all = Object.keys(quotas)
  const preferred = prefer ? all.filter(prefer) : all
  return getFreebuffSectionQuotas(preferred.length > 0 ? preferred : all, quotas)
    .header
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
  const used = Math.min(quota.recentCount, quota.limit)
  const count = `${used} of ${quota.limit} ${quota.countsAdmissions ? 'starts' : 'used'}`
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
  // Pending settlement or a failed refresh does not revive legacy quotas.
  if (freebucks === null) return { canStart: true }
  if (freebucks) freebucks = applyFreebucksPriceChanges(freebucks)
  const price = model ? freebucks?.prices[model] : undefined
  if (price !== undefined && freebucks) {
    return {
      budget: { price, balance: freebucks.balance },
      canStart:
        freebucks.quotaExempt === true ||
        freebucks.balance + (freebucks.claimableGrantFreebucks ?? 0) >= price,
    }
  }
  return {
    quota,
    canStart: quota
      ? quota.recentCount < quota.limit
      : legacyRemaining === undefined || legacyRemaining > 0,
  }
}
