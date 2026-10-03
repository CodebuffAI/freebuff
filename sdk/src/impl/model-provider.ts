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
import { isAbortError, isFetchIdleTimeoutError, isTransientNetworkError } from '@codebuff/common/util/error'
import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@codebuff/llm-providers/openai-compatible'
import { APICallError } from 'ai'

import { byokReasoningRetryBody, byokRequestTransform } from './byok-request'
import { getWebsiteUrl } from '../constants'
import { getByokOpenrouterApiKeyFromEnv } from '../env'
import { byokCompletionUrl, byokCredentialVariable } from '../byok'
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
  /** Host-supplied headers per backend request; see CodebuffRequestHeadersProvider. */
  requestHeaders?: CodebuffRequestHeadersProvider
}

/**
 * Extra headers for one request to the Codebuff backend's completions
 * endpoint, computed as the request is about to go out. `body` is the exact
 * string the AI SDK serialized (what goes on the wire), so a host can sign it;
 * the provider is asked again for every retry. Never consulted for a BYOK run,
 * whose requests go to the user's own provider.
 *
 * Returning nothing (or throwing) adds no headers. Freebuff's catalog clients
 * use it for their catalog headers (docs/freebuff-model-catalog.md).
 */
export type CodebuffRequestHeadersProvider = (request: {
  method: string
  url: string
  body: string | Uint8Array | undefined
}) =>
  | Record<string, string>
  | undefined
  | Promise<Record<string, string> | undefined>

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

/** Retain recovery classification, never provider messages, URLs or raw causes. */
export function sanitizeByokTransportError(error: unknown): Error {
  if (isAbortError(error)) return new DOMException('BYOK request aborted', 'AbortError')
  const safe = new Error('BYOK provider stream failed')
  if (isFetchIdleTimeoutError(error)) {
    Object.assign(safe, { code: 'ETIMEDOUT' })
  } else if (isTransientNetworkError(error)) {
    Object.assign(safe, { code: 'ECONNRESET' })
  }
  return safe
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
      } catch (error) {
        controller.error(sanitizeByokTransportError(error))
      }
    },
    cancel() { return reader.cancel().catch(() => {}) },
  })
}

/**
 * Does this provider error body say the MODEL ID is wrong?
 *
 * A mistyped model is the most common BYOK 400/404, and the provider usually
 * says so plainly — DeepSeek answers `The supported API model names are
 * deepseek-flash, deepseek-v4-pro, but you passed deepseek/deepseek-v4-flash`,
 * OpenAI and Groq `The model \`x\` does not exist`, OpenRouter `x is not a
 * valid model ID`. Behind the fixed "request failed (HTTP 400). Check the
 * provider settings" line a user cannot tell that from a malformed request
 * (support email, 2026-09-23: a DeepSeek key that "always" failed on one model
 * id and worked on another). The body is only CLASSIFIED here; its text never
 * reaches the message, which is built from the connection's own model id.
 */
export function isByokModelIdRejection(body: string): boolean {
  if (!body) return false
  const text = body.slice(0, 16_384)
  return BYOK_MODEL_REJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

/** Each names the MODEL as what is wrong, so an unrelated 400 that merely
 *  mentions a model elsewhere in its body is not reclassified. */
const BYOK_MODEL_REJECTION_PATTERNS: readonly RegExp[] = [
  /"code"\s*:\s*"model_not_found"/i,
  // The model — optionally followed by ONE id token (bare, quoted or
  // `models/…`) — is itself the subject: "The model `x` does not exist",
  // "models/gemini-9 is not found", "Model not found". Anything between the id
  // and the verdict means something else is what failed: "model x: image
  // input is not supported" is a capability refusal on a valid id, and
  // calling it a bad id would send the user to fix the wrong thing.
  /\bmodels?\b\s*[:=]?\s*(?:`[^`\n]{1,120}`|'[^'\n]{1,120}'|\\?"[^"\n]{1,120}?\\?"|[\w./:@+-]{1,120})?\s+(?:is\s+|was\s+)?(?:does not exist|not exist|not found|not supported)\b/i,
  /\b(?:invalid|unknown|no such|not a valid|unable to access) model\b/i,
  /\bsupported (?:api )?model(?: name)?s? (?:are|is)\b/i,
]

const MAX_MODEL_ID_IN_MESSAGE = 120

/** A fixed, actionable message for a provider status. Never include upstream
 * response text: gateways commonly echo credential fragments in error bodies.
 * `modelRejected` is a classification of that text (isByokModelIdRejection),
 * and `model` is the connection's own configured id — both ours to show. */
export function getByokProviderErrorMessage(
  status: number,
  detail: {
    model?: string
    modelRejected?: boolean
    /** The environment variable the key came from, a NAME and never a value. */
    credentialVariable?: string
  } = {},
): string {
  if (
    detail.modelRejected &&
    (status === 400 || status === 404 || status === 422)
  ) {
    const model = (detail.model ?? '').slice(0, MAX_MODEL_ID_IN_MESSAGE)
    const named = model ? ` "${model}"` : ''
    return `BYOK provider does not recognise the model ID${named} (HTTP ${status}). Use the exact model name from the provider's API model list and retry.`
  }
  if (status === 401)
    return detail.credentialVariable
      ? `BYOK provider rejected the API key in ${detail.credentialVariable} (HTTP 401). ${detail.credentialVariable} is set in this Freebuff process; check that it holds the key this endpoint expects, then restart Freebuff from that terminal.`
      : 'BYOK provider rejected the API key (HTTP 401). Check or replace the key.'
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

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...(headers as Record<string, string>) }
}

