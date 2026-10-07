/**
 * The client half of the contract with the server's grace flush.
 *
 * Once the server has flushed SSE headers (web/src/app/api/v1/chat/completions/
 * grace-flush.ts), a provider failure can no longer be an HTTP status, so it
 * arrives as an in-band chunk. These pin what that chunk has to look like for
 * the CLI to surface it usefully — the properties are the AI SDK's, not ours,
 * so an upgrade could regress them silently.
 */
import http from 'node:http'

import {
  extractApiErrorDetails,
  isTransientNetworkError,
} from '@codebuff/common/util/error'
// The vendored fork, which is what model-provider.ts actually builds the
// backend model from. Testing against the npm @ai-sdk/openai-compatible would
// prove nothing about the client users are running.
import { OpenAICompatibleChatLanguageModel } from '@codebuff/llm-providers/openai-compatible'
import { APICallError, streamText } from 'ai'
import { afterEach, describe, expect, it } from 'bun:test'

import { getModelForRequest } from '../model-provider'
import {
  classifyProviderErrorRecovery,
  classifyThrownStreamRecovery,
} from '../stream-interruption'

/** Serves SSE headers, then `body`, then ends — the post-grace-flush shape. */
const serveSse = async (body: string) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(': connecting\n\n')
    setTimeout(() => {
      res.write(body)
      res.end()
    }, 10)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port }
}

/** Serves SSE headers and one event, destroys the socket, and reads the body
 *  with Node's fetch; prints the thrown error's shape as JSON. */
const NODE_BODY_CUT_SCRIPT = `
const http = require('node:http')
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: {}\\n\\n')
  setTimeout(() => res.socket.destroy(), 20)
})
server.listen(0, '127.0.0.1', async () => {
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port)
    const reader = res.body.getReader()
    while (!(await reader.read()).done) {}
    console.log('null')
  } catch (e) {
    console.log(JSON.stringify({
      isTypeError: e instanceof TypeError,
      message: e.message,
      cause: e.cause && { name: e.cause.name, message: e.cause.message, code: e.cause.code },
    }))
  }
  server.close()
})
`

