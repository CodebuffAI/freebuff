import { z } from 'zod/v4'

/**
 * A Cloud chat's message queue, as each device holding one last reported it.
 *
 * A queue stays its device's own: that device drains it and edits its rows.
 * `freebuff_cloud_run_active` allows one queued or running run per chat, so a
 * server-held queue could be drained by two clients at once, or by one that is
 * gone. Cloud keeps each device's newest report only so that:
 *
 * - another device can show what is waiting (`GET chats/:id/queue`), and
 * - a turn that ends with more queued behind it holds its `chat_finished`
 *   push (desktop-cloud/store.ts `raiseAttention`) until the next row starts,
 *   which makes the push stale, or `CHAT_QUEUE_HOLD_MS` passes without one, so
 *   a queue that cannot drain (a phone in a pocket) still tells the user.
 *
 * A report is never a source of truth, so one older than `CHAT_QUEUE_STALE_MS`
 * is ignored. A device re-sends while it holds rows (`CHAT_QUEUE_REPORT_MS`),
 * and an empty report removes its row.
 */
export const CHAT_QUEUE_MAX_ITEMS = 20
/** A row only needs its opening for a one-line lane. */
export const CHAT_QUEUE_PROMPT_MAX = 200
export const CHAT_QUEUE_MAX_CLIENTS = 8
/** A report older than this counts nowhere. */
export const CHAT_QUEUE_STALE_MS = 15 * 60_000
/** How often a device holding rows re-sends its report, well inside the stale window. */
export const CHAT_QUEUE_REPORT_MS = 5 * 60_000
/**
 * How long a finished turn's push waits for the queue's next row. A visible
 * page drains within seconds; a hidden one's timers can run once a minute.
 */
export const CHAT_QUEUE_HOLD_MS = 2 * 60_000
/** The largest report body: 20 rows of 200 characters, even all JSON-escaped. */
export const CHAT_QUEUE_BODY_MAX = 32_768

export const chatQueueItemSchema = z.object({
  id: z.string().min(1).max(120),
  /**
   * The row's opening, for the lane; empty for a row of images only. Clients
   * cut it to `CHAT_QUEUE_PROMPT_MAX` in their own units (Swift counts
   * characters, not UTF-16), so the bound is looser and Cloud cuts again.
   */
  prompt: z.string().max(CHAT_QUEUE_PROMPT_MAX * 5),
  /** The composer mode it runs in, for the row's icon. */
  mode: z.string().max(20).optional(),
})

/** What a device sends: its own waiting rows, and whether its queue is held. */
export const chatQueueReportSchema = z.object({
  client: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  items: z.array(chatQueueItemSchema).max(CHAT_QUEUE_MAX_ITEMS),
  paused: z.boolean().optional(),
})

export type ChatQueueItem = z.infer<typeof chatQueueItemSchema>
export type ChatQueueReport = z.infer<typeof chatQueueReportSchema>
/** Each device's fresh report, newest first, as another device reads it. */
export type ChatQueueReports = {
  reports: Array<{ client: string; items: ChatQueueItem[] }>
}

/** A row's prompt as reported: its opening, at most `CHAT_QUEUE_PROMPT_MAX`. */
export function chatQueuePrompt(prompt: string): string {
  return prompt.slice(0, CHAT_QUEUE_PROMPT_MAX)
}
