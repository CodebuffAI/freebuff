/**
 * A BYOK run's reasoning effort reaches the provider in that provider's own
 * dialect, is absent unless picked, and never breaks a request: a 400 that
 * names the field is retried once without it, and the connection stops asking.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { withByokReasoningEffort } from '../../byok'
import {
  BYOK_ANTHROPIC_THINKING_BUDGETS,
  clearByokReasoningRejections,
} from '../byok-request'
import { getModelForRequest } from '../model-provider'

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
} from '@ai-sdk/provider'
import type { ResolvedByokConnection } from '../../byok'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearByokReasoningRejections()
})

function connection(
  overrides: Partial<ResolvedByokConnection> = {},
): ResolvedByokConnection {
  const base = {
    id: 'effort-connection',
    revision: 1,
    name: 'Effort test',
    provider: 'openai-compatible' as const,
    baseUrl: 'https://api.example.com/v1',
    model: 'some-reasoning-model',
    credentialRef: 'env:PROVIDER_KEY',
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  }
  // The resolver makes the key non-enumerable; the effort copy must keep it.
  Object.defineProperty(base, 'apiKey', {
    value: 'provider-key-canary',
    enumerable: false,
  })
  return base as ResolvedByokConnection
}

const options: LanguageModelV2CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
  maxOutputTokens: 4096,
  tools: [
    { type: 'function', name: 'read_files', inputSchema: { type: 'object' } },
  ],
  toolChoice: { type: 'auto' },
}

const ok = () =>
  Response.json({
    choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  })

/** Runs one generate call; `answer` decides each attempt's response. */
async function send(
  byok: ResolvedByokConnection,
  answer: (attempt: number, body: Record<string, unknown>) => Response = ok,
) {
  const bodies: Array<Record<string, unknown>> = []
  const headers: string[] = []
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    headers.push(new Headers(init?.headers).get('authorization') ?? '')
    return answer(bodies.length, body)
  }) as typeof fetch
  const model = getModelForRequest({
    apiKey: 'hosted-key-must-not-be-sent',
    model: 'ignored',
    byok,
  }) as LanguageModelV2
  let error: unknown
  try {
    const result = await model.doGenerate(options)
    expect(result.content).toContainEqual({ type: 'text', text: 'OK' })
  } catch (caught) {
    error = caught
  }
  for (const header of headers) expect(header).toBe('Bearer provider-key-canary')
  return { bodies, error }
}

describe('withByokReasoningEffort', () => {
  test('attaches a BYOK rung on a copy that keeps the credential non-enumerable', () => {
    const resolved = connection()
    const high = withByokReasoningEffort(resolved, 'high')
    expect(high).not.toBe(resolved)
    expect(high.reasoningEffort).toBe('high')
    expect(high.apiKey).toBe('provider-key-canary')
    expect(Object.keys(high)).not.toContain('apiKey')
    expect(resolved.reasoningEffort).toBeUndefined()
  })

  test.each([undefined, null, 'max', 'xhigh', 'minimal', 'default'])(
    '%p means the provider default: the connection is returned untouched',
    (effort) => {
      const resolved = connection()
      expect(withByokReasoningEffort(resolved, effort)).toBe(resolved)
    },
  )

  test('clearing an attached effort removes it', () => {
    const cleared = withByokReasoningEffort(
      withByokReasoningEffort(connection(), 'low'),
      null,
    )
    expect(cleared.reasoningEffort).toBeUndefined()
    expect(cleared.apiKey).toBe('provider-key-canary')
  })
})

