/**
 * The one reasoning-effort vocabulary, shared by every surface.
 *
 * This list started in `freebuff-desktop/src/shared/types.ts`, where it drives
 * the Claude Code and Codex effort pickers. It lives here now so the Freebuff
 * model catalog and Desktop speak the same words: Desktop re-exports these,
 * so a value persisted on a Desktop thread and a value on a Freebuff catalog
 * row are the same strings, comparable without a translation table.
 *
 * ORDERED, ascending, and that order is load-bearing — `clampReasoningEffort`
 * does index arithmetic on it to answer "the most effort this model allows,
 * but no more than was asked for". Keep it strictly ascending.
 *
 * Not every rung reaches every provider. `ultra` exists only for local CLI
 * harnesses; Meta tops out at `xhigh`, while both DeepSeek V4 models expose
 * `low`/`high`/`max` and nothing between. What a given model actually offers is
 * its own `efforts` array, and the clamp stops one model's rung reaching
 * another's API.
 */
export const REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Kept explicit so a picker and a turn agree, rather than each deferring to
 *  some CLI's own default. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
}

/** Position on the shared ladder, or -1. Exported for tests that assert one
 *  rung sits below another without hard-coding the list. */
export function reasoningEffortRank(value: unknown): number {
  return REASONING_EFFORTS.indexOf(value as ReasoningEffort)
}

/**
 * The highest rung `allowed` offers that is no higher than `requested`.
 *
 * Clamp-DOWN, not "reject and fall back", and the difference matters. A user on
 * Muse Spark's `xhigh` whose request is rerouted to a model topping out at
 * `high` should land on `high` — the closest thing to what they asked for —
 * rather than snapping back to that model's default, which could be lower.
 * When `requested` is below everything on offer, the lowest rung wins; when it
 * is absent or unrecognized, the caller's fallback does.
 */
export function clampReasoningEffort(
  requested: unknown,
  allowed: readonly ReasoningEffort[],
  fallback: ReasoningEffort,
): ReasoningEffort {
  if (allowed.length === 0) return fallback
  if (!isReasoningEffort(requested)) return fallback

  const wanted = reasoningEffortRank(requested)
  let best: ReasoningEffort | undefined
  for (const candidate of allowed) {
    const rank = reasoningEffortRank(candidate)
    if (rank > wanted) continue
    if (best === undefined || rank > reasoningEffortRank(best)) best = candidate
  }
  if (best !== undefined) return best

  // Everything on offer is above what was asked for: give the least of them.
  return allowed.reduce((lowest, candidate) =>
    reasoningEffortRank(candidate) < reasoningEffortRank(lowest)
      ? candidate
      : lowest,
  )
}

/**
 * The rungs a BYOK (the user's own API key) connection can be asked for.
 *
 * Three, because they are the only words every provider shape BYOK reaches
 * understands: OpenAI-compatible `reasoning_effort`, OpenRouter's
 * `reasoning.effort`, Gemini's OpenAI-compatible `reasoning_effort`, and an
 * Anthropic thinking budget per rung. There is deliberately no "default" rung
 * here: a BYOK thread with no pick sends nothing, so the provider's own default
 * applies — exactly the request BYOK sent before this setting existed.
 */
export const BYOK_REASONING_EFFORTS = ['low', 'medium', 'high'] as const

export type ByokReasoningEffort = (typeof BYOK_REASONING_EFFORTS)[number]

export function isByokReasoningEffort(
  value: unknown,
): value is ByokReasoningEffort {
  return BYOK_REASONING_EFFORTS.includes(value as ByokReasoningEffort)
}
