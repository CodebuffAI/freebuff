/**
 * Compaction by structured summary, prepared in the background.
 *
 * The goals: a summary is ready before it is needed (low latency), it keeps
 * decisions, requirements and next steps (accurate), and a user who returns
 * after the prompt cache expired sends a small request (no cold start).
 *
 * 1. When the context reaches FIRST_SUMMARY_TOKENS, and then each time it
 *    grows by SUMMARY_GROWTH_TOKENS since the last summary, the runtime asks
 *    the agent's own model for a summary of the whole conversation. The
 *    request is the agent's normal request plus one instruction, so the
 *    provider reads the history from its warm cache. It runs in the
 *    background: after a step, or when the turn ends. A new summary replaces
 *    the old one.
 * 2. The full history is still sent while the cache is warm.
 * 3. The summary is used only when the user returns after SUMMARY_IDLE_MS, or
 *    when the context reaches its limit. Then the request is the summary, the
 *    messages after it, and the new message.
 *
 * The summary waits on the agent state (`compactionSummary`), outside the
 * history. A summary that finishes after its run ended reaches the next run
 * of the same conversation through an in-process store.
 */

import {
  buildCompactionSummaryPrompt,
  COMPACTION_SUMMARY_METADATA_KEY,
} from '@codebuff/common/constants/compaction-summary'
import { COMPACTION_SUMMARY_EVENT } from '@codebuff/common/util/axiom-only-log'
import {
  AbortError,
  getErrorObject,
  isAbortError,
} from '@codebuff/common/util/error'
import {
  dropUnansweredToolCalls,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'

import { SUMMARY_HEADER } from './compact-history'
import { expireMessages, withSystemInstructionTags } from './util/messages'
import { countTokens } from './util/token-counter'

import type { OpenRouterReasoningOptions } from '@codebuff/common/types/agent-template'
import type {
  ModelUsageData,
  PromptAiSdkStreamFn,
} from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ConversationSummary } from '@codebuff/common/types/session-state'

/**
 * The idle gap after which the summary replaces the history. Five minutes is
 * the shortest prompt cache measured on our lanes (Anthropic via Respan,
 * prod 2026-10-26); Pareto keeps it 10-15 minutes, OpenAI about 30.
 */
export const SUMMARY_IDLE_MS = 5 * 60 * 1000
export const FIRST_SUMMARY_TOKENS = 40_000
export const SUMMARY_GROWTH_TOKENS = 30_000
/** Small windows use shares of the window instead of the fixed sizes. */
const FIRST_SUMMARY_SHARE = 0.2
const SUMMARY_GROWTH_SHARE = 0.15
const SUMMARY_TARGET_TOKENS = 2_000
const SUMMARY_TARGET_SHARE = 0.1
const SUMMARY_MAX_OUTPUT_TOKENS = 16_384
const MIN_SUMMARY_CHARS = 200

export const CONVERSATION_SUMMARY_TAG = 'CONVERSATION_SUMMARY'

const SUMMARY_NOTE =
  'Historical memory only: it replaces the earlier conversation. Messages after it are real messages. The latest user request can appear both in the memory and after it: the memory then records work already done on it, so continue that work, do not start over. If no user message follows, continue the latest request in the memory with real tool calls.'

export function summaryThresholds(maxContextLength: number): {
  first: number
  growth: number
} {
  return {
    first: Math.min(
      FIRST_SUMMARY_TOKENS,
      Math.floor(maxContextLength * FIRST_SUMMARY_SHARE),
    ),
    growth: Math.min(
      SUMMARY_GROWTH_TOKENS,
      Math.floor(maxContextLength * SUMMARY_GROWTH_SHARE),
    ),
  }
}

/** How long a summary is asked to be: small windows get a shorter one. */
export function summaryTargetTokens(maxContextLength: number): number {
  return Math.min(
    SUMMARY_TARGET_TOKENS,
    Math.floor(maxContextLength * SUMMARY_TARGET_SHARE),
  )
}

/** Whether the context grew enough since `latest` to need a new summary. */
export function summaryIsDue(params: {
  contextTokens: number
  maxContextLength: number
  /** The newest summary made or in progress, as its context size. */
  latestContextTokens: number | undefined
}): boolean {
  const { first, growth } = summaryThresholds(params.maxContextLength)
  if (params.latestContextTokens === undefined)
    return params.contextTokens >= first
  return params.contextTokens - params.latestContextTokens >= growth
}

