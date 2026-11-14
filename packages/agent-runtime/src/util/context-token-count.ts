import { isFreebuffModelHandle } from '@codebuff/common/types/freebuff-model-catalog'

import {
  countTokens,
  countTokensJson,
  countTokensMessages,
} from './token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ModelUsageData } from '@codebuff/common/types/contracts/llm'
import type { AgentState } from '@codebuff/common/types/session-state'

/** The slice of AgentState this file needs, so the SDK and the step loop can
 *  both call in without either owning the full type. */
type CountableAgentState = {
  parentId?: string
  messageHistory: Message[]
  contextTokenCount: number
  contextTokenBaseline?: AgentState['contextTokenBaseline']
}

/**
 * The calibration's bounds. The estimator is one tokenizer for every model;
 * Claude Haiku 5.5 read ~1.4x it on coding histories (buffbench, 2026-10-12)
 * and MiniMax up to ~2x (agents/base-chat.ts). A ratio outside this is a
 * receipt the estimate cannot describe (images, a near-empty first prompt),
 * not a tokenizer.
 */
const MIN_SCALE = 0.5
const MAX_SCALE = 2.5

/**
 * Whether a token receipt for `anchorModel` still describes `model`. A
 * Freebuff catalog handle (`fbm1.…`) is reissued each session for the same
 * thread model, and a Freebuff thread cannot switch models, so two handles
 * are the same model. Without this, every Desktop restart dropped the
 * provider's count and the limit check fell back to a text estimate.
 */
export function sameContextModel(
  anchorModel: string | undefined,
  model: string | undefined,
): boolean {
  return (
    anchorModel === model ||
    (isFreebuffModelHandle(anchorModel) && isFreebuffModelHandle(model))
  )
}

/**
 * Latest receipt plus the estimated change since it. String lengths, not
 * tokenization, keep startup/resume/missing-usage paths cheap even for long
 * runs of repeated characters. A model switch invalidates the anchor.
 *
 * The change is scaled by the anchor's own provider-to-estimate ratio, so a
 * model whose tokenizer reads code at 1.4x the estimate is not under-counted
 * by 40% of everything added since the last request. That error was the
 * margin a compaction threshold had to leave below a hard limit.
 */
export function estimateContextTokens(params: {
  agentState: CountableAgentState
  systemPrompt: string
  toolsForTokenCount: unknown
  model?: string
}): number {
  const { agentState, systemPrompt, toolsForTokenCount } = params
  const estimatedTokens =
    countTokensMessages(agentState.messageHistory) +
    countTokens(systemPrompt) +
    countTokensJson(toolsForTokenCount)
  const baseline = agentState.contextTokenBaseline
  if (!baseline || !sameContextModel(baseline.model, params.model))
    return estimatedTokens
  const adjusted = Math.round(
    baseline.tokens +
      (estimatedTokens - baseline.estimatedTokens) * (baseline.scale ?? 1),
  )
  // A legacy/external rewrite can remove more estimated tokens than the
  // provider ever counted. Fall back rather than calling that empty context.
  return Number.isFinite(adjusted) && adjusted >= 0 ? adjusted : estimatedTokens
}

/** Record ONE call, never cumulative session usage. Cached input is already
 * included in inputTokens. Tool output is excluded from the anchor's estimated
 * size, so estimateContextTokens adds it on top of the provider's receipt. */
export function recordContextUsage(params: {
  agentState: CountableAgentState
  model: string
  usage: ModelUsageData
  estimatedInputTokens: number
  estimatedOutputTokens: number
}): void {
  const { usage, agentState } = params
  if (
    !Number.isFinite(usage.inputTokens) ||
    usage.inputTokens <= 0 ||
    !Number.isFinite(usage.outputTokens) ||
    usage.outputTokens < 0
  )
    return // Missing/malformed usage must not reset a known context to zero.
  // Input only: output tokens can include reasoning the next prompt never
  // carries, which would read as a denser tokenizer than the model has.
  const scale =
    params.estimatedInputTokens > 0
      ? Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, usage.inputTokens / params.estimatedInputTokens),
        )
      : 1
  agentState.contextTokenBaseline = {
    model: params.model,
    tokens: usage.inputTokens + usage.outputTokens,
    estimatedTokens: params.estimatedInputTokens + params.estimatedOutputTokens,
    scale,
  }
}

/** Refresh the root's displayed context on success, error and cancellation,
 * including the last response and tool results, without retokenizing history. */
export function recountContextTokens(
  params: Parameters<typeof estimateContextTokens>[0],
): number {
  if (params.agentState.parentId) return params.agentState.contextTokenCount
  return estimateContextTokens(params)
}

/**
 * Carry `contextTokenCount` across a history edit made after the last recount.
 *
 * The persistence boundary edits history the runtime has already counted: the
 * SDK drops unanswered tool calls and appends the cancellation / error message
 * that a resumed run starts from. Leaving the count untouched persists a number
 * that does not describe the history stored beside it.
 *
 * A difference rather than a recount, because the editor holds only the
 * history: the system prompt and tool schemas are the other half of the number
 * and are not in scope there. Applying the delta keeps that half exactly, and
 * the estimate stays internally consistent.
 */
export function adjustContextTokenCountForHistoryEdit(params: {
  contextTokenCount: number
  previousHistory: Message[]
  nextHistory: Message[]
  /** The anchor's calibration (`contextTokenBaseline.scale`), so this edit is
   *  counted as estimateContextTokens would count it. */
  scale?: number
}): number {
  const { contextTokenCount, previousHistory, nextHistory } = params
  if (previousHistory === nextHistory) return contextTokenCount
  const delta = Math.round(
    (countTokensMessages(nextHistory) - countTokensMessages(previousHistory)) *
      (params.scale ?? 1),
  )
  // A count carried in from before this shipped need not match its history at
  // all; a negative token count would reach the composer as a negative chip.
  return Math.max(0, contextTokenCount + delta)
}
