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

/**
 * What a hosted turn fails with when its hour ran out while its computer was
 * away: a turn parked for its computer whose hour lapsed before it came back
 * (worker.ts `startRefusalMessage`), or a running turn whose renewal was held
 * for an away computer (cloud-session-renewal.ts). The worker buys no hour for
 * either: a lapsed lease leaves no tier or country to admit on. The hosted
 * window recognises this by equality and continues the turn with
 * `DEVICE_AWAY_CONTINUE_PROMPT` through its queue's ordinary send, which starts
 * a new hour with every admission gate: inside Desktop with Auto-renew sessions
 * on, by itself once for any open tab, otherwise on one click (freebuff/web
 * `queue.ts` `queueAwayContinue`). Change both sides together.
 */
export const DEVICE_AWAY_HOUR_ENDED =
  'Your hour ran out while your computer was away, so no new hour was started. Completed steps are saved; send a message to continue.'

/** The message that continues a turn that ended on `DEVICE_AWAY_HOUR_ENDED`.
 *  Its progress is in the chat's saved state; a plain Retry would start the
 *  task over. The agent reads it; the transcript shows
 *  `DEVICE_AWAY_CONTINUE_LABEL` in its place (`displayPrompt`). */
export const DEVICE_AWAY_CONTINUE_PROMPT =
  'Continue from where the last turn stopped. Its hour ran out while my computer was away, so it stopped partway. Check where the task stands, then go on without redoing steps that are already done.'

/** What the transcript shows for that continue: a quiet line, never a message
 *  in the user's voice they did not write. The window knows the run by this
 *  label (`automaticTurn`, freebuff/web history-transcript.ts), as a background
 *  wake by its flag. */
export const DEVICE_AWAY_CONTINUE_LABEL = 'Continued after your computer reconnected'
