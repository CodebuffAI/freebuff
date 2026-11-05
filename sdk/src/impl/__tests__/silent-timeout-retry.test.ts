/**
 * The runtime's fetch inactivity timeout (Bun: no byte for 5 minutes) before a
 * step received any output is sent once more. Hosted Cloud runs failed on it
 * about 140 times a day (11-03/04), each after a silent 5 minutes, with nothing
 * else in the stack retrying: the AI SDK treats a TimeoutError as an abort and
 * the stream recoveries do not classify it.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { promptAiSdkStream } from '../llm'

import type { StreamChunk } from '@codebuff/common/types/contracts/llm'

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

const usage = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}

const answer = () =>
  new Response(
    `${sse(chunk({ content: 'Done.' }), chunk({}, 'stop'), usage)}data: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  )

const timeout = () =>
  new DOMException('The operation timed out.', 'TimeoutError')

/** A body that streams `text` and then goes silent until the runtime gives up. */
const answerThenTimeout = (text: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(chunk({ content: text }))))
        setTimeout(() => controller.error(timeout()), 5)
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )

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

describe('promptAiSdkStream after a silent request timeout', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const run = (
    responses: Array<() => Response | Promise<Response>>,
    signal = new AbortController().signal,
  ) => {
    let calls = 0
    globalThis.fetch = (async () => {
      const next = responses[Math.min(calls, responses.length - 1)]!
      calls++
      return next()
    }) as unknown as typeof fetch
    const stream = promptAiSdkStream({
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
    return { stream, calls: () => calls }
  }

  const drain = async (stream: ReturnType<typeof run>['stream']) => {
    const chunks: StreamChunk[] = []
    for (;;) {
      const next = await stream.next()
      if (next.done) return { chunks, result: next.value }
      chunks.push(next.value)
    }
  }

  it('sends a request that timed out before any output once more', async () => {
    const attempt = run([
      () => {
        throw timeout()
      },
      answer,
    ])
    const { chunks, result } = await drain(attempt.stream)
    expect(attempt.calls()).toBe(2)
    expect(chunks).toEqual([expect.objectContaining({ type: 'text', text: 'Done.' })])
    expect(result.aborted).toBe(false)
  })

  it('fails as before when the repeat times out too', async () => {
    const attempt = run([
      () => {
        throw timeout()
      },
    ])
    await expect(drain(attempt.stream)).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(attempt.calls()).toBe(2)
  })

  it('never repeats a step that already streamed output', async () => {
    const attempt = run([() => answerThenTimeout('Looking at the handler, '), answer])
    const outcome = await drain(attempt.stream).catch((error: unknown) => ({ error }))
    expect(attempt.calls()).toBe(1)
    // What the partial step does is unchanged; it is only never sent again.
    if ('chunks' in outcome)
      expect(outcome.chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text))
        .toEqual(['Looking at the handler, '])
  })

  it('does not repeat a request the user cancelled', async () => {
    const abort = new AbortController()
    const attempt = run(
      [
        () => {
          abort.abort()
          throw timeout()
        },
        answer,
      ],
      abort.signal,
    )
    await drain(attempt.stream).catch(() => {})
    expect(attempt.calls()).toBe(1)
  })
})
