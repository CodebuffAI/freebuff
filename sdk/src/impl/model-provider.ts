/**
 * Builds the language model every request runs on: the Codebuff backend,
 * which forwards to OpenRouter.
 */

import path from 'path'

import { BYOK_OPENROUTER_HEADER } from '@codebuff/common/constants/byok'
import {
  FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE,
  FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
} from '@codebuff/common/constants/freebuff-errors'
import { FREEBUFF_ACTING_USER_HEADER } from '@codebuff/common/constants/freebuff-models'
import { isTransientNetworkError } from '@codebuff/common/util/error'
import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@codebuff/llm-providers/openai-compatible'
import { APICallError } from 'ai'

import { getWebsiteUrl } from '../constants'
import { getByokOpenrouterApiKeyFromEnv } from '../env'
import { byokCompletionUrl } from '../byok'
import type { ResolvedByokConnection } from '../byok'

import type { LanguageModel } from 'ai'

/**
 * Parameters for requesting a model.
 */
export interface ModelRequestParams {
  /** Codebuff API key for backend authentication */
  apiKey: string
  /** Model ID (OpenRouter format, e.g., "anthropic/claude-sonnet-4") */
  model: string
  /** End user represented by a trusted service-account request. */
  userId?: string
  /** Direct, run-scoped credential. Never stored on the model or in metadata. */
  byok?: ResolvedByokConnection
}

// Usage accounting type for OpenRouter/Codebuff backend responses
type OpenRouterUsageAccounting = {
  cost: number | null
  costDetails: {
    upstreamInferenceCost: number | null
  }
}

/**
 * Notification hook for free-mode capacity deferrals. When the backend sheds
 * a free-mode completion under saturation (HTTP 429 with
 * `error: 'free_mode_capacity_deferred'` — see the server's
 * free-mode-priority.ts), the AI SDK's retry loop absorbs the wait silently.
 * Hosts (the CLI) can register here to surface a "high demand" indicator
 * instead of an unexplained pause.
 */
export type FreeModeCapacityDeferral = { retryAfterSeconds: number }

let freeModeCapacityDeferralListener:
  | ((deferral: FreeModeCapacityDeferral) => void)
  | null = null

export function setFreeModeCapacityDeferralListener(
  listener: ((deferral: FreeModeCapacityDeferral) => void) | null,
): void {
  freeModeCapacityDeferralListener = listener
}

function notifyCapacityDeferralFromResponse(response: Response): void {
  if (response.status !== 429 || !freeModeCapacityDeferralListener) return
  // Clone so the AI SDK still reads the original body for its own error
  // handling/retry. Both the parse and the listener are best-effort: a
  // malformed body or throwing listener must never break the request path.
  void response
    .clone()
    .json()
    .then((body: unknown) => {
      const error =
        body && typeof body === 'object' ? (body as any).error : undefined
      if (error !== 'free_mode_capacity_deferred') return
      const retryAfterHeader = Number(response.headers.get('retry-after'))
      freeModeCapacityDeferralListener?.({
        retryAfterSeconds:
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? retryAfterHeader
            : 10,
      })
    })
    .catch(() => {})
}

function requestUrlOf(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
}

/** Preserve streaming while removing a credential even when it crosses chunks. */
export function redactProviderStream(
  body: ReadableStream<Uint8Array> | null,
  secret: string,
): ReadableStream<Uint8Array> | null {
  if (!body || !secret) return body
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  const retain = Math.max(0, secret.length - 1)
  const redact = (text: string) => text.split(secret).join('[redacted]')
  const transformed = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let boundary = Math.max(0, pending.length - retain)
      // Do not emit the prefix of a complete secret just because its suffix
      // happens to be in the retained tail. Extend the safe boundary through
      // every complete match that starts before it, then redact as one unit.
      for (let start = pending.indexOf(secret); start !== -1; start = pending.indexOf(secret, start + secret.length)) {
        if (start >= boundary) break
        boundary = Math.max(boundary, start + secret.length)
      }
      controller.enqueue(encoder.encode(redact(pending.slice(0, boundary))))
      pending = pending.slice(boundary)
    },
    flush(controller) {
      pending += decoder.decode()
      controller.enqueue(encoder.encode(redact(pending)))
    },
  }))
  const reader = transformed.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch {
        controller.error(new Error('BYOK provider stream failed'))
      }
    },
    cancel() { return reader.cancel().catch(() => {}) },
  })
}

