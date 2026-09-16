import { afterEach, describe, expect, test } from 'bun:test'

import { getModelForRequest } from '../model-provider'

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
} from '@ai-sdk/provider'
import type { ResolvedByokConnection } from '../../byok'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const connection: ResolvedByokConnection = {
  id: 'connection-1',
  revision: 1,
  name: 'Luna',
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1/',
  model: 'gpt-5.6-luna',
  apiKey: 'provider-key-canary',
  credentialRef: 'env:PROVIDER_KEY',
  createdAt: 'x',
  updatedAt: 'x',
}
const options: LanguageModelV2CallOptions = {
  prompt: [
    { role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] },
  ],
  maxOutputTokens: 4096,
  stopSequences: ['"cb_easp"'],
  tools: [
    { type: 'function', name: 'read_files', inputSchema: { type: 'object' } },
  ],
  toolChoice: { type: 'auto' },
}

async function request(
  mode: 'stream' | 'generate',
  overrides: Partial<ResolvedByokConnection> = {},
  callOptions: Partial<LanguageModelV2CallOptions> = {},
) {
  const selected = { ...connection, ...overrides }
  let body: Record<string, unknown> = {}
  let url = ''
  let headers = new Headers()
  globalThis.fetch = (async (input, init) => {
    url = String(input)
    headers = new Headers(init?.headers)
    body = JSON.parse(String(init?.body))
    const message = { role: 'assistant', content: 'OK' }
    if (mode === 'stream') {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    }
    return Response.json({ choices: [{ message, finish_reason: 'stop' }] })
  }) as typeof fetch
  const model = getModelForRequest({
    apiKey: 'hosted-key-must-not-be-sent',
    model: 'ignored',
    byok: selected,
  }) as LanguageModelV2
  let serialized: unknown
  if (mode === 'stream') {
    const result = await model.doStream({ ...options, ...callOptions })
    const reader = result.stream.getReader()
    let text = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.type === 'error') throw next.value.error
      if (next.value.type === 'text-delta') text += next.value.delta
    }
    expect(text).toBe('OK')
    serialized = result.request?.body
  } else {
    const result = await model.doGenerate({ ...options, ...callOptions })
    expect(result.content).toContainEqual({ type: 'text', text: 'OK' })
    serialized = result.request?.body
  }
  // Diagnostics must describe the body actually sent, not pre-transform fields.
  expect(
    JSON.parse(
      typeof serialized === 'string' ? serialized : JSON.stringify(serialized),
    ),
  ).toEqual(body)
  expect(body.model).toBe(selected.model)
  expect(headers.get('authorization')).toBe(`Bearer ${selected.apiKey}`)
  expect(JSON.stringify(body)).not.toContain(selected.apiKey)
  expect(JSON.stringify(body)).not.toContain('hosted-key-must-not-be-sent')
  return { body, url }
}

describe('BYOK provider compatibility', () => {
  for (const mode of ['stream', 'generate'] as const) {
    test(`${mode}: direct Luna uses completion tokens and omits unsupported stop`, async () => {
      const { body, url } = await request(mode)
      expect(url).toBe('https://api.openai.com/v1/chat/completions')
      expect(body.max_completion_tokens).toBe(4096)
      expect(body).not.toHaveProperty('max_tokens')
      expect(body).not.toHaveProperty('stop')
      expect(body).not.toHaveProperty('safety_identifier')
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: { name: 'read_files', parameters: { type: 'object' } },
        },
      ])
      expect(body.tool_choice).toBe('auto')
      expect(body.reasoning_effort).toBe('none')
    })

    test(`${mode}: OpenRouter Luna gets stable attribution with either connection kind`, async () => {
      const native = await request(mode, {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
      })
      const custom = await request(mode, {
        baseUrl: 'https://openrouter.ai/api/v1/',
        model: 'openai/gpt-5.6-luna',
        id: 'recreated-connection',
        revision: 4,
      })
      expect(native.url).toBe('https://openrouter.ai/api/v1/chat/completions')
      expect(custom.url).toBe(native.url)
      expect(native.body.user).toMatch(/^[a-f0-9]{64}$/)
      expect(native.body.safety_identifier).toBe(native.body.user)
      expect(custom.body.user).toBe(native.body.user)
      expect(custom.body.safety_identifier).toBe(native.body.user)
      expect(native.body.max_tokens).toBe(4096)
      expect(native.body.stop).toEqual(options.stopSequences)
      expect(native.body).not.toHaveProperty('max_completion_tokens')
    })
  }

  test('structured requests retain their schema and configured output limit', async () => {
    const responseFormat: LanguageModelV2CallOptions['responseFormat'] = {
      type: 'json',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      name: 'answer',
    }
    const { body } = await request(
      'generate',
      {},
      { responseFormat, maxOutputTokens: 128 },
    )
    expect(body.max_completion_tokens).toBe(128)
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { schema: responseFormat.schema, name: 'answer' },
    })
  })

  test('direct Luna disables reasoning for tools but preserves it for tool-free helpers', async () => {
    const providerOptions = { byok: { reasoningEffort: 'high' as const } }
    const withTools = await request('stream', {}, { providerOptions })
    const withoutTools = await request(
      'generate',
      {},
      { providerOptions, tools: [] },
    )
    expect(withTools.body.reasoning_effort).toBe('none')
    expect(withoutTools.body.reasoning_effort).toBe('high')
  })

  test('attribution is credential-scoped across models and cannot be replaced by per-call options', async () => {
    const router = {
      provider: 'openrouter' as const,
      model: 'openai/gpt-5.6-luna',
    }
    const first = await request('stream', router)
    const next = await request(
      'generate',
      { ...router, model: 'openai/gpt-4.1-mini' },
      {
        providerOptions: {
          byok: { user: 'per-call-user', safety_identifier: 'per-call-safety' },
        },
      },
    )
    const other = await request('generate', {
      ...router,
      apiKey: 'another-provider-key',
    })
    expect(next.body.user).toBe(first.body.user)
    expect(next.body.safety_identifier).toBe(first.body.user)
    expect(other.body.user).not.toBe(first.body.user)
  })

  test.each([
    { baseUrl: 'http://localhost:1234/v1' },
    { baseUrl: 'https://api.openai.com.example/v1' },
    { baseUrl: 'https://api.openai.com/custom/v1' },
    { model: 'gpt-4.1-mini' },
    { provider: 'openrouter' as const, model: 'anthropic/claude-haiku-4.5' },
    {
      baseUrl: 'https://openrouter.ai.example/api/v1',
      model: 'openai/gpt-5.6-luna',
    },
  ])(
    'preserves the generic request for other endpoints/models: %j',
    async (overrides) => {
      const { body } = await request('generate', overrides)
      expect(body.max_tokens).toBe(4096)
      expect(body.stop).toEqual(options.stopSequences)
      expect(body).not.toHaveProperty('max_completion_tokens')
      expect(body).not.toHaveProperty('user')
      expect(body).not.toHaveProperty('safety_identifier')
    },
  )
})
