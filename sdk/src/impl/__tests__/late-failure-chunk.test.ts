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

import { isTransientNetworkError } from '@codebuff/common/util/error'
// The vendored fork, which is what model-provider.ts actually builds the
// backend model from. Testing against the npm @ai-sdk/openai-compatible would
// prove nothing about the client users are running.
import { OpenAICompatibleChatLanguageModel } from '@codebuff/llm-providers/openai-compatible'
import { streamText } from 'ai'
import { describe, expect, it } from 'bun:test'

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
