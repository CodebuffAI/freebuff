import { afterEach, describe, expect, mock, test } from 'bun:test'
import { streamText } from 'ai'

import { getAgentRuntimeImpl } from '../agent-runtime'
import { getModelForRequest } from '../model-provider'

import type { CodebuffRequestHeadersProvider } from '../model-provider'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

const sse = () =>
  new Response(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

function captureFetch() {
  const calls: Array<{ url: string; headers: Headers; body: string }> = []
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    })
    return sse()
  }) as unknown as typeof fetch
  return calls
}

const BYOK = {
  id: 'conn',
  revision: 1,
  name: 'local',
  provider: 'openai-compatible' as const,
  baseUrl: 'http://127.0.0.1:9876/v1',
  model: 'selected/model',
  credentialRef: 'connection:conn',
  createdAt: 'x',
  updatedAt: 'x',
  apiKey: 'byok-key',
}

describe('requestHeaders hook', () => {
  test('without a hook the backend request is unchanged', async () => {
    const calls = captureFetch()
    await streamText({
      model: getModelForRequest({ apiKey: 'tok', model: 'a/model' }),
      messages: [{ role: 'user', content: 'hello' }],
    }).text
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tok')
    expect(calls[0]!.headers.get('x-extra')).toBeNull()
  })

  test('the hook sees the exact body sent and its headers are added', async () => {
    const calls = captureFetch()
    const seen: Array<{ method: string; url: string; body: unknown }> = []
    const requestHeaders: CodebuffRequestHeadersProvider = async (request) => {
      seen.push(request)
      return { 'x-extra': `len:${String(request.body).length}` }
    }
    await streamText({
      model: getModelForRequest({
        apiKey: 'tok',
        model: 'a/model',
        requestHeaders,
      }),
      messages: [{ role: 'user', content: 'hello' }],
    }).text
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe(calls[0]!.url)
    expect(new URL(seen[0]!.url).pathname).toBe('/api/v1/chat/completions')
    // byte-for-byte what went on the wire
    expect(seen[0]!.body).toBe(calls[0]!.body)
    expect(calls[0]!.headers.get('x-extra')).toBe(
      `len:${calls[0]!.body.length}`,
    )
    // the SDK's own headers survive the merge
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tok')
  })

  test('a throwing hook sends the request without extra headers', async () => {
    const calls = captureFetch()
    await streamText({
      model: getModelForRequest({
        apiKey: 'tok',
        model: 'a/model',
        requestHeaders: () => {
          throw new Error('boom')
        },
      }),
      messages: [{ role: 'user', content: 'hello' }],
    }).text
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tok')
  })

  test('a BYOK request never consults the hook', async () => {
    const calls = captureFetch()
    const hook = mock(() => ({ 'x-extra': '1' }))
    await streamText({
      model: getModelForRequest({
        apiKey: 'tok',
        model: 'a/model',
        byok: BYOK,
        requestHeaders: hook,
      }),
      messages: [{ role: 'user', content: 'hello' }],
    }).text
    expect(hook).not.toHaveBeenCalled()
    expect(calls[0]!.headers.get('x-extra')).toBeNull()
  })
})

describe('requestHeaders through the agent runtime', () => {
  test('a non-BYOK runtime hands the hook to its completions requests', async () => {
    const calls = captureFetch()
    const hook = mock(() => ({ 'x-extra': 'from-runtime' }))
    const noop = (() => {}) as any
    const impl = getAgentRuntimeImpl({
      apiKey: 'tok',
      requestHeaders: hook,
      handleStepsLogChunk: noop,
      requestToolCall: noop,
      requestMcpToolData: noop,
      requestFiles: noop,
      requestImageFile: noop,
      requestOptionalFile: noop,
      sendAction: noop,
      sendSubagentChunk: noop,
    })
    const logger = { debug: noop, info: noop, warn: noop, error: noop }
    for await (const _chunk of impl.promptAiSdkStream({
      apiKey: 'tok',
      model: 'a/model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      logger,
      signal: new AbortController().signal,
      userId: 'u',
      userInputId: 'input',
      clientSessionId: 's',
      fingerprintId: 'f',
      runId: 'r',
      agentId: 'a',
      includeCacheControl: false,
      sendAction: noop,
      liveUserInputRecord: { userInputId: 'input' },
      sessionConnections: {},
      trackEvent: noop,
    } as any)) {
      // drain
    }
    expect(hook).toHaveBeenCalled()
    expect(calls.at(-1)!.headers.get('x-extra')).toBe('from-runtime')
  })
})
