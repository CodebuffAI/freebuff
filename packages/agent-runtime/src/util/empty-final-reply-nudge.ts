import { stripThinkTags } from './think-tags'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * A root step about to end the turn with no tool call and no visible text
 * gets one more step, with a note to give the answer, instead of ending the
 * turn in silence. Once per user prompt: a second empty reply ends the turn.
 *
 * Why: a completion that is entirely empty (`isThinkOnlyResponse('')` is
 * false) ends the turn, ~1 in 10k DeepSeek Flash requests (production_ttft
 * `hasOutput` false, Nov 21-27); so does reasoning followed by a bare newline,
 * which the SDK's reasoning-only retry misses because the newline counts as
 * content. Either way the person pressed send and saw nothing. A step with
 * any tool call is left alone: ask_user, follow-up cards, render_ui and the
 * like all show the user something, and the other nudges own them.
 */
export const EMPTY_FINAL_REPLY_TAG = 'EMPTY_FINAL_REPLY'
export const EMPTY_FINAL_REPLY_MESSAGE =
  'Your last response had no text for the user. Give your final answer now: what you found or did, and anything still open. Call a tool only if the work is unfinished.'
export const EMPTY_FINAL_REPLY_EVENT = 'agent.empty_final_reply_nudge'

/** Called when a step is about to end the turn. `history` already holds this
 *  step's messages. */
export function endsOnEmptyFinalReply(
  toolCalls: readonly unknown[],
  responseText: string,
  history: readonly Message[],
): boolean {
  if (toolCalls.length > 0 || stripThinkTags(responseText).trim() !== '')
    return false
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.tags?.includes(EMPTY_FINAL_REPLY_TAG)) return false
    if (message.role === 'user' && message.tags?.includes('USER_PROMPT')) break
  }
  return true
}
