import { createHash } from 'node:crypto'

import { byokCompletionUrl } from '../byok'

import type { ResolvedByokConnection } from '../byok'
import type { ByokReasoningEffort } from '@codebuff/common/constants/reasoning-effort'

/**
 * Which request field a connection's endpoint reads reasoning effort from.
 * BYOK always speaks Chat Completions (`byokCompletionUrl`), so the Responses
 * API's `reasoning.effort` never applies; what differs is the dialect:
 *
 * - `openrouter` — OpenRouter's normalized `reasoning: { effort }`.
 * - `anthropic` — Anthropic's OpenAI-compatible endpoint takes the native
 *   `thinking: { type: 'enabled', budget_tokens }`, not an effort word.
 * - `openai` — everything else: OpenAI, Gemini's OpenAI-compatible endpoint
 *   (which maps `reasoning_effort` onto its thinking budget), DeepSeek, xAI,
 *   and local servers. A server that ignores the field is unaffected, and one
 *   that rejects it is retried without it (`byokReasoningRetryBody`).
 */
export type ByokReasoningDialect = 'openrouter' | 'anthropic' | 'openai'

export function byokReasoningDialect(
  connection: Pick<ResolvedByokConnection, 'provider' | 'baseUrl'>,
): ByokReasoningDialect {
  const endpoint = byokCompletionUrl(connection)
  if (endpoint.startsWith('https://openrouter.ai/')) return 'openrouter'
  if (new URL(endpoint).hostname === 'api.anthropic.com') return 'anthropic'
  return 'openai'
}

/**
 * Anthropic's thinking budget per rung. The API minimum is 1,024. The budget is
 * ADDED to `max_tokens` rather than carved out of it: Anthropic counts thinking
 * against `max_tokens`, and a 4,096-token default output cap would otherwise
 * leave the answer almost nothing.
 */
export const BYOK_ANTHROPIC_THINKING_BUDGETS: Record<
  ByokReasoningEffort,
  number
> = { low: 2_048, medium: 8_192, high: 16_384 }

/** Fallback answer room when a request somehow carries no output cap. */
const ANTHROPIC_ANSWER_TOKENS = 4_096

function applyReasoningEffort(
  body: Record<string, unknown>,
  dialect: ByokReasoningDialect,
  effort: ByokReasoningEffort,
): Record<string, unknown> {
  if (dialect === 'openrouter') return { ...body, reasoning: { effort } }
  if (dialect === 'anthropic') {
    const budget = BYOK_ANTHROPIC_THINKING_BUDGETS[effort]
    const answer =
      typeof body.max_tokens === 'number'
        ? body.max_tokens
        : ANTHROPIC_ANSWER_TOKENS
    return {
      ...body,
      max_tokens: answer + budget,
      thinking: { type: 'enabled', budget_tokens: budget },
    }
  }
  return { ...body, reasoning_effort: effort }
}

/**
 * Reasoning-effort rejections, per connection revision, for this process. A
 * provider or model that 400s on the field once is not asked with it again;
 * editing the connection (a new revision, perhaps a new model) asks afresh.
 */
const reasoningRejected = new Set<string>()
const rejectionKey = (connection: Pick<ResolvedByokConnection, 'id' | 'revision'>) =>
  `${connection.id}:${connection.revision}`

export function clearByokReasoningRejections(): void {
  reasoningRejected.clear()
  replayRejected.clear()
}

/** Error text that names the field we added, not merely any 400. */
const REASONING_FIELD_PATTERNS: Record<ByokReasoningDialect, RegExp> = {
  openrouter: /\breasoning\b|\beffort\b/i,
  // Raising max_tokens for the budget can itself exceed a model's output cap.
  anthropic: /\bthinking\b|budget_tokens|max_tokens/i,
  // Not "thinking": DeepSeek's replay error says "thinking mode" about
  // reasoning_content, which dropping the effort field would not fix.
  openai: /reasoning_effort|\breasoning\b|\beffort\b/i,
}

/**
 * When a 400/422 answered a request that carried the reasoning field this
 * module added, and the error names that field, the same request body without
 * it — else undefined. The rejection is remembered for the connection, so the
 * retry and every later request skip the field. Parses the serialized body the
 * AI SDK sent; anything unexpected there means "no retry", never a throw.
 */