/**
 * Whether the live prompt arrived after the conversation sat idle longer than
 * the shortest prompt cache. Only true before the assistant answers it.
 */
export function isIdleReturn(messages: Message[], now = Date.now()): boolean {
  const promptIndex = messages.findLastIndex((m) =>
    m.tags?.includes('USER_PROMPT'),
  )
  if (promptIndex <= 0) return false
  if (messages.slice(promptIndex + 1).some((m) => m.role === 'assistant'))
    return false
  const prompt = messages[promptIndex]
  const sentAt = prompt.sentAt ?? now
  for (let i = promptIndex - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    return (
      message.sentAt !== undefined && sentAt - message.sentAt > SUMMARY_IDLE_MS
    )
  }
  return false
}

/** The history exactly as the agent's next request sends it. */
export function summaryRequestHistory(messages: Message[]): Message[] {
  return dropUnansweredToolCalls(expireMessages(messages, 'agentStep'))
}

function isEphemeral(message: Message): boolean {
  return (
    message.timeToLive !== undefined ||
    message.tags?.includes('STEP_PROMPT') === true
  )
}

/** A short, stable id for a message's content (FNV-1a). */
export function messageFingerprint(message: Message): string {
  const text =
    message.role +
    '\u0000' +
    (message.role === 'tool' ? message.toolCallId : '') +
    '\u0000' +
    JSON.stringify(message.content)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

/**
 * Where the summary's covered part ends in `messages`, or -1 when the last
 * covered message is gone (an edit removed it). Searched from its recorded
 * position first, then from the end: dropped scaffolding can move it.
 */
function anchorIndex(
  messages: Message[],
  summary: ConversationSummary,
): number {
  const expected = summary.coveredMessages - 1
  if (
    messages[expected] &&
    messageFingerprint(messages[expected]) === summary.anchor
  )
    return expected
  for (let i = Math.min(expected, messages.length - 1); i >= 0; i--) {
    if (messageFingerprint(messages[i]) === summary.anchor) return i
  }
  return -1
}

export function summaryMatchesHistory(
  messages: Message[],
  summary: ConversationSummary,
): boolean {
  return anchorIndex(messages, summary) >= 0
}

export function buildConversationSummaryMessage(
  text: string,
  now = Date.now(),
): Message {
  return {
    role: 'user',
    tags: [CONVERSATION_SUMMARY_TAG],
    sentAt: now,
    content: [
      {
        type: 'text',
        text: `<conversation_summary>\n${SUMMARY_HEADER}\n\n<historical_memory>\n${text}\n</historical_memory>\n</conversation_summary>\n\n${SUMMARY_NOTE}`,
      },
    ],
  }
}

/**
 * The history with the summary in place of what it covers, and the summary
 * re-anchored on its own message (it now covers itself). Covered messages
 * that `keep` accepts (the current turn's own user messages) stay as real
 * messages right after it: a summary made at the limit, or during a turn,
 * covers the request it is answering, and that request must reach the model
 * word for word. Its size is unset until the provider reports the next
 * request's. Null when the summary no longer matches.
 */
export function applyConversationSummary(params: {
  messages: Message[]
  summary: ConversationSummary
  keep?: (message: Message) => boolean
  now?: number
}): { messages: Message[]; summary: ConversationSummary } | null {
  const index = anchorIndex(params.messages, params.summary)
  if (index < 0) return null
  const head = buildConversationSummaryMessage(params.summary.text, params.now)
  const { contextTokens: _, ...summary } = params.summary
  const kept = params.keep
    ? params.messages.slice(0, index + 1).filter(params.keep)
    : []
  return {
    messages: [head, ...kept, ...params.messages.slice(index + 1)],
    summary: {
      ...summary,
      coveredMessages: 1,
      anchor: messageFingerprint(head),
    },
  }
}

export type SummaryStream = (params: {
  messages: Message[]
  maxOutputTokens: number
  signal: AbortSignal
  extraCodebuffMetadata: Record<string, string>
  onFinishReason: (reason: string) => void
  onUsageReceived: (usage: ModelUsageData) => void
}) => ReturnType<PromptAiSdkStreamFn>

export class SummaryError extends Error {
  constructor(
    readonly kind: 'empty' | 'output_limit' | 'provider_error' | 'no_history',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Asks the model for the summary. `history` must be what the agent's next
 * request sends (`summaryRequestHistory`), or the cache misses.
 */
export async function generateConversationSummary(params: {
  summaryId?: string
  history: Message[]
  system: string
  /** The provider's count when the summary was requested, if known. */
  contextTokens?: number
  targetTokens: number
  maxOutputTokens?: number
  stream: SummaryStream
  signal: AbortSignal
  onUsage?: (usage: ModelUsageData) => void
}): Promise<{ summary: ConversationSummary; finishReason?: string }> {
  const { history } = params
  const summaryId = params.summaryId ?? crypto.randomUUID()
  const createdAt = Date.now()
  const anchor = history.findLastIndex((m) => !isEphemeral(m))
  if (anchor < 0)
    throw new SummaryError('no_history', 'No history to summarize')
  let finishReason: string | undefined
  const stream = params.stream({
    messages: [
      systemMessage(params.system),
      ...history,
      // Tagged so the server's prompt classifier skips it as product text.
      userMessage({
        content: withSystemInstructionTags(
          buildCompactionSummaryPrompt(params.targetTokens),
        ),
      }),
    ],
    maxOutputTokens:
      params.maxOutputTokens !== undefined && params.maxOutputTokens > 0
        ? Math.min(SUMMARY_MAX_OUTPUT_TOKENS, params.maxOutputTokens)
        : SUMMARY_MAX_OUTPUT_TOKENS,
    signal: params.signal,
    extraCodebuffMetadata: {
      [COMPACTION_SUMMARY_METADATA_KEY]: '1',
      compaction_summary_id: summaryId,
      compaction_request_id: summaryId,
      compaction_request_group: 'summary',
    },
    onFinishReason: (reason) => {
      finishReason = reason
    },
    onUsageReceived: (usage) => params.onUsage?.(usage),
  })
  let text = ''
  for (;;) {
    const next = await stream.next()
    if (next.done) {
      if (next.value.aborted) params.signal.throwIfAborted()
      break
    }
    const chunk = next.value
    if (chunk.type === 'error')
      throw new SummaryError('provider_error', chunk.message)
    if (chunk.type === 'text') text += chunk.text
  }
  params.signal.throwIfAborted()
  if (finishReason === 'length')
    throw new SummaryError('output_limit', 'The summary hit the output limit')
  const reply = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  // The summary starts at its first heading; a preamble before it is dropped.
  const start = reply.indexOf('## Objective')
  const summaryText = start < 0 ? '' : reply.slice(start).trim()
  if (summaryText.length < MIN_SUMMARY_CHARS)
    throw new SummaryError('empty', 'The model returned no summary')
  return {
    finishReason,
    summary: {
      id: summaryId,
      text: summaryText,
      coveredMessages: anchor + 1,
      anchor: messageFingerprint(history[anchor]),
      ...(params.contextTokens === undefined
        ? {}
        : { contextTokens: params.contextTokens }),
      createdAt,
    },
  }
}

type Entry = {
  latest?: ConversationSummary
  pending?: {
    promise: Promise<ConversationSummary | null>
    contextTokens: number
  }
}

const MAX_CONVERSATIONS = 200
const conversations = new Map<string, Entry>()

function entry(key: string): Entry {
  let value = conversations.get(key)
  if (value) {
    conversations.delete(key)
  } else {
    value = {}
  }
  conversations.set(key, value)
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value
    if (oldest === undefined) break
    conversations.delete(oldest)
  }
  return value
}

/** The newest of the stored summary and the one in `state`. */
function newer(
  a: ConversationSummary | undefined,
  b: ConversationSummary | undefined,
): ConversationSummary | undefined {
  if (!a) return b
  if (!b) return a
  return b.createdAt > a.createdAt ? b : a
}

/**
 * One conversation's summaries in this process: the newest finished one and
 * the one in progress. Keyed by conversation and agent, so a summary that
 * finishes after its run ended reaches the next turn.
 */
export function conversationSummaries(key: string) {
  return {
    /** The newest summary that still matches `messages`. */
    latest(
      fromState: ConversationSummary | undefined,
      messages: Message[],
    ): ConversationSummary | undefined {
      const summary = newer(fromState, entry(key).latest)
      return summary && summaryMatchesHistory(messages, summary)
        ? summary
        : undefined
    },
    pending() {
      return entry(key).pending
    },
    /** Records a summary the history now carries (after it was applied). */
    replace(summary: ConversationSummary | undefined) {
      entry(key).latest = summary
    },
    /** Starts a summary unless one is running. */
    start(
      contextTokens: number,
      run: () => Promise<ConversationSummary | null>,
    ): Promise<ConversationSummary | null> {
      const current = entry(key)
      if (current.pending) return current.pending.promise
      const promise = run()
        .then((summary) => {
          if (summary) {
            const target = entry(key)
            target.latest = newer(target.latest, summary)
          }
          return summary
        })
        .catch(() => null)
        .finally(() => {
          const target = conversations.get(key)
          if (target?.pending?.promise === promise) target.pending = undefined
        })
      current.pending = { promise, contextTokens }
      return promise
    },
  }
}

export function resetConversationSummariesForTest(): void {
  conversations.clear()
}

/** Runs `generateConversationSummary` and logs its outcome; never throws
 *  except on the caller's own abort. */
export async function summarizeAndLog(
  params: Parameters<typeof generateConversationSummary>[0] & {
    logger: Logger
    runId: string
    model: string
    mode: 'background' | 'foreground'
    /** Started while the agent's next request may be running. */
    midTurn: boolean
    /** The run's own signal: its abort is logged and rethrown. */
    cancelSignal?: AbortSignal
    telemetry?: Record<string, string>
  },
): Promise<ConversationSummary | null> {
  const {
    logger,
    runId,
    model,
    mode,
    midTurn,
    cancelSignal,
    telemetry,
    ...summaryParams
  } = params
  const started = Date.now()
  const summaryId = params.summaryId ?? crypto.randomUUID()
  let usage: ModelUsageData | undefined
  const log = (data: Record<string, unknown>, message: string) => {
    try {
      logger.info(
        {
          axiomEvent: COMPACTION_SUMMARY_EVENT,
          ...telemetry,
          summary_id: summaryId,
          agent_run_id: runId,
          model,
          mode,
          mid_turn: midTurn,
          context_token_count: params.contextTokens,
          duration_ms: Date.now() - started,
          ...(usage
            ? {
                input_tokens: usage.inputTokens,
                cached_input_tokens: usage.cachedInputTokens,
                output_tokens: usage.outputTokens,
              }
            : {}),
          ...data,
        },
        message,
      )
    } catch {
      // Logging must never fail a summary.
    }
  }
  try {
    const { summary, finishReason } = await generateConversationSummary({
      ...summaryParams,
      summaryId,
      onUsage: (received) => {
        usage = received
        summaryParams.onUsage?.(received)
      },
    })
    log(
      {
        outcome: 'completed',
        finish_reason: finishReason,
        summary_tokens: countTokens(summary.text),
      },
      'Conversation summary completed',
    )
    return summary
  } catch (error) {
    log(
      {
        outcome: cancelSignal?.aborted ? 'cancelled' : 'failed',
        error_kind:
          error instanceof SummaryError
            ? error.kind
            : isAbortError(error) || summaryParams.signal.aborted
              ? 'timeout'
              : 'provider_error',
        // Not allowlisted for Axiom; local/debug logs only.
        error: getErrorObject(error),
      },
      'Conversation summary failed',
    )
    if (cancelSignal?.aborted) throw error
    return null
  }
}

/** Waits for `promise`, or rejects when `signal` aborts first. */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * The reasoning settings for a summary request: the agent's own, at low
 * effort. On a high-effort model a summary at the limit thought for minutes
 * (a 150k-token summary took 304 s on DeepSeek V4.1 Flash) and one spent its
 * whole output budget on reasoning, leaving no summary. Anthropic models keep
 * their settings: changing thinking parameters there invalidates the cached
 * messages, the summary's whole saving.
 */
export function summaryReasoningOptions(
  model: string,
  reasoning: OpenRouterReasoningOptions | undefined,
): OpenRouterReasoningOptions | undefined {
  if (!reasoning || !('effort' in reasoning)) return reasoning
  if (model.startsWith('anthropic/')) return reasoning
  if (['none', 'minimal', 'low'].includes(reasoning.effort)) return reasoning
  return { ...reasoning, effort: 'low' }
}
