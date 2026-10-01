/**
 * Mid-stream provider errors (CodebuffAI/freebuff#1155).
 *
 * A retryable failure the provider reports in band (an `error` chunk after the
 * SSE headers) takes the same capped continuation path as a severed body,
 * instead of ending the run. Every shape below is a real one: the bytes our
 * server writes (web/src/app/api/v1/chat/completions/grace-flush.ts,
 * web/src/llm-api/openai-responses.ts) or OpenRouter passes through, read by
 * the vendored provider that model-provider.ts actually builds.
 */
import { OpenAICompatibleChatLanguageModel } from '@codebuff/llm-providers/openai-compatible'
import { APICallError, RetryError, streamText } from 'ai'
import { afterEach, describe, expect, it } from 'bun:test'

import { promptAiSdkStream } from '../llm'
import {
  classifyProviderErrorRecovery,
  PROVIDER_ERROR_DEFAULT_DELAY_MS,
  PROVIDER_ERROR_MAX_RETRY_DELAY_MS,
  PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS,
} from '../stream-interruption'

import type { StreamChunk } from '@codebuff/common/types/contracts/llm'

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

const textChunk = (text: string) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
})

/** grace-flush.ts `lateFailureChunk`: status in the text, nowhere else. */
const lateFailure = (message: string, extra: Record<string, unknown> = {}) => ({
  error: { message, ...extra, type: 'upstream_error' },
})

/** OpenRouter's mid-stream failure: numeric `code`, detail in metadata. */
const openRouterError = (code: number, message: string, raw?: string) => ({
  id: 'gen-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  provider: 'Space Bunny',
  choices: [],
  error: {
    code,
    message,
    ...(raw && { metadata: { raw, provider_name: 'Space Bunny' } }),
  },
})

/** openai-responses.ts in-band failure: the Responses event's string code. */
const responsesError = (message: string, code: string | null) => ({
  id: 'resp_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [],
  error: { message, code },
})

