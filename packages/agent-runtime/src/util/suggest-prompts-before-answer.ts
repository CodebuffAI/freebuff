import {
  FOLLOWUP_SUGGESTION_TOOL_NAMES,
  MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE,
} from '../tools/stream-parser'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * A step that calls a follow-up suggestion tool (Desktop's suggest_prompts,
 * the CLI's suggest_followups) with only a short lead-in ("Here's the plan.")
 * gets one more step, with a note to write the answer, instead of ending the
 * turn. Once per user prompt; cards beside a real answer still end it. Why and
 * how it was measured: docs/freebuff-muse-spark.md.
 */
export const SUGGEST_PROMPTS_BEFORE_ANSWER_TAG = 'SUGGEST_PROMPTS_BEFORE_ANSWER'
export const SUGGEST_PROMPTS_BEFORE_ANSWER_MESSAGE =
  'Your last message suggested follow-ups but held only a short line. If you have an answer or result for the user, write it now as plain text. If that line was your whole answer, add nothing. Do not suggest follow-ups again this turn.'

const ANSWER_MIN_CHARS = 300

/** Called when a step is about to end the turn. `history` already holds this
 *  step's calls, one message per call. A step at the suggestion cap is a
 *  runaway, which the cap ends. */
export function endsOnSuggestPromptsBeforeAnswer(
  toolCalls: { toolName: string }[],
  responseText: string,
  history: Message[],
): boolean {
  if (
    toolCalls.length === 0 ||
    toolCalls.length >= MAX_FOLLOWUP_SUGGESTION_CALLS_PER_RESPONSE ||
    !toolCalls.every((call) =>
      FOLLOWUP_SUGGESTION_TOOL_NAMES.has(call.toolName),
    ) ||
    responseText.trim().length >= ANSWER_MIN_CHARS
  ) {
    return false
  }
  let suggestCalls = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.role === 'user' && message.tags?.includes('USER_PROMPT')) break
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content) {
      if (
        part.type === 'tool-call' &&
        FOLLOWUP_SUGGESTION_TOOL_NAMES.has(part.toolName)
      ) {
        suggestCalls++
      }
    }
  }
  return suggestCalls <= toolCalls.length
}
