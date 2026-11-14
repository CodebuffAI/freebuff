/**
 * Dated retirements (product, 2026-11-05, Victor): GLM 5.3 Flash leaves
 * Freebuff in two steps, a slow removal rather than a cut. GPT-6 Luna was on
 * the same schedule until, the same evening, Respan's fix to its prompt cache
 * made it cheaper to serve than DeepSeek V4.1 Flash, and it stayed.
 *
 *   closesAt  new sessions are refused (fresh admission, and buying the next
 *             hour of a running Desktop tab). A session already admitted
 *             keeps running on the row it was admitted for.
 *   endsAt    requests on a session bound to it are refused as withdrawn,
 *             in the chat gate and on reclaim, so the few sessions still open
 *             end there.
 *
 * Both steps have passed: the catalog row is retired for every viewer
 * (default-config.ts, RETIRED_COMPILED_MODEL_IDS), which makes it withdrawn
 * through the catalog too. The schedule stays as the refusal for a stored
 * admin catalog that still enables the row, and as the record of when. Only
 * session code reads it, with its own clock; the catalog never does. A leaf
 * module.
 */
export type FreebuffScheduledRetirement = {
  closesAt: number
  endsAt: number
}

const GLM_V53_FLASH: FreebuffScheduledRetirement = Object.freeze({
  // 6 pm PT on Thursday, November 5, a day after the decision.
  closesAt: Date.parse('2026-11-06T02:00:00Z'),
  endsAt: Date.parse('2026-11-06T05:00:00Z'),
})

export const FREEBUFF_SCHEDULED_RETIREMENTS: Readonly<
  Record<string, FreebuffScheduledRetirement>
> = Object.freeze({
  'z-ai/glm-5.3-flash': GLM_V53_FLASH,
})

export function freebuffScheduledRetirement(
  modelId: string | null | undefined,
): FreebuffScheduledRetirement | undefined {
  return modelId ? FREEBUFF_SCHEDULED_RETIREMENTS[modelId] : undefined
}

/** Whether new sessions on this model are refused at `now`. */
export function freebuffModelClosedToNewSessions(
  modelId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const retirement = freebuffScheduledRetirement(modelId)
  return !!retirement && now >= retirement.closesAt
}

/** Whether this model's catalog row is retired at `now`. */
export function freebuffModelScheduledRetired(
  modelId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const retirement = freebuffScheduledRetirement(modelId)
  return !!retirement && now >= retirement.endsAt
}

/**
 * Compiled models retired for every viewer (product, 2026-10-27), after their
 * "Leaving" pills from 2026-10-24: Gemini 4 Argon and Gemini 3.8 Flash. MiMo
 * 2.6 Pro followed on 2026-10-29, after its Ending pill from 2026-10-27, and
 * GPT-6.1 Sol on 2026-11-04 (product, Victor), after its Ending pill from
 * 2026-11-03. GLM 5.3 Flash followed after its two-step removal above ended.
 * GPT-6 Luna was on the same schedule until it was kept on 2026-11-05.
 *
 * DeepSeek V4.1 Flash Fast followed on 2026-11-08 (product, Victor), with no
 * pill first: DeepSeek Fast, the uncapped DeepSeek V4.1 Flash row, replaces
 * fast mode. MiMo v2.6 Flash Fast is not retired: the server still admits it
 * for reasons kept out of this public file, and lists it to nobody instead.
 *
 * The server's default catalog disables these rows (default-config.ts), and a
 * picker drawing the compiled list without a catalog (signed out, or before
 * it loads) leaves them out too. The ids stay recognised, so a saved pick
 * gets the benign stale-catalog answer and lands on the recommendation.
 */
export const FREEBUFF_RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  'google/gemini-4-argon',
  'google/gemini-3.8-flash',
  'mimo/mimo-v2.6-pro',
  'openai/gpt-6.1-sol',
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-fast',
])

/**
 * Compiled models still admitted but listed by no picker (product,
 * 2026-11-08, Victor): MiMo v2.6 Flash Fast, whose Slow row is DeepSeek Slow.
 * The server catalog sends the row to no viewer (`unlisted`), and the
 * compiled pickers that draw without a catalog leave it out. A saved pick
 * still runs on it.
 */
export const FREEBUFF_UNLISTED_MODEL_IDS: ReadonlySet<string> = new Set([
  'mimo/mimo-v2.5',
])

/** Sits inside "<model> isn't available right now (…)", the sentence released
 *  clients build around `availableHours`. */
export function freebuffClosedModelAvailabilityLabel(): string {
  return 'it is leaving Freebuff and no longer starts new sessions — switch to DeepSeek V4.1 Flash'
}
