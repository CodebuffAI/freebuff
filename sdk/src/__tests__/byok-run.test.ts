import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { CodebuffClient } from '../client'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

const agent: AgentDefinition = {
  id: 'byok-scripted-agent',
  displayName: 'BYOK scripted agent',
  model: 'ignored-by-byok',
  reasoningOptions: { effort: 'minimal' },
  toolNames: ['read_files', 'write_file', 'run_terminal_command'],
  systemPrompt: 'Read, edit, test, then state that the file is complete.',
}

function sse(body: unknown): Response {
  return new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function connection(overrides: Partial<ConstructorParameters<typeof CodebuffClient>[0]['byok']> = {}) {
  return {
    id: 'failure-connection', revision: 1, name: 'failure test', provider: 'openai-compatible' as const,
    baseUrl: 'http://127.0.0.1:9876/v1', model: 'scripted/model',
    credentialRef: 'connection:failure-connection:1', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', apiKey: 'provider-key-canary',
    ...overrides,
  }
}

describe('direct BYOK SDK runs', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  test('runs a real local write-file tool loop without any Codebuff request', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'freebuff-byok-'))
    await writeFile(path.join(cwd, 'input.txt'), 'source value')
    const seen: Array<{ url: string; auth: string; body: string }> = []
    let completion = 0
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input)
      seen.push({
        url,
        auth: new Headers(init?.headers).get('authorization') ?? '',
        body: String(init?.body),
      })
      completion += 1
      const toolCall = (name: string, input: unknown) => sse({
        id: `step-${completion}`, object: 'chat.completion.chunk', created: 1, model: 'scripted/model',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
          index: 0, id: `call-${completion}`, type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        }] }, finish_reason: 'tool_calls' }],
      })
      if (completion === 1) {
        return toolCall('read_files', { paths: ['input.txt'] })
      }
      if (completion === 2) {
        return toolCall('write_file', {
          path: 'result.txt', instructions: 'Create the requested file.', content: 'written by BYOK',
        })
      }
      if (completion === 3) {
        return toolCall('run_terminal_command', {
          command: 'test "$(cat result.txt)" = "written by BYOK"',
          process_type: 'SYNC', cwd: '.', timeout_seconds: 5,
        })
      }
      return sse({
        id: 'second', object: 'chat.completion.chunk', created: 1, model: 'scripted/model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Complete.' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch

    const client = new CodebuffClient({
      cwd,
      agentDefinitions: [agent],
      byok: {
        id: 'connection-id', revision: 1, name: 'scripted', provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9876/v1', model: 'scripted/model',
        credentialRef: 'connection:connection-id:1', createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z', apiKey: 'byok-loop-canary',
      },
    })
    const result = await client.run({ agent: agent.id, prompt: 'Create result.txt.' })

    expect(result.output.type).not.toBe('error')
    expect(await readFile(path.join(cwd, 'result.txt'), 'utf8')).toBe('written by BYOK')
    expect(seen).toHaveLength(4)
    expect(seen.every((request) => request.url === 'http://127.0.0.1:9876/v1/chat/completions')).toBe(true)
    expect(seen.every((request) => request.auth === 'Bearer byok-loop-canary')).toBe(true)
    expect(seen.every((request) => request.body.includes('scripted/model'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain('byok-loop-canary')

    const resumed = await client.run({ agent: agent.id, prompt: 'Continue.', previousRun: result })
    expect(resumed.output.type).not.toBe('error')
    expect(resumed.inference).toEqual(result.inference)

    const changed = await client.run({
      agent: agent.id, prompt: 'Switch.', previousRun: result,
      byok: { ...client.options.byok!, id: 'different-connection' },
    })
    expect(changed.output.type).toBe('error')
    if (changed.output.type !== 'error') throw new Error('expected inference pin error')
    expect(changed.output.message).toContain('different inference connection')

    const beforeSwitch = seen.length
    const hostedHistory = { ...result, inference: { source: 'codebuff' as const } }
    const switched = await client.run({ agent: agent.id, prompt: 'Continue with my key.', previousRun: hostedHistory })
    expect(switched.output.type).not.toBe('error')
    expect(switched.inference).toEqual(result.inference)
    expect(seen.length).toBeGreaterThan(beforeSwitch)
    expect(seen.at(-1)!.body).toContain('Create result.txt.')
    expect(seen.slice(beforeSwitch).every(request => request.url === 'http://127.0.0.1:9876/v1/chat/completions')).toBe(true)
    const hostedClient = new CodebuffClient({ cwd, apiKey: 'hosted-test-key', agentDefinitions: [agent] })
    const beforeReverse = seen.length
    const reverse = await hostedClient.run({ agent: agent.id, prompt: 'Go back.', previousRun: switched })
    expect(reverse.output.type).toBe('error')
    expect(seen).toHaveLength(beforeReverse)

    const legacy = await client.run({
      agent: agent.id, prompt: 'Legacy.', previousRun: { ...result, inference: undefined },
    })
    expect(legacy.output.type).toBe('error')
    if (legacy.output.type !== 'error') throw new Error('expected legacy pin error')
    expect(legacy.output.message).toContain('no inference source pin')
  }, 30_000)

  test('refuses server-side web_search without contacting a hosted backend', async () => {
    const requests: string[] = []
    let step = 0
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input))
      step += 1
      if (step === 1) {
        return sse({ id: 'tool', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'test' }) } }] }, finish_reason: 'tool_calls' }] })
      }
      return sse({ id: 'done', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })
    }) as unknown as typeof fetch
    const client = new CodebuffClient({
      agentDefinitions: [{ ...agent, id: 'byok-web-agent', toolNames: ['web_search'] }],
      byok: { id: 'web-connection', revision: 1, name: 'web', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9876/v1', model: 'm', credentialRef: 'connection:web-connection:1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', apiKey: 'web-canary' },
    })
    const result = await client.run({ agent: 'byok-web-agent', prompt: 'Search.' })
    expect(result.output.type).not.toBe('error')
    expect(requests).toHaveLength(2)
    expect(requests.every((url) => url === 'http://127.0.0.1:9876/v1/chat/completions')).toBe(true)
  })

  test.each([
    [401, 'Check or replace the key.'],
    [402, 'Add provider credit or choose another model.'],
    [429, 'Wait, then retry the task.'],
  ])('keeps provider HTTP %i failures local and actionable', async (status, expected) => {
    const requests: string[] = []
    globalThis.fetch = (async (input) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ error: { message: 'provider-key-canary must not leak' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = new CodebuffClient({ agentDefinitions: [agent], byok: connection() })
    const result = await client.run({ agent: agent.id, prompt: 'Fail safely.' })

    expect(result.output.type).toBe('error')
    if (result.output.type !== 'error') throw new Error('expected BYOK provider error')
    expect(result.output.message).toContain(expected)
    expect(result.output.message).not.toContain('provider-key-canary')
    expect(requests).not.toHaveLength(0)
    expect(requests.every((url) => url === 'http://127.0.0.1:9876/v1/chat/completions')).toBe(true)
  }, 30_000)

  test('stops before provider dispatch when a saved connection was replaced or removed', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return sse({ id: 'unexpected', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [] })
    }) as unknown as typeof fetch
    const client = new CodebuffClient({
      agentDefinitions: [agent],
      byok: connection({ assertCurrent: async () => { throw new Error('connection revision no longer current') } }),
    })

    const result = await client.run({ agent: agent.id, prompt: 'Do not use the replaced connection.' })
    expect(result.output.type).toBe('error')
    if (result.output.type !== 'error') throw new Error('expected BYOK connection error')
    expect(result.output.message).toContain('Could not connect to the BYOK provider')
    expect(requests).toBe(0)
  }, 30_000)

  test('returns a local cancellation result without provider or hosted fallback requests', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by user'))
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      throw new Error('unexpected request')
    }) as unknown as typeof fetch
    const client = new CodebuffClient({ agentDefinitions: [agent], byok: connection() })

    const result = await client.run({ agent: agent.id, prompt: 'Cancel.', signal: controller.signal })
    expect(result.output).toMatchObject({ type: 'error', message: 'Cancelled by user' })
    expect(result.inference).toMatchObject({ source: 'byok', connectionId: 'failure-connection' })
    expect(requests).toBe(0)
  })
})
