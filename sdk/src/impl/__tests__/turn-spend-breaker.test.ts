/** Older servers can still return a final turn_spend_limit refusal. The SDK
 * must preserve its copy and avoid retrying it. Current servers use pacing. */
import {
  FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE,
  FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
} from '@codebuff/common/constants/freebuff-errors'
import { extractApiErrorDetails } from '@codebuff/common/util/error'
import { APICallError, streamText } from 'ai'
import { afterEach, describe, expect, test } from 'bun:test'

import { getModelForRequest } from '../model-provider'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve429(body: Record<string, unknown>): { calls: () => number } {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'content-type': 'application/json' },
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

describe('per-turn spend breaker on the SDK side', () => {
  test('a capped turn is refused once, not retried, and keeps the server copy', async () => {
    const server = serve429({
      error: FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE,
      message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
    })

    const error = await failureOf(3)

    // One request even with three retries on offer: the AI SDK only retries
    // an APICallError that says it is retryable, and this one says no.
    expect(server.calls()).toBe(1)
    expect(APICallError.isInstance(error)).toBe(true)
    const apiError = error as APICallError
    expect(apiError.isRetryable).toBe(false)
    expect(apiError.statusCode).toBe(429)
    expect(apiError.message).toBe(FREEBUFF_TURN_SPEND_LIMIT_MESSAGE)
    // What the runtime's error parser (run-agent-step.ts) reads off it: the
    // code reaches `AgentOutput.error`, the copy replaces "Agent run error: …".
    expect(extractApiErrorDetails(error)).toMatchObject({
      statusCode: 429,
      errorCode: FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE,
      message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
    })
  })

  test('any other 429 is still retried', async () => {
    const server = serve429({ error: 'free_mode_rate_limited', message: 'slow down' })

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)
})