const consume = async (port: number) => {
  const result = streamText({
    model: new OpenAICompatibleChatLanguageModel('m', {
      provider: 'codebuff',
      url: () => `http://127.0.0.1:${port}/chat/completions`,
      headers: () => ({}),
    }),
    messages: [{ role: 'user', content: 'hi' }],
    maxRetries: 0,
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

const withServer = async (body: string, assert: (error: unknown) => void) => {
  const { server, port } = await serveSse(body)
  try {
    assert(await consume(port))
  } finally {
    server.close()
  }
}

const errorChunk = (error: Record<string, unknown>) =>
  `data: ${JSON.stringify({ error })}\n\n`

describe('late failure delivered in band', () => {
  it('surfaces the message of an OpenAI-shaped error chunk', async () => {
    await withServer(
      errorChunk({
        message: 'Upstream provider error (429): Model is at capacity.',
        type: 'upstream_error',
      }),
      (error) => {
        // The provider's own words survive, for the retry note and for the
        // error shown if the retries run out.
        expect(String(error)).toContain(
          'Upstream provider error (429): Model is at capacity.',
        )
        // Not a "transient network" error: the user's connection is fine, and
        // the network copy would send them chasing their VPN.
        expect(isTransientNetworkError(error)).toBe(false)
        expect(
          classifyThrownStreamRecovery({ aborted: false, error }),
        ).toBeNull()
        // It is a provider failure, retried on the same capped path with a
        // backoff (CodebuffAI/freebuff#1155).
        expect(
          classifyProviderErrorRecovery({ aborted: false, error }),
        ).toMatchObject({ source: 'provider-error', statusCode: 429 })
      },
    )
  })

  it('ends the turn with the message of a final capacity refusal, without a retry', async () => {
    // The server's Space Bunny queue refusal once its wait budget is spent
    // (web/.../space-bunny-queue.ts `spaceBunnyAtCapacityChunk`). A retry
    // would only queue the step for another five minutes, so it carries no
    // status and a non-numeric code, and must not be classified as one.
    const message =
      'Space Bunny is at capacity right now. Please try again in a few minutes or pick another model.'
    await withServer(
      errorChunk({ message, code: 'model_at_capacity', type: 'capacity_error' }),
      (error) => {
        expect(String(error)).toContain(message)
        expect(isTransientNetworkError(error)).toBe(false)
        expect(
          classifyThrownStreamRecovery({ aborted: false, error }),
        ).toBeNull()
        expect(
          classifyProviderErrorRecovery({ aborted: false, error }),
        ).toBeNull()
      },
    )
  })

  it('is why a bare connection cut is not good enough', () => {
    // The behaviour the in-band chunk exists to avoid. Erroring the response
    // body mid-stream reaches Bun's fetch as this message (confirmed against a
    // server that destroyed the socket after flushing SSE headers), which is
    // indistinguishable from a genuine network drop: the real cause is replaced
    // by a network message and the step is retried against a provider that is
    // already failing. Asserted on the message rather than by cutting a real
    // socket, whose teardown timing is not deterministic enough to test on.
    const cut = new Error(
      'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    )
    expect(isTransientNetworkError(cut)).toBe(true)
    expect(
      classifyThrownStreamRecovery({ aborted: false, error: cut }),
    ).not.toBeNull()
  })

  // The runner service runs the SDK on Node, where a body cut after the
  // headers is undici's `TypeError: terminated` (cause UND_ERR_SOCKET), not
  // Bun's message above. Until it was classified, every such cut ended the
  // runner's turn in "Agent run error: terminated". Bun resolves `undici` to
  // its own fetch, so the socket is cut under real Node and the error's shape
  // rebuilt here.
  it.skipIf(!Bun.which('node'))(
    'recovers a connection cut read through Node fetch (undici)',
    () => {
      const run = Bun.spawnSync(['node', '-e', NODE_BODY_CUT_SCRIPT])
      const shape = JSON.parse(run.stdout.toString().trim()) as {
        isTypeError: boolean
        message: string
        cause?: { name: string; message: string; code: string }
      }
      expect(shape.isTypeError).toBe(true)
      expect(shape.message).toBe('terminated')
      expect(shape.cause?.code).toBe('UND_ERR_SOCKET')

      const cause = Object.assign(new Error(shape.cause!.message), shape.cause)
      const error = new TypeError(shape.message, { cause })
      expect(isTransientNetworkError(error)).toBe(true)
      expect(
        classifyThrownStreamRecovery({ aborted: false, error })?.source,
      ).toBe('stream-interrupted')
      // A user cancel is still never a recovery.
      expect(classifyThrownStreamRecovery({ aborted: true, error })).toBeNull()
    },
  )

  it('needs the object form — a bare string fails the response schema', async () => {
    // Guards the shape choice: `{error: "..."}` parses as a validation failure
    // and buries the message under Zod output.
    await withServer(errorChunk('just a string' as never), (error) => {
      expect(String(error)).toContain('Type validation failed')
    })
  })
})

describe('the same capacity refusal over HTTP', () => {
  // Before the grace flush (a non-streaming request, or a silent stream), the
  // queue refusal is `503 {error: 'model_at_capacity', message}` with
  // `Retry-After: 60` (web/.../_post.ts). The AI SDK retries any 503, so left
  // alone it re-queued the step and the user saw the refusal late, as
  // "Failed after N attempts". Like the in-band form it must end the turn at
  // once, with the server's copy. Served through getModelForRequest, whose
  // fetch wrapper is what applies the SDK's final refusals.
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const AT_CAPACITY = {
    error: 'model_at_capacity',
    message:
      'Space Bunny is at capacity right now. Please try again in a few minutes or pick another model.',
  }

  const serve = (status: number, body: Record<string, unknown>) => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      })
    }) as unknown as typeof fetch
    return { calls: () => calls }
  }

  const failureOf = async (maxRetries: number) => {
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

  it('is refused once, not retried, and keeps the server copy and code', async () => {
    const server = serve(503, AT_CAPACITY)

    const error = await failureOf(3)

    expect(server.calls()).toBe(1)
    expect(APICallError.isInstance(error)).toBe(true)
    const apiError = error as APICallError
    expect(apiError.isRetryable).toBe(false)
    expect(apiError.statusCode).toBe(503)
    expect(apiError.message).toBe(AT_CAPACITY.message)
    expect(extractApiErrorDetails(error)).toMatchObject({
      statusCode: 503,
      errorCode: 'model_at_capacity',
      message: AT_CAPACITY.message,
    })
    // Nor does the agent loop's provider-error recovery pick it back up.
    expect(classifyThrownStreamRecovery({ aborted: false, error })).toBeNull()
    expect(classifyProviderErrorRecovery({ aborted: false, error })).toBeNull()
  })

  it('falls back to its own copy when the body has no message', async () => {
    serve(503, { error: 'model_at_capacity' })

    const error = (await failureOf(3)) as APICallError

    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain('at capacity right now')
  })

  it('any other 503 is still retried', async () => {
    const server = serve(503, {
      error: 'service_unavailable',
      message: 'try again',
    })

    await failureOf(1)

    expect(server.calls()).toBe(2)
  }, 15_000)
})
