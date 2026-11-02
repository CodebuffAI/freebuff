import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * End-to-end over the real transport: spawn the CLI with `--acp` and drive it
 * with an ACP client over stdio, the way an editor does. Only the handshake
 * and the session lifecycle are exercised (no backend needed).
 */
const repoRoot = path.resolve(import.meta.dir, '../../../..')

type JsonRpcMessage = {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

describe('freebuff --acp over stdio', () => {
  test('a client can initialize and create a session', async () => {
    const child = spawn(
      'bun',
      ['run', path.join(repoRoot, 'cli/src/entry.ts'), '--acp'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NEXT_PUBLIC_CB_ENVIRONMENT: 'prod',
          NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://www.codebuff.com',
          NEXT_PUBLIC_SUPPORT_EMAIL: 'support@freebuff.com',
          NEXT_PUBLIC_POSTHOG_API_KEY: 'phc_test',
          NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://us.i.posthog.com',
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test',
          NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
            'https://billing.stripe.com/p/login/test',
          NEXT_PUBLIC_WEB_PORT: '3000',
          FREEBUFF_MODE: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    const lines: string[] = []
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) lines.push(line)
      }
    })

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const readResponses = (): JsonRpcMessage[] =>
      lines
        .map((line) => JSON.parse(line) as JsonRpcMessage)
        .filter((message) => message.id !== undefined)

    // The protocol requires the initialize exchange to complete before any
    // other request, so the session is created only after the response.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    })

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (readResponses().some((message) => message.id === 1)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: repoRoot, mcpServers: [] },
    })

    while (Date.now() < deadline) {
      if (readResponses().some((message) => message.id === 2)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill()

    const responses = readResponses()

    const initialize = responses.find((message) => message.id === 1)
    const session = responses.find((message) => message.id === 2)
    expect(initialize?.error).toBeUndefined()
    expect(initialize?.result?.protocolVersion).toBe(1)
    expect(session?.error).toBeUndefined()
    expect(typeof session?.result?.sessionId).toBe('string')
  })
})
