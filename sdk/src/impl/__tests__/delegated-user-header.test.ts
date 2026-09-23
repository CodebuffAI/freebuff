import { FREEBUFF_ACTING_USER_HEADER } from '@codebuff/common/constants/freebuff-models'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { addAgentStep, finishAgentRun, startAgentRun } from '../database'
import {
  BYOK_CONNECTION_FAILURE_MESSAGE,
  getByokProviderErrorMessage,
  getModelForRequest,
  isByokModelIdRejection,
  redactProviderStream,
} from '../model-provider'
import { streamText } from 'ai'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const originalFetch = globalThis.fetch
const logger = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
} as unknown as Logger

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('SDK delegated user headers', () => {
  test('classifies provider failures with fixed, actionable messages', () => {
    const canary = 'upstream-secret-canary'
    expect(getByokProviderErrorMessage(401)).toContain('Check or replace the key')
    expect(getByokProviderErrorMessage(403)).toContain('Choose an allowed model')
    expect(getByokProviderErrorMessage(402)).toContain('Add provider credit')
    expect(getByokProviderErrorMessage(429)).toContain('Wait, then retry')
    expect(getByokProviderErrorMessage(503)).toContain('temporarily unavailable')
    for (const status of [401, 402, 403, 429, 503]) {
      expect(getByokProviderErrorMessage(status)).toContain(`HTTP ${status}`)
      expect(getByokProviderErrorMessage(status)).not.toContain(canary)
    }
    expect(BYOK_CONNECTION_FAILURE_MESSAGE).toContain('provider URL and network')
  })

  test('redacts a provider key across every stream chunk boundary', async () => {
    const secret = 'byok-secret-canary'
    for (let split = 1; split < secret.length; split++) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`prefix ${secret.slice(0, split)}`))
          controller.enqueue(new TextEncoder().encode(`${secret.slice(split)} suffix`))
          controller.close()
        },
      })
      const response = new Response(redactProviderStream(stream, secret))
      const body = await response.text()
      expect(body).toBe('prefix [redacted] suffix')
      expect(body).not.toContain(secret)
    }
  })

  test('sanitizes asynchronous provider stream failures', async () => {
    const secret = 'stream-error-canary'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { queueMicrotask(() => controller.error(new Error(secret))) },
    })
    const response = new Response(redactProviderStream(stream, secret))
    let error = ''
    await response.text().catch((value: unknown) => { error = String(value) })
    expect(error).toContain('BYOK provider stream failed')
    expect(error).not.toContain(secret)
  })

  test('routes a direct BYOK request to its selected endpoint only', async () => {
    let requestUrl = ''
    let authorization = ''
    let requestBody = ''
    globalThis.fetch = mock(async (input, init) => {
      requestUrl = String(input)
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      requestBody = String(init?.body)
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    const result = streamText({
      model: getModelForRequest({
        apiKey: 'must-not-be-sent',
        model: 'ignored/model',
        byok: {
          id: 'conn', revision: 1, name: 'local', provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:9876/v1', model: 'selected/model',
          credentialRef: 'connection:conn', createdAt: 'x', updatedAt: 'x', apiKey: 'byok-canary',
        },
      }),
      messages: [{ role: 'user', content: 'hello' }],
    })
    await result.text

    expect(requestUrl).toBe('http://127.0.0.1:9876/v1/chat/completions')
    expect(authorization).toBe('Bearer byok-canary')
    expect(requestBody).toContain('selected/model')
    expect(requestBody).not.toContain('must-not-be-sent')
    expect(requestBody).not.toContain('codebuff_metadata')
  })

  test('replaces an upstream BYOK error body with its safe status guidance', async () => {
    const upstreamCanary = 'provider-body-secret-canary'
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: { message: upstreamCanary } }),
      { status: 402, headers: { 'content-type': 'application/json', 'x-upstream-key': upstreamCanary } },
    )) as unknown as typeof fetch
    const result = streamText({
      model: getModelForRequest({
        apiKey: 'ignored', model: 'ignored',
        byok: { id: 'conn', revision: 1, name: 'local', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9876/v1', model: 'selected/model', credentialRef: 'connection:conn', createdAt: 'x', updatedAt: 'x', apiKey: 'key-canary' },
      }),
      messages: [{ role: 'user', content: 'hello' }],
      maxRetries: 0,
    })
    let message = ''
    for await (const part of result.stream) {
      if (part.type === 'error') message = String(part.error)
    }
    expect(message).toContain('needs credits or a supported plan')
    expect(message).toContain('HTTP 402')
    expect(message).not.toContain(upstreamCanary)
    expect(message).not.toContain('key-canary')
  })

  test('recognises a provider saying the model id is wrong, and nothing else', () => {
    // Verbatim bodies. DeepSeek's was measured 2026-09-23.
    const rejections = [
      '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek/deepseek-v4-flash.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
      '{"error":{"message":"The model `gpt-5.6-lunaa` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
      '{"error":{"message":"foo/bar is not a valid model ID","code":400}}',
      '{"error":{"code":404,"message":"models/gemini-9 is not found for API version v1beta, or is not supported for generateContent."}}',
      '{"message":"Invalid model: mistral-hyper"}',
    ]
    for (const body of rejections) expect(isByokModelIdRejection(body)).toBe(true)

    const others = [
      '{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}',
      '{"error":{"message":"max_tokens is too large for this model. Tool calls not found in history."}}',
      '<html><body>404 page not found</body></html>',
      '',
    ]
    for (const body of others) expect(isByokModelIdRejection(body)).toBe(false)
  })

  test('names the configured model, never the upstream text, when the model id is rejected', () => {
    const message = getByokProviderErrorMessage(400, {
      model: 'deepseek/deepseek-v4-flash',
      modelRejected: true,
    })
    expect(message).toContain('does not recognise the model ID "deepseek/deepseek-v4-flash"')
    expect(message).toContain('HTTP 400')
    // A rejection on a status that cannot mean "bad model" keeps its own copy.
    expect(getByokProviderErrorMessage(401, { model: 'm', modelRejected: true })).toContain(
      'rejected the API key',
    )
    // Unclassified 400s are unchanged.
    expect(getByokProviderErrorMessage(400)).toBe(
      'BYOK provider request failed (HTTP 400). Check the provider settings and retry.',
    )
  })

  test('a provider 400 for an unknown model reaches the user as a model-id problem', async () => {
    const upstreamCanary = 'provider-body-secret-canary'
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: { message: `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek/deepseek-v4-flash. ${upstreamCanary}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const result = streamText({
      model: getModelForRequest({
        apiKey: 'ignored', model: 'ignored',
        byok: { id: 'conn', revision: 1, name: 'deepseek', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek/deepseek-v4-flash', credentialRef: 'connection:conn', createdAt: 'x', updatedAt: 'x', apiKey: 'key-canary' },
      }),
      messages: [{ role: 'user', content: 'hello' }],
      maxRetries: 0,
    })
    let message = ''
    for await (const part of result.stream) {
      if (part.type === 'error') message = String(part.error)
    }
    expect(message).toContain('does not recognise the model ID "deepseek/deepseek-v4-flash"')
    expect(message).not.toContain(upstreamCanary)
    expect(message).not.toContain('key-canary')
  })

  test('sends userId on model requests', async () => {
    const model = getModelForRequest({
      apiKey: 'service-key',
      model: 'test/model',
      userId: 'end-user',
    })

    expect((model as any).config.headers()).toMatchObject({
      Authorization: 'Bearer service-key',
      [FREEBUFF_ACTING_USER_HEADER]: 'end-user',
    })
  })

  test('sends userId on agent run requests', async () => {
    const requests: RequestInit[] = []
    globalThis.fetch = mock(async (_input, init) => {
      requests.push(init ?? {})
      const body = JSON.parse(String(init?.body))
      return Response.json(
        body.action === 'START'
          ? { runId: 'run-1' }
          : body.stepNumber !== undefined
            ? { stepId: 'step-1' }
            : { success: true },
      )
    }) as unknown as typeof fetch

    await startAgentRun({
      apiKey: 'service-key',
      userId: 'end-user',
      agentId: 'agent',
      ancestorRunIds: [],
      logger,
    })
    await addAgentStep({
      apiKey: 'service-key',
      userId: 'end-user',
      agentRunId: 'run-1',
      stepNumber: 1,
      messageId: null,
      startTime: new Date(),
      logger,
    })
    await finishAgentRun({
      apiKey: 'service-key',
      userId: 'end-user',
      runId: 'run-1',
      status: 'completed',
      totalSteps: 1,
      directCredits: 1,
      totalCredits: 1,
      logger,
    })

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.headers).toMatchObject({
        [FREEBUFF_ACTING_USER_HEADER]: 'end-user',
      })
    }
  })

  test('omits the internal header when userId is not supplied', async () => {
    let headers: HeadersInit | undefined
    globalThis.fetch = mock(async (_input, init) => {
      headers = init?.headers
      return Response.json({ runId: 'run-1' })
    }) as unknown as typeof fetch

    await startAgentRun({
      apiKey: 'user-key',
      agentId: 'agent',
      ancestorRunIds: [],
      logger,
    })

    expect(headers).not.toHaveProperty(FREEBUFF_ACTING_USER_HEADER)
  })
})
