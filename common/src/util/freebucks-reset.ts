import type { FreebuffFreebucksWindow } from '../types/freebuff-session'

// This module is also shipped in the public CLI; keep it independent of the
// private pricing catalog. It describes server snapshots, never grants funds.
export const FREEBUCKS_RESET_POLICY_COPY =
  'Daily Freebucks refill at midnight in your reset timezone. When making the one-time switch from Pacific time, your first refill may arrive earlier. Later timezone changes keep your scheduled refill and may delay the following one. Follow the displayed reset time.'

export const FREEBUCKS_REFILL_PENDING_LABEL = 'Updating balance…'

export function freebucksRefillPending(
  resetAt: string,
  nowMs: number,
): boolean {
  return Date.parse(resetAt) <= nowMs
}

/** Transition and travel days need not end at midnight on the current device.
 * A passed deadline is not evidence that the displayed balance has refilled. */
export function freebucksResetCopy(
  daily: Pick<FreebuffFreebucksWindow, 'resetAt' | 'resetTimeZone'>,
  nowMs: number,
): string {
  if (freebucksRefillPending(daily.resetAt, nowMs)) {
    return 'The daily refill is due. This is the last confirmed balance; an updated balance will appear shortly.'
  }
  const reset = new Date(daily.resetAt)
  if (!Number.isFinite(reset.getTime()))
    return 'Check your daily reset countdown.'
  const at = reset.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `Next refill: ${at} (your device time).${daily.resetTimeZone ? ` Reset timezone: ${daily.resetTimeZone.replace(/_/g, ' ')}.` : ''}`
}
