import { createHash } from 'node:crypto'

import { byokCompletionUrl } from '../byok'

import type { ResolvedByokConnection } from '../byok'

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

  return (body: Record<string, unknown>): Record<string, unknown> => {
    if (deepSeekReplay && Array.isArray(body.messages)) {
      body = { ...body, messages: backfillDeepSeekReasoning(body.messages) }
    }
    if (directLuna) {
      // Both fields were independently rejected by OpenAI in live probes.
      // The SDK still handles its agent stop markers locally.
      const { max_tokens, stop: _stop, ...rest } = body
      return {
        ...rest,
        max_completion_tokens: max_tokens,
        // Luna's Chat Completions API rejects function tools with its default
        // reasoning effort. Reasoning + tools requires the Responses API.
        ...(Array.isArray(body.tools) && body.tools.length > 0
          ? { reasoning_effort: 'none' }
          : {}),
      }
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
