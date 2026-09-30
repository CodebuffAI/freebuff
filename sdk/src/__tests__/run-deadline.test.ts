import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { run } from '../run'

import type { AgentDefinition } from '../index'

/**
 * `run()` against a backend that accepts the completion request and never
 * sends a byte. A caller deadline must end the run on time, and must not be
 * reported as Bun's 5-minute fetch idle timeout: `AbortSignal.timeout` rejects
 * with a `TimeoutError`, the name `isFetchIdleTimeoutError` matches.
 */
describe('run() with a caller deadline and a silent upstream', () => {
  let server: ReturnType<typeof Bun.serve>
  let reachedCompletion = false
  const savedAppUrl = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url)
        if (pathname === '/api/v1/chat/completions') {
          reachedCompletion = true
          await new Promise<void>((resolve) =>
            req.signal.addEventListener('abort', () => resolve()),
          )
          return new Response(null, { status: 499 })
        }
        if (pathname === '/api/v1/me') return Response.json({ id: 'user-1' })
        if (pathname === '/api/v1/agent-runs') {
          return Response.json({ runId: 'run-1', stepId: 'step-1' })
        }
        return Response.json({})
      },
    })
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    server.stop(true)
    if (savedAppUrl === undefined)
      delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
    else process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = savedAppUrl
  })

  test('resolves at the deadline as a cancellation', async () => {
    const timeoutMs = 750
    const started = performance.now()
    const result = await run({
      apiKey: 'test-key',
      fingerprintId: 'fp',
      agent: {
        id: 'deadline-test',
        displayName: 'Deadline test',
        model: 'deepseek/deepseek-v4-flash',
        outputMode: 'last_message',
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: 'Reply with one word.',
      } as AgentDefinition,
      prompt: 'hello',
      projectFiles: {},
      knowledgeFiles: {},
      maxAgentSteps: 1,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const elapsed = performance.now() - started

    expect(reachedCompletion).toBe(true)
    expect(elapsed).toBeLessThan(timeoutMs + 2_000)
    expect(result.output.type).toBe('error')
    if (result.output.type === 'error') {
      expect(result.output.message).not.toContain('5 minutes')
    }
  }, 15_000)
})
