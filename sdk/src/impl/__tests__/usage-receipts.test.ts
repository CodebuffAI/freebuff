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

describe('stream usage receipts', () => {
  test.each([true, false])(
    'BYOK requests streaming token counts (provider reports them: %s)',
    async (reportsUsage) => {
      const usage: ModelUsageData[] = []
      let incomplete = 0
      let requestedUsage = false
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        requestedUsage = body.stream_options?.include_usage === true
        const chunks = [
          {
            choices: [
              { index: 0, delta: { content: 'OK' }, finish_reason: 'stop' },
            ],
          },
          ...(requestedUsage && reportsUsage
            ? [
                {
                  choices: [],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                  },
                },
              ]
            : []),
        ]
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }) as typeof fetch

      const stream = promptAiSdkStream({
        apiKey: 'unused-hosted-key',
        byok: {
          id: 'nvidia-fixture',
          revision: 1,
          name: 'NVIDIA',
          provider: 'openai-compatible',
          baseUrl: 'https://integrate.api.nvidia.com/v1',
          model: 'z-ai/glm-5.3-flash',
          apiKey: 'test-provider-key',
          credentialRef: 'env:TEST_PROVIDER_KEY',
          createdAt: 'x',
          updatedAt: 'x',
        },
        runId: 'byok-run',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        clientSessionId: 'byok-session',
        fingerprintId: 'byok-fingerprint',
        model: 'z-ai/glm-5.3-flash',
        userId: 'user-1',
        userInputId: 'byok-input',
        onUsageReceived: (receipt: ModelUsageData) => usage.push(receipt),
        onUsageIncomplete: () => incomplete++,
        sendAction: async () => undefined,
        logger,
        trackEvent: async () => undefined,
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof promptAiSdkStream>[0])

      let text = ''
      for await (const chunk of stream) {
        expect(chunk.type).not.toBe('error')
        if (chunk.type === 'text') text += chunk.text
      }

      expect(requestedUsage).toBe(true)
      expect(text).toBe('OK')
      expect(usage).toEqual(
        reportsUsage
          ? [
              {
                inputTokens: 100,
                cachedInputTokens: 0,
                outputTokens: 20,
                totalTokens: 120,
              },
            ]
          : [],
      )
      expect(incomplete).toBe(reportsUsage ? 0 : 1)
    },
  )

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