const sseResponse = (body: string) =>
  new Response(`: connecting\n\n${body}data: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  })

/** The error part the real provider + streamText stack yields for `event`. */
const errorPartFor = async (event: unknown): Promise<unknown> => {
  const result = streamText({
    model: new OpenAICompatibleChatLanguageModel('m', {
      provider: 'codebuff',
      url: () => 'http://127.0.0.1/chat/completions',
      headers: () => ({}),
      fetch: (async () => sseResponse(sse(event))) as unknown as typeof fetch,
    }),
    messages: [{ role: 'user', content: 'hi' }],
    maxRetries: 0,
  })
  let error: unknown
  for await (const part of result.stream) {
    if (part.type === 'error') error ??= (part as { error: unknown }).error
  }
  await Promise.resolve(result.text).catch(() => {})
  return error
}

describe('classifyProviderErrorRecovery on real wire shapes', () => {
  it.each([
    [
      'server late failure 502',
      lateFailure('Upstream provider error (502): Bad gateway'),
      502,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'server late failure 500',
      lateFailure('Upstream provider error (500): Internal Server Error'),
      500,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'server late failure 503',
      lateFailure('Upstream provider error (503): overloaded'),
      503,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'server late failure 429',
      lateFailure('Upstream provider error (429): Model is at capacity.'),
      429,
      PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS,
    ],
    [
      'server late failure with a string code',
      lateFailure('Upstream provider error (504): timed out', {
        code: 'ETIMEDOUT',
      }),
      504,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'server late failure without a status',
      lateFailure('Upstream provider error: the provider gave no reason'),
      undefined,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'OpenRouter mid-stream 502',
      openRouterError(502, 'Provider returned error', 'upstream timed out'),
      502,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'OpenRouter mid-stream 429',
      openRouterError(429, 'Rate limit exceeded'),
      429,
      PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS,
    ],
    [
      'Responses server_error',
      responsesError(
        'The server had an error while processing your request.',
        'server_error',
      ),
      undefined,
      PROVIDER_ERROR_DEFAULT_DELAY_MS,
    ],
    [
      'Responses rate_limit_exceeded',
      responsesError('Rate limit reached.', 'rate_limit_exceeded'),
      undefined,
      PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS,
    ],
  ] as const)('retries %s', async (_label, event, statusCode, delayMs) => {
    const error = await errorPartFor(event)
    expect(APICallError.isInstance(error)).toBe(true)
    const recovery = classifyProviderErrorRecovery({ aborted: false, error })
    expect(recovery).not.toBeNull()
    expect(recovery!.source).toBe('provider-error')
    expect(recovery!.statusCode).toBe(statusCode)
    expect(recovery!.delayMs).toBe(delayMs)
    // The provider's words reach both the model's note and the give-up error.
    expect(recovery!.detail).toBe((error as APICallError).message)
    expect(recovery!.message).toContain(recovery!.detail!)
    // A cancel is never a retry.
    expect(classifyProviderErrorRecovery({ aborted: true, error })).toBeNull()
  })

  it.each([
    [
      'context too long (400)',
      lateFailure(
        'Upstream provider error (400): maximum context length exceeded',
      ),
    ],
    [
      'bad key (401)',
      lateFailure('Upstream provider error (401): Unauthorized'),
    ],
    [
      'out of credits (402)',
      lateFailure('Upstream provider error (402): Insufficient balance'),
    ],
    [
      'forbidden (403)',
      lateFailure('Upstream provider error (403): Forbidden'),
    ],
    [
      'session conflict (409)',
      lateFailure('Upstream provider error (409): session superseded'),
    ],
    [
      'session required (428)',
      lateFailure('Upstream provider error (428): start a session first'),
    ],
    [
      'OpenRouter moderation (403)',
      openRouterError(403, 'Input flagged for moderation', 'violence'),
    ],
    [
      'OpenRouter bad request (400)',
      openRouterError(400, 'Provider returned error', 'prompt is too long'),
    ],
    [
      'OpenRouter policy block (403)',
      openRouterError(403, 'Request refused under the provider usage policy'),
    ],
    [
      'Responses invalid prompt',
      responsesError('Invalid prompt: flagged.', 'invalid_prompt'),
    ],
    [
      'Responses refusal without a code',
      responsesError('Responses API error', null),
    ],
    [
      'a bare message with no type or status',
      { error: { message: 'stream aborted' } },
    ],
  ] as const)('keeps %s fatal', async (_label, event) => {
    const error = await errorPartFor(event)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(classifyProviderErrorRecovery({ aborted: false, error })).toBeNull()
  })
})

describe('classifyProviderErrorRecovery on constructed errors', () => {
  const apiError = (
    fields: Partial<ConstructorParameters<typeof APICallError>[0]>,
  ) =>
    new APICallError({
      message: 'Too Many Requests',
      url: 'http://x',
      requestBodyValues: {},
      ...fields,
    })

  it('respects an explicit non-retryable verdict (the turn spend breaker)', () => {
    // model-provider.ts throwIfTurnSpendCapped: a 429 that retrying cannot fix.
    const error = apiError({
      statusCode: 429,
      isRetryable: false,
      responseBody: JSON.stringify({ error: 'turn_spend_limit' }),
    })
    expect(classifyProviderErrorRecovery({ aborted: false, error })).toBeNull()
  })

  it('leaves a failed response the AI SDK already retried alone', () => {
    const lastError = apiError({ statusCode: 503 })
    const error = new RetryError({
      message: 'Failed after 4 attempts',
      reason: 'maxRetriesExceeded',
      errors: [lastError, lastError, lastError, lastError],
    })
    expect(classifyProviderErrorRecovery({ aborted: false, error })).toBeNull()
  })

  it('ignores anything that is not an API call error', () => {
    expect(
      classifyProviderErrorRecovery({
        aborted: false,
        error: new Error('Upstream provider error (502): Bad gateway'),
      }),
    ).toBeNull()
  })

  it.each([
    [{ 'retry-after': '3' }, 3_000],
    [{ 'Retry-After': '0' }, 0],
    [{ 'retry-after-ms': '1500' }, 1_500],
    [{ 'retry-after': '120' }, PROVIDER_ERROR_MAX_RETRY_DELAY_MS],
    [{ 'retry-after': 'soon' }, PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS],
  ])('honours retry-after %o, bounded', (responseHeaders, delayMs) => {
    const error = apiError({ statusCode: 429, responseHeaders })
    expect(
      classifyProviderErrorRecovery({ aborted: false, error })?.delayMs,
    ).toBe(delayMs)
  })

  it('bounds a far-future retry-after date', () => {
    const error = apiError({
      statusCode: 503,
      responseHeaders: {
        'retry-after': new Date(Date.now() + 3_600_000).toUTCString(),
      },
    })
    expect(
      classifyProviderErrorRecovery({ aborted: false, error })?.delayMs,
    ).toBe(PROVIDER_ERROR_MAX_RETRY_DELAY_MS)
  })

  it('truncates a runaway provider message in the note', () => {
    const error = apiError({ statusCode: 502, message: 'x'.repeat(5_000) })
    const recovery = classifyProviderErrorRecovery({ aborted: false, error })
    expect(recovery!.detail!.length).toBeLessThan(600)
  })
})

describe('promptAiSdkStream with a mid-stream provider error', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    trace() {},
    child() {
      return this
    },
  }

  const run = (body: string, signal = new AbortController().signal) => {
    globalThis.fetch = (async () =>
      sseResponse(body)) as unknown as typeof fetch
    return promptAiSdkStream({
      apiKey: 'test-key',
      runId: 'run-1',
      messages: [{ role: 'user', content: 'hello' }],
      clientSessionId: 'session-1',
      fingerprintId: 'fingerprint-1',
      model: 'openai/gpt-5.6-luna',
      userId: 'user-1',
      userInputId: 'input-1',
      sendAction: async () => undefined,
      logger,
      trackEvent: async () => undefined,
      signal,
    } as unknown as Parameters<typeof promptAiSdkStream>[0])
  }

  const drain = async (stream: ReturnType<typeof run>) => {
    const chunks: StreamChunk[] = []
    for (;;) {
      const next = await stream.next()
      if (next.done) return { chunks, result: next.value }
      chunks.push(next.value)
    }
  }

  it('keeps the partial answer and yields a provider-error recovery after a backoff', async () => {
    const startedAt = Date.now()
    const { chunks, result } = await drain(
      run(
        sse(
          textChunk('Looking at the handler, '),
          lateFailure('Upstream provider error (502): Bad gateway'),
        ),
      ),
    )

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      PROVIDER_ERROR_DEFAULT_DELAY_MS - 50,
    )
    expect(chunks.map((c) => c.type)).toEqual(['text', 'error'])
    expect(chunks[1]).toMatchObject({
      type: 'error',
      source: 'provider-error',
      detail: 'Upstream provider error (502): Bad gateway',
    })
    // Before #1155 this threw and ended the run.
    expect(result).toEqual({ aborted: false, value: null })
  })

  it('still throws a non-retryable provider error', async () => {
    await expect(
      drain(
        run(
          sse(
            textChunk('partial'),
            openRouterError(
              400,
              'Provider returned error',
              'prompt is too long',
            ),
          ),
        ),
      ),
    ).rejects.toThrow('prompt is too long')
  })

  it('ends as a cancel, not a retry, when the user stops during the backoff', async () => {
    const abort = new AbortController()
    const stream = run(
      sse(lateFailure('Upstream provider error (429): Model is at capacity.')),
      abort.signal,
    )
    setTimeout(() => abort.abort(), 50)
    const startedAt = Date.now()
    const { chunks, result } = await drain(stream)

    expect(Date.now() - startedAt).toBeLessThan(
      PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS,
    )
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(result.aborted).toBe(true)
  })
})