describe('BYOK reasoning effort in the request body', () => {
  test('unpicked sends no reasoning field for any dialect', async () => {
    for (const overrides of [
      {},
      { provider: 'openrouter' as const, model: 'openai/gpt-5.4' },
      { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-pro',
      },
    ]) {
      const { bodies } = await send(connection(overrides))
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).not.toHaveProperty('reasoning_effort')
      expect(bodies[0]).not.toHaveProperty('reasoning')
      expect(bodies[0]).not.toHaveProperty('thinking')
      expect(bodies[0]!.max_tokens).toBe(4096)
    }
  })

  test('OpenAI-compatible: reasoning_effort', async () => {
    const { bodies } = await send(
      withByokReasoningEffort(connection(), 'medium'),
    )
    expect(bodies[0]!.reasoning_effort).toBe('medium')
    expect(bodies[0]).not.toHaveProperty('reasoning')
  })

  test('Gemini OpenAI-compatible endpoint: reasoning_effort', async () => {
    const { bodies } = await send(
      withByokReasoningEffort(
        connection({
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          model: 'gemini-2.5-pro',
        }),
        'low',
      ),
    )
    expect(bodies[0]!.reasoning_effort).toBe('low')
  })

  test('OpenRouter, native or saved as custom: reasoning.effort', async () => {
    for (const overrides of [
      { provider: 'openrouter' as const, model: 'anthropic/claude-sonnet-4.5' },
      { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4' },
    ]) {
      const { bodies } = await send(
        withByokReasoningEffort(connection(overrides), 'high'),
      )
      expect(bodies[0]!.reasoning).toEqual({ effort: 'high' })
      expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    }
  })

  test('Anthropic: a thinking budget per rung, added on top of the output cap', async () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const { bodies } = await send(
        withByokReasoningEffort(
          connection({
            baseUrl: 'https://api.anthropic.com/v1',
            model: 'claude-sonnet-4-5',
          }),
          effort,
        ),
      )
      const budget = BYOK_ANTHROPIC_THINKING_BUDGETS[effort]
      expect(budget).toBeGreaterThanOrEqual(1024)
      expect(bodies[0]!.thinking).toEqual({
        type: 'enabled',
        budget_tokens: budget,
      })
      expect(bodies[0]!.max_tokens).toBe(4096 + budget)
      expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    }
  })

  test('direct Luna keeps its tool-request reasoning_effort none', async () => {
    const { bodies } = await send(
      withByokReasoningEffort(
        connection({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' }),
        'high',
      ),
    )
    expect(bodies[0]!.reasoning_effort).toBe('none')
  })
})

describe('BYOK reasoning effort rejection fallback', () => {
  const rejects = (message: string) => (attempt: number) =>
    attempt === 1
      ? Response.json({ error: { message } }, { status: 400 })
      : ok()

  test('a 400 naming reasoning_effort is retried once without it, and remembered', async () => {
    const byok = withByokReasoningEffort(connection(), 'high')
    const first = await send(
      byok,
      rejects("Unrecognized request argument supplied: reasoning_effort"),
    )
    expect(first.error).toBeUndefined()
    expect(first.bodies).toHaveLength(2)
    expect(first.bodies[0]!.reasoning_effort).toBe('high')
    expect(first.bodies[1]).not.toHaveProperty('reasoning_effort')
    // Everything else is the same request.
    const { reasoning_effort: _dropped, ...rest } = first.bodies[0]!
    expect(first.bodies[1]).toEqual(rest)

    // The connection no longer asks, so the next request is a single attempt.
    const next = await send(byok)
    expect(next.bodies).toHaveLength(1)
    expect(next.bodies[0]).not.toHaveProperty('reasoning_effort')

    // A new revision (an edited connection) asks afresh.
    const edited = await send(withByokReasoningEffort(connection({ revision: 2 }), 'high'))
    expect(edited.bodies[0]!.reasoning_effort).toBe('high')
  })

  test('Anthropic: the retry drops thinking and restores the output cap', async () => {
    const byok = withByokReasoningEffort(
      connection({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku' }),
      'medium',
    )
    const { bodies, error } = await send(
      byok,
      rejects('thinking: Extra inputs are not permitted'),
    )
    expect(error).toBeUndefined()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toHaveProperty('thinking')
    expect(bodies[1]!.max_tokens).toBe(4096)
  })

  test('OpenRouter: the retry drops reasoning', async () => {
    const { bodies, error } = await send(
      withByokReasoningEffort(
        connection({ provider: 'openrouter', model: 'meta-llama/llama-4' }),
        'low',
      ),
      rejects('Reasoning is not supported for this model'),
    )
    expect(error).toBeUndefined()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toHaveProperty('reasoning')
  })

  test('a 400 about something else is not retried and still fails with the sanitized message', async () => {
    const { bodies, error } = await send(
      withByokReasoningEffort(connection(), 'high'),
      () => Response.json({ error: { message: 'messages: too long' } }, { status: 400 }),
    )
    expect(bodies).toHaveLength(1)
    expect(String((error as Error)?.message)).toContain('HTTP 400')
  })

  test('without a picked effort a reasoning-shaped 400 is not retried', async () => {
    const { bodies, error } = await send(connection(), () =>
      Response.json({ error: { message: 'reasoning_effort is required' } }, { status: 400 }),
    )
    expect(bodies).toHaveLength(1)
    expect(error).toBeDefined()
  })

  test('the retry is attempted once: a second rejection surfaces as the error', async () => {
    const { bodies, error } = await send(
      withByokReasoningEffort(connection(), 'low'),
      () => Response.json({ error: { message: 'invalid reasoning_effort' } }, { status: 400 }),
    )
    expect(bodies).toHaveLength(2)
    expect(String((error as Error)?.message)).toContain('HTTP 400')
  })
})
