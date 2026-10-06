/**
 * When a "your Convex deployment is paused" email may go out.
 *
 * The email announces a TRANSITION — not paused → paused — and nothing else.
 * Until 2026-09-24 both pause records emailed whenever the stored reason
 * differed from the incoming one, and an external caller POSTing
 * `/pause-user-deployments` once per usage feature (compute, function calls,
 * db bandwidth) every five minutes flipped the reason on every call. That was
 * 48% of all Resend volume over a week (52,866 of 109,735), 2,101 mails in six
 * hours to nine people, on the domain that also sends sign-in codes.
 *
 * Two rules, applied to user and project pauses alike:
 *
 * 1. An ACTIVE pause record means the user/project is already paused. A second
 *    pause updates the record silently, whatever its reason.
 * 2. A genuinely new pause still stays quiet if a notice went out for the same
 *    user/project within `PAUSE_NOTICE_COOLDOWN_MS`. This is the backstop for
 *    a pause/unpause flap, which rule 1 cannot see because every re-pause after
 *    an unpause really is a transition. `lastNoticeAt` is carried from record
 *    to record so a suppressed episode does not reset the window.
 *
 * In `common` because both stores decide it: the Convex pause mutations
 * (re-exported by freebuff/web/convex/deployment_pause_notice.ts) and their
 * Postgres twins (packages/internal/src/project-spine/pause-writes.ts).
 */

export const PAUSE_NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000

export type PauseNoticeDecision = {
  notify: boolean
  /** Value to store as `lastNoticeAt` on the record being written. */
  lastNoticeAt: number | undefined
}

export function decidePauseNotice(args: {
  /** An active pause record already exists for this user/project. */
  alreadyPaused: boolean
  /**
   * `lastNoticeAt` of the record that describes the most recent pause: the
   * active one when `alreadyPaused`, otherwise the latest inactive one.
   */
  lastNoticeAt: number | undefined
  now: number
}): PauseNoticeDecision {
  if (args.alreadyPaused) {
    return { notify: false, lastNoticeAt: args.lastNoticeAt }
  }
  if (
    args.lastNoticeAt !== undefined &&
    args.now - args.lastNoticeAt < PAUSE_NOTICE_COOLDOWN_MS
  ) {
    return { notify: false, lastNoticeAt: args.lastNoticeAt }
  }
  return { notify: true, lastNoticeAt: args.now }
}
