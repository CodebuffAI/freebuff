import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from './freebuff-model-ids'

export function compactionThreshold(maxContextLength: number): number {
  return Math.floor(maxContextLength * 0.8)
}

/**
 * When a root agent rewrites its own history after an idle gap: the user
 * comes back after `cacheExpiryMs` of silence AND the history is at least
 * `cacheExpiryMinTokens`. Below the floor a cold cache is not enough, because
 * compaction is free in tokens but never in information. The context-limit
 * trigger ignores the floor. Every pass is mechanical (no model call).
 *
 * The numbers live only here. base3 roots hand the object to the runtime as
 * `compactContext`; the runtime defaults `compactContext: true` to
 * DEFAULT_COMPACTION_POLICY; and serialized `handleSteps` that spawn
 * context-pruner (base2, base-chat) receive it as
 * `AgentStepContext.contextPruning`, resolved in run-programmatic-step.ts.
 * Exactly these two keys: `compactContext` is validated with a strict schema.
 */
export type CompactionPolicy = {
  cacheExpiryMs: number
  cacheExpiryMinTokens: number
}

/**
 * One hour: the idle trigger is a product knob, not a TTL tracker. Compaction
 * never prevents the cold prefill after a gap, it only shrinks it at the price
 * of dropped tool results, and under an hour that reads as "the model forgot
 * everything" (a top user complaint) while the cache may still be warm.
 *
 * 140k tokens is two mechanical summary ceilings (20k assistant/tool + 50k
 * user, in compact-history.ts). Below one ceiling the budget walk evicts
 * nothing, so a mostly-prose history comes back the same size plus the
 * envelope; the second ceiling is margin for the two sides being measured with
 * different rulers (`chars / 3` against a BPE count).
 */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  cacheExpiryMs: 60 * 60 * 1000,
  cacheExpiryMinTokens: 140_000,
}

/**
 * DeepSeek V4 Flash, whose front lane is Luminal.
 *
 * 15 minutes is about how long Luminal keeps a session's prefix cache. Past
 * that the next prompt re-reads everything at full price either way, so the
 * hour only buys a bigger cold prefill.
 *
 * 40k tokens rather than 140k because the hour-era floor assumed a marginal
 * trade, and here it is not. Measured with the runtime's own pass: the
 * per-message transforms alone strip ~87% of a tool-heavy coding history at
 * every size, so the budget walk the 140k figure waits for never matters.
 * What they cannot touch is the fixed prefix — ~13k tokens of tool schemas
 * plus prompt, knowledge files and git summary, typically 15-20k — so at 40k
 * the pass halves the cold prefill, while at 25k it removes a third at best
 * and drops exactly the files the model will re-read. On this lane a cold
 * input token costs ~40x a cached one, so halving a cold 60k prefill is a
 * material share of a turn's spend; the figures behind that are in
 * freebuff-costs.knowledge.md (private).
 */
export const DEEPSEEK_FLASH_COMPACTION_POLICY: CompactionPolicy = {
  cacheExpiryMs: 15 * 60 * 1000,
  cacheExpiryMinTokens: 40_000,
}

export function compactionPolicyForModel(
  model: string | null | undefined,
): CompactionPolicy {
  return model === FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
    ? DEEPSEEK_FLASH_COMPACTION_POLICY
    : DEFAULT_COMPACTION_POLICY
}
