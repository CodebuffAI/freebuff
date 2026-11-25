/**
 * Pausing a paid hour (2026-11-24, product): a running session can stop its
 * clock and keep the time it has left for later, less a fixed cost. The cost
 * is the prompt cache: a paused chat's cached context is gone when it comes
 * back, so its first turns are billed at the full input price.
 *
 * Only an hour a hosted chat (Web, Desktop's workspace window) or a current
 * CLI holds can pause: those are the purchases in `freebuff_desktop_purchase`.
 * The server decides (`pauseDesktopPurchase`); clients use these figures to
 * say beforehand what a pause would keep.
 */

/** `POST` with the chat's instance id: pause the hour that claim holds. */
export const FREEBUFF_SESSION_PAUSE_PATH = '/api/v1/freebuff/session/pause'

/** What pausing takes off the time left. */
export const FREEBUFF_SESSION_PAUSE_COST_MS = 15 * 60_000

/** The least a pause may keep: below this there is nothing worth saving. */
export const FREEBUFF_SESSION_PAUSE_MIN_KEEP_MS = 60_000

/** How long a paused hour waits to be resumed. After that it ends as an
 *  unresumed hour does, through the ordinary hour-end refund. */
export const FREEBUFF_PAUSED_HOUR_HOLD_MS = 24 * 60 * 60_000

/** The time a pause at `nowMs` would keep of an hour ending at
 *  `expiresAtMs`, or 0 when it would keep less than the minimum. */
export function freebuffSessionPauseKeepsMs(
  expiresAtMs: number,
  nowMs: number,
): number {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return 0
  const kept = expiresAtMs - nowMs - FREEBUFF_SESSION_PAUSE_COST_MS
  return kept >= FREEBUFF_SESSION_PAUSE_MIN_KEEP_MS ? kept : 0
}

/** Why the server would not pause an hour. */
export type FreebuffSessionPauseRefusal =
  /** No live paid hour on this claim (ended, expired, or never bought). */
  | 'not_found'
  /** A turn is running or queued on it: stop or finish it first. */
  | 'busy'
  /** Less than the cost plus the minimum is left. */
  | 'too_short'
  /** Nothing has run on it yet: ending it refunds the hour in full. */
  | 'unused'

export type FreebuffSessionPauseResponse =
  | {
      status: 'paused'
      /** The time the hour keeps, already less the cost. */
      keptMs: number
      /** ISO instant the paused hour stops waiting. */
      pausedUntil: string
    }
  | {
      status: 'refused'
      reason: FreebuffSessionPauseRefusal
      message: string
    }

export const FREEBUFF_SESSION_PAUSE_REFUSAL_MESSAGES: Record<
  FreebuffSessionPauseRefusal,
  string
> = {
  not_found: 'This chat has no running session to pause.',
  busy: 'Stop or finish the running turn before pausing.',
  too_short: 'Less than 16 minutes are left, so a pause would keep nothing.',
  unused:
    'Nothing has run in this session yet. End it instead to get the hour back.',
}
