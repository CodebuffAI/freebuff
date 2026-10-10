import { describe, expect, test, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { CodebuffClient } from '../client'

import type { CodebuffClientOptions, RunOptions } from '../run'
import type { RunState } from '../run-state'
import type { RunStreamEvent } from '../stream'

const state: RunState = {
  traceSessionId: 'trace-client-stream',
  output: { type: 'lastMessage', value: [] },
}

class HarnessClient extends CodebuffClient {
  public calls: (RunOptions & CodebuffClientOptions)[] = []

  constructor(
    options: CodebuffClientOptions,
    private execute: (
      options: RunOptions & CodebuffClientOptions,
    ) => Promise<RunState>,
  ) {
    super({ apiKey: 'test-key', ...options })
  }

  public override async run(options: RunOptions & CodebuffClientOptions) {
    this.calls.push(options)
    return this.execute(options)
  }
}

const emit = async (options: RunOptions & CodebuffClientOptions) => {
  await options.handleEvent?.({ type: 'start', messageHistoryLength: 0 })
  await options.handleStreamChunk?.('Hello')
  return state
}

async function collect(client: CodebuffClient) {
  const stream = client.stream({ agent: 'base', prompt: 'Hello' })
  const events: RunStreamEvent[] = []
  for await (const event of stream) events.push(event)
  await stream.result
  return events
}

describe('CodebuffClient.stream', () => {
  test('streams a real BYOK runtime response and preserves its inference pin', async () => {
    const originalFetch = globalThis.fetch
    const cwd = await mkdtemp(path.join(tmpdir(), 'codebuff-run-stream-'))
    const fetchImpl = mock(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe('http://127.0.0.1:9876/v1/chat/completions')
      const body = {
        id: 'stream-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'scripted/model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Hello from BYOK.' },
            finish_reason: 'stop',
          },
        ],
      }
      return new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    try {
      globalThis.fetch = fetchImpl as unknown as typeof fetch
      const client = new CodebuffClient({
        cwd,
        projectFiles: {},
        knowledgeFiles: {},
        agentDefinitions: [
          {
            id: 'stream-test',
            displayName: 'Stream test',
            model: 'ignored-by-byok',
            toolNames: [],
            systemPrompt: 'Say hello.',
          },
        ],
        byok: {
          id: 'stream-connection',
          revision: 1,
          name: 'stream test',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9876/v1',
          model: 'scripted/model',
          apiKey: 'stream-test-key',
          credentialRef: 'connection:stream-connection:1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })
      const stream = client.stream({ agent: 'stream-test', prompt: 'Hello' })
      const events: RunStreamEvent[] = []
      for await (const event of stream) events.push(event)
      const result = await stream.result
      if (result.output.type === 'error') throw new Error(result.output.message)
      expect(
        events
          .filter(
            (item) => item.type === 'chunk' && typeof item.chunk === 'string',
          )
          .map((item) => (item.type === 'chunk' ? item.chunk : ''))
          .join(''),
      ).toContain('Hello from BYOK.')
      expect(result.inference).toEqual({
        source: 'byok',
        connectionId: 'stream-connection',
        revision: 1,
        model: 'scripted/model',
      })
      expect(
        result.sessionState?.mainAgentState.messageHistory.length,
      ).toBeGreaterThan(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('inherits client configuration and explicit callbacks', async () => {
    const handleEvent = mock(() => {})
    const handleStreamChunk = mock(async () => {})
    const client = new HarnessClient(
      { cwd: '/project', maxAgentSteps: 4, handleEvent, handleStreamChunk },
      emit,
    )
    expect((await collect(client)).length).toBe(2)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].cwd).toBe('/project')
    expect(client.calls[0].maxAgentSteps).toBe(4)
    expect(handleEvent).toHaveBeenCalledTimes(1)
    expect(handleStreamChunk).toHaveBeenCalledTimes(1)
  })

  test('per-call callbacks replace client callbacks', async () => {
    const clientEvent = mock(() => {})
    const clientChunk = mock(() => {})
    const callEvent = mock(() => {})
    const callChunk = mock(() => {})
    const client = new HarnessClient(
      { handleEvent: clientEvent, handleStreamChunk: clientChunk },
      emit,
    )
    const stream = client.stream({
      agent: 'base',
      prompt: 'Hello',
      handleEvent: callEvent,
      handleStreamChunk: callChunk,
      maxAgentSteps: 2,
    })
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result
    expect(clientEvent).not.toHaveBeenCalled()
    expect(clientChunk).not.toHaveBeenCalled()
    expect(callEvent).toHaveBeenCalledTimes(1)
    expect(callChunk).toHaveBeenCalledTimes(1)
    expect(client.calls[0].maxAgentSteps).toBe(2)
  })

  test('yields error events without invoking the default throwing handler', async () => {
    const client = new HarnessClient({}, async (options) => {
      await options.handleEvent?.({ type: 'error', message: 'Agent failed' })
      return { ...state, output: { type: 'error', message: 'Agent failed' } }
    })
    const stream = client.stream({ agent: 'base', prompt: 'Hello' })
    const events: RunStreamEvent[] = []
    for await (const event of stream) events.push(event)
    expect(events).toEqual([
      { type: 'event', event: { type: 'error', message: 'Agent failed' } },
    ])
    expect((await stream.result).output.type).toBe('error')
    // Ordinary callback-based runs retain their established error behavior.
    expect(() =>
      client.options.handleEvent?.({ type: 'error', message: 'Agent failed' }),
    ).toThrow('Received error')
  })

  test('preserves explicit throwing callbacks on streams', async () => {
    const error = new Error('Explicit handler error')
    const client = new HarnessClient(
      {
        handleEvent: () => {
          throw error
        },
      },
      emit,
    )
    const stream = client.stream({ agent: 'base', prompt: 'Hello' })
    await expect(stream.result).rejects.toBe(error)
  })

  test('the stream result can continue a session through run()', async () => {
    const client = new HarnessClient({}, emit)
    const stream = client.stream({ agent: 'base', prompt: 'Hello' })
    for await (const _event of stream) {
      /* consume */
    }
    const previousRun = await stream.result
    await client.run({ agent: 'base', prompt: 'Continue', previousRun })
    expect(client.calls[1].previousRun).toBe(state)
    expect(client.calls[1].prompt).toBe('Continue')
  })

  test('uses the real run cancellation path for a pre-aborted signal', async () => {
    const client = new CodebuffClient({ apiKey: 'test-key' })
    const controller = new AbortController()
    controller.abort(new Error('Already cancelled'))
    const stream = client.stream({
      agent: 'base',
      prompt: 'Hello',
      previousRun: state,
      signal: controller.signal,
    })
    const events: RunStreamEvent[] = []
    for await (const event of stream) events.push(event)
    expect(events).toEqual([])
    const result = await stream.result
    expect(result.traceSessionId).toBe(state.traceSessionId)
    expect(result.output).toEqual({
      type: 'error',
      message: 'Already cancelled',
    })
  })

  test('runs isolated streams with independent signals', async () => {
    const inputs: (RunOptions & CodebuffClientOptions)[] = []
    const client = new HarnessClient({}, async (options) => {
      inputs.push(options)
      await options.handleStreamChunk?.(options.prompt)
      return state
    })
    const first = client.stream({ agent: 'base', prompt: 'First' })
    const second = client.stream({ agent: 'base', prompt: 'Second' })
    await Promise.all([first.result, second.result])
    expect(inputs[0].signal).not.toBe(inputs[1].signal)
    expect((await first[Symbol.asyncIterator]().next()).value).toEqual({
      type: 'chunk',
      chunk: 'First',
    })
    expect((await second[Symbol.asyncIterator]().next()).value).toEqual({
      type: 'chunk',
      chunk: 'Second',
    })
  })
})
