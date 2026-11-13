/**
 * The review of a finished turn: one request with the agent's own system
 * prompt, tools and history plus `TURN_REVIEW_PROMPT`, so the provider reads
 * the conversation from its warm cache. Its reply becomes one-click next
 * prompts and a verdict for the host to show; nothing joins the history.
 */

import {
  readTurnReview,
  TURN_REVIEW_METADATA_KEY,
  TURN_REVIEW_PROMPT,
  TURN_REVIEW_TIMEOUT_MS,
} from '@codebuff/common/constants/turn-review'
import { TURN_REVIEW_EVENT } from '@codebuff/common/util/axiom-only-log'
import { getErrorObject } from '@codebuff/common/util/error'
import { systemMessage, userMessage } from '@codebuff/common/util/messages'

import { withSystemInstructionTags } from './util/messages'

import type { SummaryStream } from './conversation-summary'
import type { TurnReview } from '@codebuff/common/constants/turn-review'
import type { ModelUsageData } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/** Asks for the review. `history` must be what the agent's next request sends. */
export async function reviewTurn(params: {
  history: Message[]
  system: string
  /** TURN_REVIEW_PROMPT, or `turnReviewPrompt` with the user's recent messages. */
  prompt?: string
  stream: SummaryStream
  logger: Logger
  runId: string
  model: string
  telemetry?: Record<string, string>
}): Promise<TurnReview | null> {
  const started = Date.now()
  let usage: ModelUsageData | undefined
  let finishReason: string | undefined
  let outcome = 'failed'
  let review: TurnReview | null = null
  try {
    const stream = params.stream({
      messages: [
        systemMessage(params.system),
        ...params.history,
        // Tagged so the server's prompt classifier skips it as product text.
        userMessage({
          content: withSystemInstructionTags(params.prompt ?? TURN_REVIEW_PROMPT),
        }),
      ],
      signal: AbortSignal.timeout(TURN_REVIEW_TIMEOUT_MS),
      extraCodebuffMetadata: { [TURN_REVIEW_METADATA_KEY]: '1' },
      onFinishReason: (reason) => {
        finishReason = reason
      },
      onUsageReceived: (received) => {
        usage = received
      },
    })
    let text = ''
    for (;;) {
      const next = await stream.next()
      if (next.done) break
      if (next.value.type === 'error') throw new Error(next.value.message)
      if (next.value.type === 'text') text += next.value.text
    }
    const read = readTurnReview(text)
    // `empty`: a well-formed review with nothing to suggest, not a broken reply.
    outcome = read === 'empty' ? 'empty' : read ? 'completed' : 'unrecognized'
    review = read === 'empty' ? null : read
    return review
  } catch (error) {
    params.logger.debug?.({ error: getErrorObject(error) }, 'Turn review failed')
    return null
  } finally {
    try {
      params.logger.info(
        {
          axiomEvent: TURN_REVIEW_EVENT,
          ...params.telemetry,
          agent_run_id: params.runId,
          model: params.model,
          outcome,
          finish_reason: finishReason,
          verdict: review?.verdict ?? undefined,
          action_count: review?.actions.length ?? 0,
          offers_brainstorm: review?.actions.some((action) => action.kind === 'brainstorm') ?? false,
          duration_ms: Date.now() - started,
          ...(usage
            ? {
                input_tokens: usage.inputTokens,
                cached_input_tokens: usage.cachedInputTokens,
                output_tokens: usage.outputTokens,
              }
            : {}),
        },
        'Turn review finished',
      )
    } catch {
      // Logging must never fail a review.
    }
  }
}
