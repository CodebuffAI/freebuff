/**
 * The quick status line: one short sentence, written by a small model from the
 * user's new message and the agent's last reply, that the hosted workspace shows
 * while a Freebuff turn waits for its first output. It is presentation only:
 * never stored, never part of the transcript or of any model's context.
 */

/** The line as shown. A longer answer is cut at a word, never wrapped past two lines. */
export const QUICK_STATUS_MAX_CHARS = 120

/** How much of the agent's last reply the page may send, taken from its end. */
export const QUICK_STATUS_PREVIOUS_MAX_CHARS = 1_500

/** What the page gets back: the line, or null when there is none for this run. */
export type QuickStatusResponse = { text: string | null }
