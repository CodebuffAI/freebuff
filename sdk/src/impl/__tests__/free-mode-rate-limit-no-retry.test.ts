/**
 * The free-mode request limiter answers 429 `free_mode_rate_limited` with a
 * Retry-After. When that wait is longer than any retry (a day-long window),
 * the AI SDK used to retry after 2-8 s anyway. On a Desktop or Cloud model
 * start the first refusal refunds the purchase, so the retry met a 409
 * `session_superseded` and the user read "This model purchase was refunded …
 * Start a new session" instead of the limit (Discord #787). The SDK must
 * refuse the long wait once and keep the limiter's own copy.
 */
import { extractApiErrorDetails } from '@codebuff/common/util/error'
import { APICallError, streamText } from 'ai'
import { afterEach, describe, expect, test } from 'bun:test'

import { getModelForRequest } from '../model-provider'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const DAILY_LIMIT = {
  error: 'free_mode_rate_limited',
  message:
    "You've reached the daily limit on free-model requests. It resets in about 5 hours.",
}

const REFUNDED = {
  error: 'session_superseded',
  message:
    'This model purchase was refunded to the daily pool or wallet that paid for it. Start a new session to try again.',
}

type Reply = {
  status: number
  body: Record<string, unknown>
  retryAfter?: string
}

/** Answers each call with the next reply; the last one repeats. */
function serve(...replies: Reply[]): { calls: () => number } {
  let calls = 0
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)]!
    calls += 1
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: {
        'content-type': 'application/json',
        ...(reply.retryAfter !== undefined && {
          'retry-after': reply.retryAfter,
        }),
      },
    })
  }) as unknown as typeof fetch
  return { calls: () => calls }
}

/** Runs one completion and returns whatever it failed with. */
async function failureOf(maxRetries: number): Promise<unknown> {
  const result = streamText({
    model: getModelForRequest({ apiKey: 'k', model: 'openai/gpt-5.6-luna' }),
    messages: [{ role: 'user', content: 'hi' }],
    maxRetries,
  })
  let error: unknown
  try {
    for await (const part of result.stream) {
      if (part.type === 'error') error = (part as { error: unknown }).error
    }
  } catch (thrown) {
    error ??= thrown
  }
  await Promise.resolve(result.text).catch((thrown: unknown) => {
    error ??= thrown
  })
  return error
}

describe('a free-mode rate-limit refusal (429 free_mode_rate_limited)', () => {
  test('a daily-window refusal is refused once and keeps its reset time, never reaching the refunded-start 409', async () => {
    // The prod sequence: the limit refuses the start, which refunds it, and a
    // retry would be told the purchase was refunded.
    const server = serve(
      { status: 429, body: DAILY_LIMIT, retryAfter: '19631' },
      { status: 409, body: REFUNDED },
    )

    const error = await failureOf(3)

    expect(server.calls()).toBe(1)
    expect(APICallError.isInstance(error)).toBe(true)
    const apiError = error as APICallError
    expect(apiError.isRetryable).toBe(false)
    expect(apiError.statusCode).toBe(429)
    expect(apiError.message).toBe(DAILY_LIMIT.message)
    expect(apiError.message).toContain('resets in about 5 hours')
    // What the runtime's error parser carries to `AgentOutput`: the code and
    // the limiter's copy, which the CLI, Desktop and Cloud show as written.
    expect(extractApiErrorDetails(error)).toMatchObject({
      statusCode: 429,
      errorCode: 'free_mode_rate_limited',
      message: DAILY_LIMIT.message,
    })
  })

  test('a start refunded for any other reason still shows the refund copy', async () => {
    serve({ status: 409, body: REFUNDED })

    const error = (await failureOf(3)) as APICallError

    expect(error.statusCode).toBe(409)
    expect(error.message).toBe(REFUNDED.message)
    expect(extractApiErrorDetails(error)).toMatchObject({
      errorCode: 'session_superseded',
      message: REFUNDED.message,
    })
  })

  test('a wait the AI SDK sits out is still retried', async () => {
    const server = serve({
      status: 429,
      body: { error: 'free_mode_rate_limited', message: 'slow down' },
      retryAfter: '1',
    })

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)

  test('one without a Retry-After is still retried', async () => {
    const server = serve({
      status: 429,
      body: { error: 'free_mode_rate_limited', message: 'slow down' },
    })

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)
})