/** `send`, with the host's extra headers merged in per request. */
export function withCodebuffRequestHeaders(
  provider: CodebuffRequestHeadersProvider,
  send: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>,
): (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch> {
  return async (input, init) => {
    const raw = init?.body
    // Only a body whose exact bytes can be handed over; anything else (a
    // stream) goes out without extra headers rather than with wrong ones.
    if (raw != null && typeof raw !== 'string' && !(raw instanceof Uint8Array))
      return send(input, init)
    let extra: Record<string, string> | undefined
    try {
      extra = await provider({
        method: (init?.method ?? 'GET').toUpperCase(),
        url: requestUrlOf(input),
        body: raw ?? undefined,
      })
    } catch {
      extra = undefined
    }
    if (!extra || Object.keys(extra).length === 0) return send(input, init)
    return send(input, {
      ...init,
      headers: { ...plainHeaders(init?.headers), ...extra },
    })
  }
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
  requestHeaders,
}: ModelRequestParams): LanguageModel {
  if (byok) {
    return new OpenAICompatibleChatLanguageModel(byok.model, {
      provider: 'byok',
      transformRequestBody: byokRequestTransform(byok),
      url: () => byokCompletionUrl(byok),
      headers: () => ({
        Authorization: `Bearer ${byok.apiKey}`,
        'user-agent': `ai-sdk/openai-compatible/${VERSION}/freebuff-byok`,
      }),
      // Check the durable revision before every provider attempt. The AI SDK
      // invokes this again on retries and later tool-loop steps, so removing
      // or replacing a connection stops subsequent inference immediately.
      fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
        // Revocation is a durable policy decision, never a transport retry.
        try {
          await byok.assertCurrent?.()
        } catch {
          throw new Error(BYOK_CONNECTION_FAILURE_MESSAGE)
        }
        try {
          const send = (init: RequestInit | undefined) =>
            globalThis.fetch(args[0], { ...(init ?? {}), redirect: 'error' })
          let response = await send(args[1])
          let errorText: string | undefined
          if (response.status === 400 || response.status === 422) {
            errorText = await response.text().catch(() => '')
            // A provider or model that refuses the picked reasoning effort
            // still answers the task: once, without the field, remembered
            // for the connection so later steps do not ask again.
            const retryBody = byokReasoningRetryBody(
              byok,
              args[1]?.body,
              response.status,
              errorText,
            )
            if (retryBody !== undefined) {
              response = await send({ ...(args[1] ?? {}), body: retryBody })
              errorText = undefined
            }
          }
          if (!response.ok) {
            const modelRejected =
              response.status === 400 ||
              response.status === 404 ||
              response.status === 422
                ? isByokModelIdRejection(
                    errorText ?? (await response.text().catch(() => '')),
                  )
                : false
            const headers = new Headers({ 'content-type': 'application/json' })
            // Keep scheduling hints, but never copy arbitrary provider headers.
            for (const name of ['retry-after', 'retry-after-ms']) {
              const value = response.headers.get(name)
              if (value && /^\d+(?:\.\d+)?$/.test(value)) headers.set(name, value)
            }
            return new Response(
              JSON.stringify({
                error: {
                  message: getByokProviderErrorMessage(response.status, {
                    model: byok.model,
                    modelRejected,
                    credentialVariable: byokCredentialVariable(byok),
                  }),
                },
              }),
              { status: response.status, headers },
            )
          }
          return new Response(redactProviderStream(response.body, byok.apiKey), {
            status: response.status,
            headers: {
              'content-type': response.headers.get('content-type') ?? 'text/event-stream',
            },
          })
        } catch (error) {
          const safe = sanitizeByokTransportError(error)
          if (args[1]?.signal?.aborted || isAbortError(safe)) {
            throw new DOMException('BYOK request aborted', 'AbortError')
          }
          throw new APICallError({
            message: BYOK_CONNECTION_FAILURE_MESSAGE,
            url: 'byok-provider',
            requestBodyValues: {},
            cause: safe,
            isRetryable: isTransientNetworkError(safe),
          })
        }
      }) as typeof globalThis.fetch,
      includeUsage: true,
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
    fetch: (requestHeaders
      ? withCodebuffRequestHeaders(
          requestHeaders,
          fetchWithRetryableNetworkErrors,
        )
      : fetchWithRetryableNetworkErrors) as typeof globalThis.fetch,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}
