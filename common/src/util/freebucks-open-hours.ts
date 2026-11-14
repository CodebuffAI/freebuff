import type { FreebuffFreebucksWindow } from '../types/freebuff-session'

type DailyPool = Pick<
  FreebuffFreebucksWindow,
  'limit' | 'spent' | 'remaining' | 'resetAt' | 'openHours'
>

/** The part of a running hour's pool share not yet shown as spent: its share
 *  times the fraction of the hour still to run. Zero once it has ended. */
function unshownShare(
  hour: NonNullable<DailyPool['openHours']>[number],
  nowMs: number,
): number {
  const startsAt = Date.parse(hour.startsAt)
  const endsAt = Date.parse(hour.endsAt)
  if (
    !Number.isFinite(startsAt) ||
    !Number.isFinite(endsAt) ||
    endsAt <= startsAt ||
    !(hour.amount > 0)
  )
    return 0
  const left = Math.min(1, Math.max(0, (endsAt - nowMs) / (endsAt - startsAt)))
  return hour.amount * left
}

/**
 * The daily pool as the usage figures show it (product, 2026-11-11; display
 * only). A session's price comes off the pool at its first message, and a
 * meter that showed that drop read as "asked it Hello and 60% daily usage
 * gone". So the display spends each running hour's share over its hour: an
 * hour of a 3-hour model takes 3 minutes of the pool per minute, and at the
 * hour's end the figure is the real balance. Several running hours each count
 * at their own rate.
 *
 * The part not yet shown as spent is reserved, never spendable: admission and
 * every affordability check (a picker lock, the wallet question, the
 * shortfall) read `spent`, `remaining` and `balance` as sent, never this. An
 * older server sends no `openHours`, and the figures are returned unchanged.
 * Once the snapshot's `resetAt` has passed the hours belonged to the day that
 * ended, so nothing is spread until a fresh snapshot arrives.
 */
export function freebucksDailyShown(
  daily: DailyPool,
  nowMs: number,
): { limit: number; spent: number; remaining: number; draining: boolean } {
  const resetAt = Date.parse(daily.resetAt)
  const unshown =
    daily.openHours && !(resetAt <= nowMs)
      ? daily.openHours.reduce(
          (total, hour) => total + unshownShare(hour, nowMs),
          0,
        )
      : 0
  // Never more than was spent: the reserve can only give back today's spend.
  const reserved = Math.min(unshown, Math.max(0, daily.spent))
  if (!(reserved > 0))
    return {
      limit: daily.limit,
      spent: daily.spent,
      remaining: daily.remaining,
      draining: false,
    }
  const spent = daily.spent - reserved
  return {
    limit: daily.limit,
    spent,
    remaining: Math.max(0, daily.limit - spent),
    draining: true,
  }
}

/**
 * When the shown figure stops moving: the last running hour's end, or the
 * snapshot's reset if that comes first. Undefined when nothing is running,
 * so a caller re-renders on a timer only while this is set.
 */
export function freebucksDrainEndsAt(
  daily: Pick<DailyPool, 'resetAt' | 'openHours'>,
  nowMs: number,
): number | undefined {
  const resetAt = Date.parse(daily.resetAt)
  let endsAt: number | undefined
  for (const hour of daily.openHours ?? []) {
    if (unshownShare(hour, nowMs) <= 0) continue
    const end = Date.parse(hour.endsAt)
    endsAt = endsAt === undefined ? end : Math.max(endsAt, end)
  }
  if (endsAt === undefined || resetAt <= nowMs) return undefined
  return Number.isFinite(resetAt) ? Math.min(endsAt, resetAt) : endsAt
}
