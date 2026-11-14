/**
 * What a hosted turn fails with when the session it was sent on is gone by the
 * time the scheduler starts it: the hour ran out (with its drain window) while
 * the turn queued, or the session was ended or replaced. No agent ran, so
 * nothing was used of it. The hosted window recognises this by equality and
 * resends the turn on a new session: by itself once when Auto-renew sessions is
 * on, otherwise on one click (`run-view.tsx`). Change both sides together.
 */
export const CLOUD_SESSION_ENDED_BEFORE_START =
  'Your session ended before this message could start. Start a new session to send it.'
