import { afterEach, describe, expect, test } from 'bun:test'

import type { ModelUsageData } from '@codebuff/common/types/contracts/llm'

import { promptAiSdkStream } from '../llm'

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

describe('credit calculation from OpenRouter usage accounting', () => {
  test('takes max of cost and upstream_inference_cost, never the sum', async () => {
    // usage.cost is the total amount charged and already includes the
    // upstream portion reported separately in cost_details
    // (issue #1164): summing them roughly doubles credits on normal
    // OpenRouter routes. BYOK routes carry the spend in upstream with
    // cost = 0, which max handles and sum would zero out.
    const costs: number[] = []
    const chunks = [
      {
        id: 'chatcmpl-credits-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: { content: 'hello' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-credits-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cost: 0.01,
          cost_details: { upstream_inference_cost: 0.02 },
        },
      },
    ]
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )) as unknown as typeof fetch

    const stream = promptAiSdkStream({
      apiKey: 'test-key',
      runId: 'run-credits-1',
      messages: [{ role: 'user', content: 'hello' }],
      clientSessionId: 'session-credits-1',
      fingerprintId: 'fingerprint-credits-1',
      model: 'openai/gpt-5.6-luna',
      userId: 'user-1',
      userInputId: 'input-credits-1',
      onCostCalculated: async (credits: number) => {
        costs.push(credits)
      },
      sendAction: async () => undefined,
      logger,
      trackEvent: async () => undefined,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof promptAiSdkStream>[0])

    for await (const chunk of stream) {
      void chunk
    }

    expect(costs).toHaveLength(1)
    // max(0.01, 0.02) = 0.02 → * 1.055 margin * 100 credits-per-dollar.
    expect(costs[0]).toBe(Math.round(0.02 * 1.055 * 100))
  })
})

describe('stream usage receipts', () => {
  test('reports final usage and cost before yielding an output-limit recovery', async () => {
    const usage: Array<Record<string, number | undefined>> = []
    const costs: number[] = []
    const callbackOrder: string[] = []
    const chunks = [
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'thinking' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 15 },
          cost: 0.01,
          cost_details: { upstream_inference_cost: 0.02 },
        },
      },
    ]
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )) as unknown as typeof fetch

    const stream = promptAiSdkStream({
      apiKey: 'test-key',
      runId: 'run-1',
      messages: [{ role: 'user', content: 'hello' }],
      clientSessionId: 'session-1',
      fingerprintId: 'fingerprint-1',
      model: 'openai/gpt-5.6-luna',
      userId: 'user-1',
      userInputId: 'input-1',
      onUsageReceived: (receipt: ModelUsageData) => {
        callbackOrder.push('usage')
        usage.push(receipt)
      },
      onCostCalculated: async (credits: number) => {
        callbackOrder.push('cost')
        costs.push(credits)
      },
      sendAction: async () => undefined,
      logger,
      trackEvent: async () => undefined,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof promptAiSdkStream>[0])

    for await (const chunk of stream) {
      if (chunk.type === 'error' && chunk.source === 'output-limit') break
    }

    expect(usage).toEqual([
      {
        inputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 15,
        cachedInputTokens: 40,
        totalTokens: 120,
      },
    ])
    expect(costs).toHaveLength(1)
    expect(costs[0]).toBeGreaterThan(0)
    expect(callbackOrder).toEqual(['usage', 'cost'])
  })

  test('reports an incomplete receipt when the stream ends without final usage', async () => {
    const usage: Array<Record<string, number | undefined>> = []
    let incomplete = 0
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify({
            id: 'chatcmpl-2',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { content: 'partial' },
                finish_reason: null,
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )) as unknown as typeof fetch

    const stream = promptAiSdkStream({
      apiKey: 'test-key',
      runId: 'run-2',
      messages: [{ role: 'user', content: 'hello' }],
      clientSessionId: 'session-2',
      fingerprintId: 'fingerprint-2',
      model: 'openai/gpt-5.6-luna',
      userId: 'user-1',
      userInputId: 'input-2',
      onUsageReceived: (receipt: ModelUsageData) => usage.push(receipt),
      onUsageIncomplete: () => incomplete++,
      sendAction: async () => undefined,
      logger,
      trackEvent: async () => undefined,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof promptAiSdkStream>[0])

    for await (const chunk of stream) {
      if (chunk.type === 'error' && chunk.source === 'stream-interrupted') break
    }

    expect(usage).toEqual([])
    expect(incomplete).toBe(1)
  })

  test('reports an incomplete receipt when cancellation rejects the response body', async () => {
    const abort = new AbortController()
    let incomplete = 0
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const encoder = new TextEncoder()
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl-3',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'test-model',
                    choices: [
                      {
                        index: 0,
                        delta: { content: 'partial' },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              )
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('response body aborted')),
                { once: true },
              )
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
    }) as typeof fetch

    const stream = promptAiSdkStream({
      apiKey: 'test-key',
      runId: 'run-3',
      messages: [{ role: 'user', content: 'hello' }],
      clientSessionId: 'session-3',
      fingerprintId: 'fingerprint-3',
      model: 'openai/gpt-5.6-luna',
      userId: 'user-1',
      userInputId: 'input-3',
      onUsageIncomplete: () => incomplete++,
      sendAction: async () => undefined,
      logger,
      trackEvent: async () => undefined,
      signal: abort.signal,
    } as unknown as Parameters<typeof promptAiSdkStream>[0])

    expect(await stream.next()).toMatchObject({
      value: { type: 'text', text: 'partial' },
    })
    abort.abort()
    await expect(stream.next()).rejects.toThrow()
    expect(incomplete).toBe(1)
  })

  test('does not turn a normal finish without usage into exact zeroes', async () => {
    const usage: ModelUsageData[] = []
    let incomplete = 0
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify({
            id: 'chatcmpl-4',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { content: 'done' },
                finish_reason: 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )) as unknown as typeof fetch

    const stream = promptAiSdkStream({
      apiKey: 'test-key',
      runId: 'run-4',
      messages: [{ role: 'user', content: 'hello' }],
      clientSessionId: 'session-4',
      fingerprintId: 'fingerprint-4',
      model: 'openai/gpt-5.6-luna',
      userId: 'user-1',
      userInputId: 'input-4',
      onUsageReceived: (receipt: ModelUsageData) => usage.push(receipt),
      onUsageIncomplete: () => incomplete++,
      sendAction: async () => undefined,
      logger,
      trackEvent: async () => undefined,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof promptAiSdkStream>[0])

    for await (const _chunk of stream) {
      // consume the complete response
    }

    expect(usage).toEqual([])
    expect(incomplete).toBe(1)
  })
})
