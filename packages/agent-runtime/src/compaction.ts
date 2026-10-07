import { MECHANICAL_COMPACTION_SKIPPED_EVENT } from '@codebuff/common/util/axiom-only-log'

import { compactHistoryNow } from './compact-history'
import type { CompactionTrigger } from './compact-history'
import { countTokensMessages } from './util/token-counter'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const SUMMARY_LIMIT = 6_000
const MAX_OUTPUT_TOKENS = 16_384
const SUMMARY_OUTPUT_SHARE = 0.5

function liveRequest(messages: Message[]): Message[] {
  const lastPrompt = messages.findLastIndex((m) =>
    m.tags?.includes('USER_PROMPT'),
  )
  let promptStart = lastPrompt
  while (
    promptStart > 0 &&
    messages[promptStart - 1].tags?.includes('USER_PROMPT')
  )
    promptStart--
  const live =
    promptStart < 0
      ? []
      : messages
          .slice(promptStart)
          .filter((m) => m.tags?.includes('USER_PROMPT'))
  const instructions = messages.findLast((m) =>
    m.tags?.includes('INSTRUCTIONS_PROMPT'),
  )
  return [...(instructions ? [instructions] : []), ...live]
}

function summaryBudget(params: {
  maxContextLength: number
  fixedTokenCount: number
  suffixTokens: number
  maxOutputTokens?: number
}): number {
  const outputTokens =
    params.maxOutputTokens !== undefined && params.maxOutputTokens > 0
      ? Math.min(MAX_OUTPUT_TOKENS, Math.floor(params.maxOutputTokens))
      : MAX_OUTPUT_TOKENS
  return Math.min(
    SUMMARY_LIMIT,
    Math.floor(
      (params.maxContextLength - params.fixedTokenCount - params.suffixTokens) /
        3,
    ),
    Math.floor(outputTokens * SUMMARY_OUTPUT_SHARE),
  )
}

/**
 * The share of the trigger threshold a compaction's result may occupy for the
 * automatic trigger to be worth firing. Above it, the next tool result or two
 * crosses the threshold again and the run compacts its own summary.
 */
const COMPACTION_LOW_WATER = 0.85

/**
 * The context a compaction is assumed to leave behind: the fixed
 * prefix (system prompt, tool schemas), the live request it keeps verbatim,
 * and a summary. None of it is compactable, so when this is not comfortably
 * under the threshold, compacting at the threshold only buys a few thousand
 * tokens before the next one: a 32k BYOK window with ~16k of Desktop tool
 * schemas compacted every few tool calls, each pass summarizing the last
 * summary.
 */
export function compactedContextCeiling(params: {
  messages: Message[]
  maxContextLength: number
  fixedTokenCount: number
  maxOutputTokens?: number
}): number {
  const suffixTokens = countTokensMessages(liveRequest(params.messages))
  const budget = summaryBudget({ ...params, suffixTokens })
  return params.fixedTokenCount + suffixTokens + Math.max(0, budget)
}

/**
 * Whether an automatic compaction at `thresholdTokens` leaves real room to
 * work in. When it cannot, the run keeps its history until the hard budget,
 * where compaction is no longer optional.
 */
export function automaticCompactionIsWorthwhile(params: {
  messages: Message[]
  maxContextLength: number
  thresholdTokens: number
  fixedTokenCount: number
  maxOutputTokens?: number
}): boolean {
  return (
    compactedContextCeiling(params) <=
    Math.floor(params.thresholdTokens * COMPACTION_LOW_WATER)
  )
}

export function compactMechanically(params: {
  messages: Message[]
  maxContextLength: number
  fixedTokenCount: number
  targetTokens?: number
  trigger?: CompactionTrigger | 'manual'
  logger: Logger
  runId?: string
  model?: string
  contextTokenCount?: number
}): {
  messages: Message[]
  summary: string
  preTokens: number
  postTokens: number
} | null {
  const { model, contextTokenCount, ...historyParams } = params
  let error: unknown
  try {
    const result = compactHistoryNow(historyParams)
    if (result)
      return {
        messages: result.messages,
        summary: result.summaryText,
        preTokens: result.previousTokens + params.fixedTokenCount,
        postTokens: result.nextTokens + params.fixedTokenCount,
      }
  } catch (thrown) {
    error = thrown
  }
  try {
    const message = error instanceof Error ? error.message : String(error)
    params.logger[error === undefined ? 'info' : 'warn'](
      {
        axiomEvent: MECHANICAL_COMPACTION_SKIPPED_EVENT,
        agent_run_id: params.runId,
        model,
        trigger_reason: params.trigger,
        error_kind:
          error === undefined
            ? 'no_shrink'
            : message.includes('exceed the configured context window')
              ? 'over_budget'
              : 'error',
        ...(error === undefined
          ? {}
          : {
              error_name: error instanceof Error ? error.name : typeof error,
              // Not allowlisted for Axiom; local/debug logs only.
              error: message,
            }),
        context_token_count: contextTokenCount,
        max_context_length: params.maxContextLength,
      },
      error === undefined
        ? 'Mechanical compaction could not shrink the history; left unchanged'
        : 'Mechanical compaction failed; history left unchanged',
    )
  } catch {
    // Logging must never turn a skipped compaction into a failed run.
  }
  return null
}
