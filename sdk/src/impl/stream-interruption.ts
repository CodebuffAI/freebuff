/**
 * Classification of completion-stream endings that would otherwise silently
 * end the turn with nothing visible to the user. Two classes:
 *
 * **'stream-interrupted'** — the connection was cut mid-response. A healthy
 * OpenAI-compatible SSE stream always ends with a chunk carrying a real
 * `finish_reason` (and, on our backend, usage totals) before `[DONE]`. When
 * the connection dies mid-stream — a server deploy killing the instance, a
 * proxy timeout, a network drop — the HTTP body just ends: the AI SDK
 * provider's flush then emits a `finish` part with raw finish reason
 * `'unknown'` and no usage (normalized to `'other'` by AI SDK 7), and the
 * stream otherwise looks like a normal completion. `'unknown'` alone is not
 * proof: providers map any unrecognized `finish_reason` string to `'unknown'`
 * too. Usage disambiguates — it arrives in the stream's final chunk, so
 * `'unknown'` *with* usage means an odd but complete stream, while `'unknown'`
 * *without* usage means the tail was never received. A missing finish part
 * altogether is always an interruption.
 *
 * **'output-limit'** — the model produced no text or tool calls because it
 * either spent its output budget on reasoning (`length`) or ended the stream
 * after emitting only native reasoning, under any finish reason the provider
 * chose to report (a Bedrock-via-OpenRouter reasoning-only end has arrived as
 * 'unknown' with usage). Both are complete, well-formed streams whose turns
 * would otherwise end with nothing visible. A `length` stop after real output
 * is the answer running long, which is not silently recoverable (retrying
 * would duplicate output).
 *
 * Before this existed, both classes read as the agent "randomly stopping"
 * mid-thinking with no error anywhere (2026-07-17 incident).
 */

import type { StreamRecoverySource } from '@codebuff/common/types/contracts/llm'
import {
  extractApiErrorDetails,
  isTransientNetworkError,
} from '@codebuff/common/util/error'

export interface StreamFinishInfo {
  finishReason: string
  hasUsage: boolean
}

/** Distill an AI SDK `stream` finish part into what detection needs. */
export function streamFinishInfoOf(
  part: {
    finishReason: string
    rawFinishReason?: string
    totalUsage: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
  },
  v2Compatibility = false,
): StreamFinishInfo {
  const { inputTokens, outputTokens, totalTokens } = part.totalUsage
  return {
    finishReason:
      part.finishReason === 'other' &&
      (part.rawFinishReason === 'unknown' ||
        (v2Compatibility && part.rawFinishReason === undefined))
        ? 'unknown'
        : part.finishReason,
    hasUsage: [inputTokens, outputTokens, totalTokens].some(
      (tokens) => typeof tokens === 'number' && Number.isFinite(tokens),
    ),
  }
}

export interface StreamEndRecovery {
  source: StreamRecoverySource
  /** Injected into the conversation (and shown to the user). Written for the
   *  model: the retry step sees its own partial output plus this note. */
  message: string
}

const STREAM_INTERRUPTED_RECOVERY: StreamEndRecovery = {
  source: 'stream-interrupted',
  message:
    'The connection dropped while the response was streaming, so the output above may be cut off mid-thought. Continue from where it left off (or start the step over if nothing useful arrived).',
}

const OUTPUT_LIMIT_RECOVERY: StreamEndRecovery = {
  source: 'output-limit',
  // The actionable instruction is a tighter budget on the redo: finishing the
  // same depth of reasoning would hit the same limit again.
  message:
    'The response hit its output token limit while still reasoning, so no answer was produced. Redo this step thinking much more briefly, and get to the response or tool calls quickly.',
}

const REASONING_ONLY_RECOVERY: StreamEndRecovery = {
  // Keep the existing source so this follows the same bounded retry path,
  // while the message stays truthful for a complete stream.
  source: 'output-limit',
  message:
    'The response ended after reasoning without producing an answer or tool call. Continue this step, think more briefly, and get to the response or tool calls quickly.',
}

/**
 * Decide whether a completed stream ended in a recoverable silent stop.
 * Returns the recovery to yield as an error chunk, or null for normal
 * endings. A user cancel (`aborted`) also ends streams early and is never a
 * recovery.
 */
export function classifyStreamEndRecovery(params: {
  aborted: boolean
  /** Info from the stream's `finish` part, or undefined if none arrived. */
  finish: StreamFinishInfo | undefined
  receivedReasoning: boolean
  yieldedText: boolean
  yieldedToolCall: boolean
}): StreamEndRecovery | null {
  const { aborted, finish, receivedReasoning, yieldedText, yieldedToolCall } =
    params
  if (aborted) return null

  const interrupted =
    finish === undefined ||
    (finish.finishReason === 'unknown' && !finish.hasUsage)
  if (interrupted) return STREAM_INTERRUPTED_RECOVERY

  if (yieldedText || yieldedToolCall) return null

  if (finish.finishReason === 'length') return OUTPUT_LIMIT_RECOVERY

  // Whatever finish reason the provider reported ('stop', 'unknown' with
  // usage, anything else): reasoning with nothing visible after it is a
  // silent stop.
  if (receivedReasoning) return REASONING_ONLY_RECOVERY

  return null
}

/**
 * Classify an exception thrown while consuming a completion stream. Some
 * runtimes surface a severed response body as an exception (for example Bun's
 * `ConnectionClosed` / `ECONNRESET`) instead of the graceful-but-incomplete
 * stream ending handled by {@link classifyStreamEndRecovery}. Both represent
 * the same recoverable condition to the agent loop.
 *
 * A provider-reported 5xx/429 that arrives mid-stream — the openai-compatible
 * shim enqueues it as an `error` part with `finishReason='error'` — is the
 * same transient event as a severed body: the upstream had a bad moment, and
 * the retry the agent loop forces (capped) is the response either way. A
 * client-error status (400/401/402/403) is deterministic — retrying cannot
 * help — so it stays fatal and propagates to the run's error handling.
 */
export function classifyThrownStreamRecovery(params: {
  aborted: boolean
  error: unknown
}): StreamEndRecovery | null {
  if (params.aborted) return null
  if (isTransientNetworkError(params.error)) return STREAM_INTERRUPTED_RECOVERY
  const { statusCode } = extractApiErrorDetails(params.error)
  if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return {
      source: 'stream-interrupted',
      message: `The provider reported a temporary failure (HTTP ${statusCode}) while the response was streaming, so the output above may be cut off mid-thought. Continue from where it left off (or start the step over if nothing useful arrived).`,
    }
  }
  return null
}