/** A fixed, actionable message for a provider status. Never include upstream
 * response text: gateways commonly echo credential fragments in error bodies. */
export function getByokProviderErrorMessage(status: number): string {
  if (status === 401)
    return 'BYOK provider rejected the API key (HTTP 401). Check or replace the key.'
  if (status === 403)
    return 'BYOK API key cannot access this model or account (HTTP 403). Choose an allowed model or use another key.'
  if (status === 402)
    return 'BYOK provider account needs credits or a supported plan (HTTP 402). Add provider credit or choose another model.'
  if (status === 404)
    return 'BYOK provider could not find this model or endpoint (HTTP 404). Check the model ID and provider URL.'
  if (status === 429)
    return 'BYOK provider rate limit reached (HTTP 429). Wait, then retry the task.'
  if (status >= 500)
    return `BYOK provider is temporarily unavailable (HTTP ${status}). Retry the task later.`
  return `BYOK provider request failed (HTTP ${status}). Check the provider settings and retry.`
}

export const BYOK_CONNECTION_FAILURE_MESSAGE =
  'Could not connect to the BYOK provider. Check the provider URL and network connection, then retry.'

/**
 * The per-turn spend breaker (HTTP 429, body `{ error: 'turn_spend_limit',
 * message }`) is final for THIS turn: its spend only grows, so the same run
 * id is refused again on every retry. Left to the AI SDK, which treats every
 * 429 as retryable, a capped turn asked four times over ~14s and then failed
 * as "Failed after 4 attempts. Last error: Too Many Requests" — which every
 * client read as an ordinary rate limit and answered with "wait a moment or
 * switch models", neither of which helps. Throwing a NON-retryable
 * APICallError stops the retry loop on the first refusal, and carrying the
 * body lets the runtime's error parser hand the server's own copy (and the
 * `turn_spend_limit` code) to the client unchanged.
 */
async function throwIfTurnSpendCapped(
  response: Response,
  url: string,
): Promise<void> {
  if (response.status !== 429) return
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  let body: { error?: unknown; message?: unknown } | null = null
  try {
    body = JSON.parse(text)
  } catch {
    return
  }
  if (body?.error !== FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE) return
  throw new APICallError({
    message:
      typeof body.message === 'string' && body.message
        ? body.message
        : FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
    url,
    requestBodyValues: {},
    statusCode: response.status,
    responseBody: text,
    isRetryable: false,
  })
}

/**
 * Wrap global fetch so transient connection failures (socket closed/reset,
 * connection refused) are rethrown as retryable APICallErrors, and a capped
 * turn's 429 as a non-retryable one (see throwIfTurnSpendCapped).
 *
 * Bun's fetch throws these as plain Errors ("The socket connection was closed
 * unexpectedly...", code ECONNRESET/ConnectionClosed), which the AI SDK does
 * not recognize as retryable — it only auto-retries APICallError with
 * isRetryable=true. Marking them retryable lets streamText's built-in
 * exponential backoff (default 2 retries) absorb brief server/network blips
 * instead of failing the whole agent run.
 */
function fetchWithRetryableNetworkErrors(
  ...args: Parameters<typeof globalThis.fetch>
): ReturnType<typeof globalThis.fetch> {
  const url = requestUrlOf(args[0])
  return globalThis.fetch(...args).then(
    async (response) => {
      notifyCapacityDeferralFromResponse(response)
      await throwIfTurnSpendCapped(response, url)
      return response
    },
    (error: unknown) => {
      if (isTransientNetworkError(error)) {
        throw new APICallError({
          message: error instanceof Error ? error.message : String(error),
          cause: error,
          url,
          requestBodyValues: {},
          isRetryable: true,
        })
      }
      throw error
    },
  )
}