export function byokReasoningRetryBody(
  connection: ResolvedByokConnection,
  requestBody: unknown,
  status: number,
  errorText: string,
): string | undefined {
  const effort = connection.reasoningEffort
  if (!effort || (status !== 400 && status !== 422)) return undefined
  if (typeof requestBody !== 'string') return undefined
  const dialect = byokReasoningDialect(connection)
  if (!REASONING_FIELD_PATTERNS[dialect].test(errorText.slice(0, 16_384)))
    return undefined
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(requestBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return undefined
    body = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const stripped = stripReasoningEffort(body, dialect, effort)
  if (!stripped) return undefined
  reasoningRejected.add(rejectionKey(connection))
  return JSON.stringify(stripped)
}

/**
 * The chat converter replays a step's reasoning on its assistant message as
 * `reasoning_content` (or OpenRouter's `reasoning_details`). DeepSeek requires
 * that, but a strict schema refuses the whole request over it: Groq answers
 * "property 'reasoning_content' is unsupported" on the first follow-up after a
 * reasoning model's step. Groq is known, so it never gets the fields; any other
 * endpoint that refuses them by name is retried once without them, and the
 * connection stops sending them (`byokReasoningReplayRetryBody`).
 */
const replayRejected = new Set<string>()

const REPLAY_FIELD = /\breasoning_(?:content|details)\b/
/** Words of a schema refusal, not DeepSeek's "must be passed back". */
const REPLAY_REFUSAL =
  /unsupported|unexpected|not (?:allowed|permitted|supported)|unrecogni[sz]ed|unknown/i

function refusesReasoningReplay(endpoint: string): boolean {
  return new URL(endpoint).hostname === 'api.groq.com'
}

/** The messages without replayed reasoning; the same array when none had any. */
function stripReasoningReplay(messages: unknown[]): unknown[] {
  let changed = false
  const stripped = messages.map((raw) => {
    const m = raw as Record<string, unknown> | null
    if (
      m?.role !== 'assistant' ||
      !('reasoning_content' in m || 'reasoning_details' in m)
    ) {
      return raw
    }
    changed = true
    const {
      reasoning_content: _content,
      reasoning_details: _details,
      ...rest
    } = m
    return rest
  })
  return changed ? stripped : messages
}

/**
 * When a 400/422 names a replayed reasoning field as unsupported, the same
 * request body without it — else undefined. Like `byokReasoningRetryBody`, the
 * refusal is remembered for the connection revision.
 */
export function byokReasoningReplayRetryBody(
  connection: ResolvedByokConnection,
  requestBody: unknown,
  status: number,
  errorText: string,
): string | undefined {
  if (status !== 400 && status !== 422) return undefined
  if (typeof requestBody !== 'string') return undefined
  const text = errorText.slice(0, 16_384)
  if (!REPLAY_FIELD.test(text) || !REPLAY_REFUSAL.test(text)) return undefined
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(requestBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return undefined
    body = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!Array.isArray(body.messages)) return undefined
  const messages = stripReasoningReplay(body.messages)
  if (messages === body.messages) return undefined
  replayRejected.add(rejectionKey(connection))
  return JSON.stringify({ ...body, messages })
}

/** Undo `applyReasoningEffort`, or undefined when the body does not carry
 *  exactly what it would have added (e.g. direct Luna's own `'none'`). */
function stripReasoningEffort(
  body: Record<string, unknown>,
  dialect: ByokReasoningDialect,
  effort: ByokReasoningEffort,
): Record<string, unknown> | undefined {
  if (dialect === 'openrouter') {
    const reasoning = body.reasoning as { effort?: unknown } | undefined
    if (reasoning?.effort !== effort) return undefined
    const { reasoning: _reasoning, ...rest } = body
    return rest
  }
  if (dialect === 'anthropic') {
    const thinking = body.thinking as { budget_tokens?: unknown } | undefined
    const budget = BYOK_ANTHROPIC_THINKING_BUDGETS[effort]
    if (thinking?.budget_tokens !== budget) return undefined
    const { thinking: _thinking, ...rest } = body
    return typeof rest.max_tokens === 'number'
      ? { ...rest, max_tokens: rest.max_tokens - budget }
      : rest
  }
  if (body.reasoning_effort !== effort) return undefined
  const { reasoning_effort: _effort, ...rest } = body
  return rest
}

/** Select by the actual endpoint, including connections saved as "custom". */
export function byokRequestTransform(connection: ResolvedByokConnection) {
  const endpoint = byokCompletionUrl(connection)
  const directLuna =
    endpoint === 'https://api.openai.com/v1/chat/completions' &&
    connection.model === 'gpt-5.6-luna'
  const openRouterOpenAI =
    endpoint === 'https://openrouter.ai/api/v1/chat/completions' &&
    connection.model.startsWith('openai/')

  // Standalone BYOK has no required Freebuff account. Attribute to the provider
  // credential, not a connection UUID/revision that changes on re-creation.
  // Domain separation keeps this fingerprint specific to this purpose; the key
  // itself must never enter the request body or its diagnostic metadata.
  const identifier = openRouterOpenAI
    ? createHash('sha256')
        .update('freebuff-byok:openrouter:user:')
        .update(connection.apiKey)
        .digest('hex')
    : undefined

  // DeepSeek's own API (and servers that proxy it) validate the thinking-mode
  // tool loop: every assistant message with tool_calls after the LAST user
  // message must carry a `reasoning_content` key, or the whole request 400s
  // ("The `reasoning_content` in the thinking mode must be passed back to the
  // API"). The hosted lane backfills it server-side
  // (web/src/llm-api/deepseek-request-body.ts); a BYOK request never passes
  // through there, so it failed on the first follow-up after a tool call.
  // An empty string is accepted, and the key is harmless with thinking off.
  const deepSeekReplay =
    !endpoint.startsWith('https://openrouter.ai/') &&
    (/deepseek/i.test(connection.model) ||
      endpoint.startsWith('https://api.deepseek.com'))

  const reasoningDialect = connection.reasoningEffort
    ? byokReasoningDialect(connection)
    : undefined

  const replayRefused = refusesReasoningReplay(endpoint)

  return (body: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(body.messages)) {
      if (replayRefused || replayRejected.has(rejectionKey(connection))) {
        body = { ...body, messages: stripReasoningReplay(body.messages) }
      } else if (deepSeekReplay) {
        body = { ...body, messages: backfillDeepSeekReasoning(body.messages) }
      }
    }
    // Checked per request, not per transform: a rejection learned mid-run
    // applies to the run's next step too.
    const effort =
      reasoningDialect && !reasoningRejected.has(rejectionKey(connection))
        ? connection.reasoningEffort
        : undefined
    if (directLuna) {
      // Both fields were independently rejected by OpenAI in live probes.
      // The SDK still handles its agent stop markers locally.
      const { max_tokens, stop: _stop, ...rest } = body
      return {
        ...rest,
        max_completion_tokens: max_tokens,
        // Luna's Chat Completions API rejects function tools with its default
        // reasoning effort. Reasoning + tools requires the Responses API, so
        // a picked effort applies only to tool-free requests.
        ...(Array.isArray(body.tools) && body.tools.length > 0
          ? { reasoning_effort: 'none' }
          : effort
            ? { reasoning_effort: effort }
            : {}),
      }
    }
    if (effort && reasoningDialect) {
      body = applyReasoningEffort(body, reasoningDialect, effort)
    }
    if (identifier) {
      // Anonymous OpenAI traffic through OpenRouter can inherit a shared policy
      // block. Match the hosted lane's two attribution fields, on every call.
      return { ...body, user: identifier, safety_identifier: identifier }
    }
    return body
  }
}

type WireMessage = {
  role?: unknown
  tool_calls?: unknown
  reasoning_content?: unknown
}

/** `reasoning_content: ''` on each assistant tool-call message after the last
 *  user message that lacks one. Never overwrites reasoning that is present. */
export function backfillDeepSeekReasoning(messages: unknown[]): unknown[] {
  const lastUser = messages.findLastIndex(
    (m) => (m as WireMessage | null)?.role === 'user',
  )
  return messages.map((raw, index) => {
    const m = raw as WireMessage | null
    if (
      index > lastUser &&
      m?.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0 &&
      typeof m.reasoning_content !== 'string'
    ) {
      return { ...m, reasoning_content: '' }
    }
    return raw
  })
}
