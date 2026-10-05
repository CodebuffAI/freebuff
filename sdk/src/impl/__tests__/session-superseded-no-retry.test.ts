/**
 * The server answers HTTP 409 `{ error: 'session_superseded' }` when a start
 * was refunded (or the session was taken over). The row is gone, so every
 * retry gets the same answer. The AI SDK retries any 409 four times with
 * backoff, which added ~14s before the user saw the card telling them to start
 * a new session. The SDK must refuse it once and keep the server's copy.
 */
import { extractApiErrorDetails } from '@codebuff/common/util/error'
import { APICallError, streamText } from 'ai'
import { afterEach, describe, expect, test } from 'bun:test'

import { getModelForRequest } from '../model-provider'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const REFUNDED = {
  error: 'session_superseded',
  message:
    'This model purchase was refunded. Start a new session to try again.',
}

function serve(
  status: number,
  body: Record<string, unknown> | string,
): { calls: () => number } {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } },
    )
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

describe('a refunded or superseded start (409 session_superseded)', () => {
  test('is refused once, not retried, and keeps the server copy and code', async () => {
    const server = serve(409, REFUNDED)

    const error = await failureOf(3)

    expect(server.calls()).toBe(1)
    expect(APICallError.isInstance(error)).toBe(true)
    const apiError = error as APICallError
    expect(apiError.isRetryable).toBe(false)
    expect(apiError.statusCode).toBe(409)
    expect(apiError.message).toBe(REFUNDED.message)
    // What every client classifies on: the CLI's superseded screen and
    // Desktop's session-ended state both key on this code.
    expect(extractApiErrorDetails(error)).toMatchObject({
      statusCode: 409,
      errorCode: 'session_superseded',
      message: REFUNDED.message,
    })
  })

  test('falls back to its own copy when the body has no message', async () => {
    serve(409, { error: 'session_superseded' })

    const error = (await failureOf(3)) as APICallError

    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain('Start a new session')
  })

  test('any other 409 is still retried', async () => {
    const server = serve(409, {
      error: 'session_limit_reached',
      message: 'too many tabs',
    })

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)

  test('a 409 whose body is not JSON is still retried', async () => {
    const server = serve(409, 'Conflict')

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)

  test('session_superseded under any other status is not treated as final', async () => {
    const server = serve(503, REFUNDED)

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)
})