/**
 * Get the model for a request: one that routes through the Codebuff backend,
 * which forwards to OpenRouter.
 */
export function getModelForRequest({
  apiKey,
  model,
  userId,
  byok,
}: ModelRequestParams): LanguageModel {
  if (byok) {
    return new OpenAICompatibleChatLanguageModel(byok.model, {
      provider: 'byok',
      url: () => byokCompletionUrl(byok),
      headers: () => ({
        Authorization: `Bearer ${byok.apiKey}`,
        'user-agent': `ai-sdk/openai-compatible/${VERSION}/freebuff-byok`,
      }),
      // Check the durable revision before every provider attempt. The AI SDK
      // invokes this again on retries and later tool-loop steps, so removing
      // or replacing a connection stops subsequent inference immediately.
      fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
        try {
          await byok.assertCurrent?.()
          const response = await globalThis.fetch(
            args[0],
            { ...(args[1] ?? {}), redirect: 'error' },
          )
          if (!response.ok) {
            return new Response(
              JSON.stringify({ error: { message: getByokProviderErrorMessage(response.status) } }),
              { status: response.status, headers: { 'content-type': 'application/json' } },
            )
          }
          return new Response(redactProviderStream(response.body, byok.apiKey), {
            status: response.status,
            headers: {
              'content-type': response.headers.get('content-type') ?? 'text/event-stream',
            },
          })
        } catch {
          throw new Error(BYOK_CONNECTION_FAILURE_MESSAGE)
        }
      }) as typeof globalThis.fetch,
      includeUsage: undefined,
      supportsStructuredOutputs: true,
    })
  }
  const openrouterUsage: OpenRouterUsageAccounting = {
    cost: null,
    costDetails: {
      upstreamInferenceCost: null,
    },
  }

  const openrouterApiKey = getByokOpenrouterApiKeyFromEnv()

  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'codebuff',
    url: ({ path: endpoint }) =>
      new URL(path.join('/api/v1', endpoint), getWebsiteUrl()).toString(),
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff`,
      ...(userId ? { [FREEBUFF_ACTING_USER_HEADER]: userId } : {}),
      ...(openrouterApiKey && { [BYOK_OPENROUTER_HEADER]: openrouterApiKey }),
    }),
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }: { parsedBody: any }) => {
        if (openrouterApiKey !== undefined) {
          return { codebuff: { usage: openrouterUsage } }
        }

        if (typeof parsedBody?.usage?.cost === 'number') {
          openrouterUsage.cost = parsedBody.usage.cost
        }
        if (
          typeof parsedBody?.usage?.cost_details?.upstream_inference_cost ===
          'number'
        ) {
          openrouterUsage.costDetails.upstreamInferenceCost =
            parsedBody.usage.cost_details.upstream_inference_cost
        }
        return { codebuff: { usage: openrouterUsage } }
      },
      createStreamExtractor: () => ({
        processChunk: (parsedChunk: any) => {
          if (openrouterApiKey !== undefined) {
            return
          }

          if (typeof parsedChunk?.usage?.cost === 'number') {
            openrouterUsage.cost = parsedChunk.usage.cost
          }
          if (
            typeof parsedChunk?.usage?.cost_details?.upstream_inference_cost ===
            'number'
          ) {
            openrouterUsage.costDetails.upstreamInferenceCost =
              parsedChunk.usage.cost_details.upstream_inference_cost
          }
        },
        buildMetadata: () => {
          return { codebuff: { usage: openrouterUsage } }
        },
      }),
    },
    // Cast: Bun's fetch type also declares a `preconnect` helper, but the AI
    // SDK only ever invokes fetch as a plain function.
    fetch: fetchWithRetryableNetworkErrors as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}
