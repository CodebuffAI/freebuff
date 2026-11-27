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

/** Each rung's own name, on every surface. The middle rung reads Balanced,
 *  never Medium (product, 2026-11-26, Victor). Name a rung through
 *  `reasoningEffortLabel`, which knows the one ladder that renames them. */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Balanced',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

/**
 * A rung's name on the ladder it is offered on. Instant is only ever a stop
 * that does not think (product, 2026-11-24, Victor): DeepSeek V4's ladder is
 * `minimal`, `low`, `high`, `max`, where `minimal` turns thinking off (the
 * server sends `reasoning.enabled: false`) and `low` still thinks, so it
 * reads Instant, Balanced, High, Max. That is the one ladder with `minimal` and
 * no `medium`; every other names each rung as itself (an OpenAI `minimal`
 * still thinks a little, so it stays Minimal).
 */
export function reasoningEffortLabel(
  effort: ReasoningEffort,
  ladder: readonly string[] = [],
): string {
  if (ladder.includes('minimal') && !ladder.includes('medium')) {
    if (effort === 'minimal') return 'Instant'
    if (effort === 'low') return 'Balanced'
  }
  return REASONING_EFFORT_LABELS[effort]
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

/**
 * The rungs a ChatGPT plan's models take (provider `chatgpt`). Their requests go to the same
 * Responses backend Codex uses, whose `reasoning.effort` accepts every rung up to `ultra`, so the
 * Freebuff agent offers what Codex offers rather than the three-rung BYOK ladder.
 */
export const CHATGPT_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly ReasoningEffort[]

/** The rungs a saved provider connection can be asked for. */
export function byokReasoningEfforts(
  provider: string,
): readonly ReasoningEffort[] {
  return provider === 'chatgpt' ? CHATGPT_REASONING_EFFORTS : BYOK_REASONING_EFFORTS
}

/** Any rung some saved provider accepts: what a thread bound to one may store. */
export function isProviderReasoningEffort(
  value: unknown,
): value is ReasoningEffort {
  return (CHATGPT_REASONING_EFFORTS as readonly unknown[]).includes(value)
}
