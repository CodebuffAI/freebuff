import { countTokensMessages } from './util/token-counter'

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
 * The most an automatic compaction may leave behind, measured after the pass
 * has run. `automaticCompactionIsWorthwhile` asks the same question before
 * it, from the parts it can predict — the fixed prefix, the live request and
 * a summary — but a pass also keeps the fresh tool exchange whole and may
 * re-provide a working set, and those two are what actually fill a small
 * budget. Measured over 48 h of production compactions on the 110k lean
 * budget: the median pass left 36k, but in the runs that compacted ten times
 * or more the median pass left 68k against an 88k threshold and shrank the
 * history by 18%, so the next read triggered the next pass.
 */
export function automaticCompactionPostCeiling(
  thresholdTokens: number,
): number {
  return Math.floor(thresholdTokens * COMPACTION_LOW_WATER)
}

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

/**
 * Why the run stops when compaction left it over the hard budget, and the way
 * out. A BYOK connection's window is the user's own setting; a hosted model's
 * is fixed, so there the way out is another model. web's Desktop Cloud error
 * passthrough matches the opening words.
 */
export function compactionOverBudgetMessage(params: {
  maxContextLength: number
  byok: boolean
}): string {
  const remedy = params.byok
    ? 'give a BYOK connection a larger context window if its model supports one'
    : 'switch to a model with a larger context window'
  return `Compaction could not bring this conversation under the model's ${params.maxContextLength.toLocaleString('en-US')}-token context budget. History has been preserved. Start a new thread, or ${remedy}.`
}
