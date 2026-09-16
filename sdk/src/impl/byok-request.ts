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

  return (body: Record<string, unknown>): Record<string, unknown> => {
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
