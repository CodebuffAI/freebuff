import { FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE } from '@codebuff/common/constants/freebuff-models'
import { getZonedDayBounds } from '@codebuff/common/util/zoned-time'

import type { FreebuffSessionRateLimit } from '@codebuff/common/types/freebuff-session'

/**
 * Takes the RESOLVED quota row rather than the whole `rateLimitsByModel` map.
 * It used to read `Object.values(...)[0]` itself, which meant the countdown
 * could come from a different pool than the "N of M used" printed beside it —
 * the caller had already picked a pool properly and this quietly picked
 * another.
 */
export function getFreebuffPremiumResetAt(params: {
  quota?: FreebuffSessionRateLimit
  nowMs: number
}): Date {
  const { quota, nowMs } = params
  const serverResetAt = quota?.resetAt
  const parsedServerResetAt = serverResetAt ? new Date(serverResetAt) : null

  if (
    parsedServerResetAt &&
    Number.isFinite(parsedServerResetAt.getTime())
  ) {
    return parsedServerResetAt
  }

  return getZonedDayBounds(
    new Date(nowMs),
    FREEBUFF_PREMIUM_SESSION_RESET_TIMEZONE,
  ).resetsAt
}

/**
 * Human "resets in …" countdown. Daily pools stop at hours (`withDays` off);
 * a multi-day window (e.g. a lapsed reset) sets `withDays` so it reads as "2d 5h"
 * instead of a 100-hour figure.
 */
export function formatFreebuffPremiumResetCountdown(
  resetAt: Date,
  nowMs: number,
  { withDays = false }: { withDays?: boolean } = {},
): string {
  const diffMs = resetAt.getTime() - nowMs
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'now'

  const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000))
  if (withDays) {
    const days = Math.floor(totalMinutes / (60 * 24))
    if (days > 0) {
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
      return hours === 0 ? `${days}d` : `${days}d ${hours}h`
    }
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
