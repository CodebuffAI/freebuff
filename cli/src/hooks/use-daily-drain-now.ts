import { useEffect, useState } from 'react'

import { freebucksDrainEndsAt } from '@codebuff/common/util/freebucks-open-hours'

import type { FreebuffFreebucksWindow } from '@codebuff/common/types/freebuff-session'

/** How often a running hour's figure re-renders: a 3-hour model moves the
 *  pool 3 minutes a minute, so this keeps the countdown within a minute.
 *  Desktop's `useDailyShown` ticks at the same rate. */
export const DAILY_DRAIN_TICK_MS = 5_000

/**
 * The clock the daily figure is drawn at (`freebucksDailyShown`): now, or the
 * pinned `nowMs`. While a paid hour on `daily` runs, the caller re-renders
 * every few seconds and once more as the last hour ends, when the figure reads
 * the real balance. Read at render rather than kept in state, so a session that
 * starts after a long idle spell is never drawn at a stale time.
 */
export function useDailyDrainNow(
  daily: Pick<FreebuffFreebucksWindow, 'resetAt' | 'openHours'> | undefined,
  nowMs?: number,
): number {
  const [, rerender] = useState(0)
  const now = nowMs ?? Date.now()
  const endsAt =
    daily && nowMs === undefined ? freebucksDrainEndsAt(daily, now) : undefined
  useEffect(() => {
    if (endsAt === undefined) return
    const tick = () => rerender((n) => n + 1)
    const timer = setInterval(tick, DAILY_DRAIN_TICK_MS)
    const end = setTimeout(
      () => {
        clearInterval(timer)
        tick()
      },
      Math.max(0, endsAt - Date.now()) + 50,
    )
    return () => {
      clearInterval(timer)
      clearTimeout(end)
    }
  }, [endsAt])
  return now
}
