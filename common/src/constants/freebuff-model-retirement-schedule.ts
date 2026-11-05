/**
 * Dated retirements (product, 2026-11-05, Victor): GPT-6 Luna and GLM 5.3
 * Flash leave Freebuff in two steps, a slow removal rather than a cut.
 *
 *   closesAt  new sessions are refused (fresh admission, and buying the next
 *             hour of a running Desktop tab). A session already admitted
 *             keeps running on the row it was admitted for.
 *   endsAt    requests on a session bound to it are refused as withdrawn,
 *             in the chat gate and on reclaim, so the few sessions still open
 *             end there. The rows then join the catalog's retired set by PR.
 *
 * Until then the catalog rows carry the "Ending now" pill, whose tooltip
 * (default-config.ts, `retiringBadge`) names these instants in words: move
 * both together. Only session code reads them, with its own clock; the
 * catalog never does, so no test that runs these rows as ordinary fixtures
 * changes with the date. A leaf module.
 */
export type FreebuffScheduledRetirement = {
  closesAt: number
  endsAt: number
}

const LUNA_AND_GLM: FreebuffScheduledRetirement = Object.freeze({
  // 6 pm PT on Thursday, November 5, a day after the decision.
  closesAt: Date.parse('2026-11-06T02:00:00Z'),
  endsAt: Date.parse('2026-11-06T05:00:00Z'),
})

export const FREEBUFF_SCHEDULED_RETIREMENTS: Readonly<
  Record<string, FreebuffScheduledRetirement>
> = Object.freeze({
  'openai/gpt-6-luna': LUNA_AND_GLM,
  'z-ai/glm-5.3-flash': LUNA_AND_GLM,
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

/** Sits inside "<model> isn't available right now (…)", the sentence released
 *  clients build around `availableHours`. */
export function freebuffClosedModelAvailabilityLabel(): string {
  return 'it is leaving Freebuff and no longer starts new sessions — switch to DeepSeek V4.1 Flash'
}
