#!/usr/bin/env bun
/**
 * Scripted ACP stdio harness for Freebuff `--acp`.
 *
 * Spawns `bun run cli/src/entry.ts --acp` (or FREEBUFF_ACP_CMD), drives
 * initialize → session/new → session/prompt, and optionally session/cancel.
 *
 * Usage:
 *   bun scripts/acp-stdio-harness.ts
 *   bun scripts/acp-stdio-harness.ts --prompt "Say hi in one sentence."
 *   bun scripts/acp-stdio-harness.ts --cancel-ms 500
 *   bun scripts/acp-stdio-harness.ts --turns 2
 *   bun scripts/acp-stdio-harness.ts --live   # expect a real free-mode completion
 *
 * Exit 0 on protocol success. Writes a transcript to
 * scripts/acp-harness-transcript.jsonl (override with --transcript).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '..')

type JsonRpc = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

function argValue(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

const promptText =
  argValue('--prompt') ?? 'Reply with exactly: harness-ok'
const turns = Number(argValue('--turns', '1'))
const cancelMs = argValue('--cancel-ms')
  ? Number(argValue('--cancel-ms'))
  : undefined
const live = hasFlag('--live')
const transcriptPath =
  argValue('--transcript') ??
  path.join(repoRoot, 'scripts/acp-harness-transcript.jsonl')

const cmdEnv = process.env.FREEBUFF_ACP_CMD
const childArgs = cmdEnv
  ? cmdEnv.split(/\s+/)
  : ['bun', 'run', path.join(repoRoot, 'cli/src/entry.ts'), '--acp']

const child: ChildProcessWithoutNullStreams = spawn(childArgs[0]!, childArgs.slice(1), {
  cwd: repoRoot,
  env: {
    ...process.env,
    FREEBUFF_MODE: process.env.FREEBUFF_MODE ?? 'true',
    NEXT_PUBLIC_CB_ENVIRONMENT:
      process.env.NEXT_PUBLIC_CB_ENVIRONMENT ?? 'prod',
    NEXT_PUBLIC_CODEBUFF_APP_URL:
      process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ?? 'https://www.codebuff.com',
    NEXT_PUBLIC_SUPPORT_EMAIL:
      process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@freebuff.com',
    NEXT_PUBLIC_POSTHOG_API_KEY:
      process.env.NEXT_PUBLIC_POSTHOG_API_KEY ?? 'phc_test',
    NEXT_PUBLIC_POSTHOG_HOST_URL:
      process.env.NEXT_PUBLIC_POSTHOG_HOST_URL ?? 'https://us.i.posthog.com',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? 'pk_test',
    NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
      process.env.NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL ??
      'https://billing.stripe.com/p/login/test',
    NEXT_PUBLIC_WEB_PORT: process.env.NEXT_PUBLIC_WEB_PORT ?? '3000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const transcript: Array<Record<string, unknown>> = []
const logLine = (direction: 'in' | 'out' | 'err' | 'meta', payload: unknown) => {
  const entry = { ts: new Date().toISOString(), direction, payload }
  transcript.push(entry)
  if (direction === 'err') {
    process.stderr.write(`[harness:err] ${String(payload)}\n`)
  }
}

let buffer = ''
const inbox: JsonRpc[] = []
const waiters: Array<() => void> = []

child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let index: number
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '')
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let message: JsonRpc
    try {
      message = JSON.parse(line) as JsonRpc
    } catch (error) {
      logLine('meta', { parseError: String(error), line })
      throw new Error(`Non-JSON-RPC stdout line (stdio corruption): ${line}`)
    }
    if (message.jsonrpc !== '2.0') {
      throw new Error(`Invalid JSON-RPC framing: ${line}`)
    }
    logLine('out', message)
    inbox.push(message)
    for (const wake of waiters.splice(0)) wake()
  }
})

child.stderr.on('data', (chunk: Buffer) => {
  logLine('err', chunk.toString('utf8'))
})

const send = (message: Record<string, unknown>) => {
  logLine('in', message)
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

const waitFor = async (
  predicate: (message: JsonRpc) => boolean,
  timeoutMs: number,
): Promise<JsonRpc> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = inbox.find(predicate)
    if (hit) return hit
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
      setTimeout(resolve, 50)
    })
  }
  throw new Error(`Timeout waiting for ACP message after ${timeoutMs}ms`)
}

const killTree = () => {
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
}

let exitCode = 1
try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'freebuff-acp-harness', version: '0.0.0' },
    },
  })
  const init = await waitFor((m) => m.id === 1, 30_000)
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`)
  if (init.result?.protocolVersion !== 1) {
    throw new Error('initialize: unexpected protocolVersion')
  }

  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd: repoRoot, mcpServers: [] },
  })
  const session = await waitFor((m) => m.id === 2, 30_000)
  if (session.error) throw new Error(`session/new failed: ${session.error.message}`)
  const sessionId = session.result?.sessionId
  if (typeof sessionId !== 'string') throw new Error('session/new missing sessionId')
  const modes = session.result?.modes as
    | { currentModeId?: string; availableModes?: unknown[] }
    | undefined
  logLine('meta', { sessionId, modes })

  for (let turn = 0; turn < turns; turn++) {
    const promptId = 100 + turn
    const text =
      turns === 1 ? promptText : `${promptText} (turn ${turn + 1})`
    send({
      jsonrpc: '2.0',
      id: promptId,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [{ type: 'text', text }],
      },
    })

    if (cancelMs !== undefined && turn === 0) {
      await new Promise((r) => setTimeout(r, cancelMs))
      send({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      })
    }

    const promptTimeout = live ? 180_000 : cancelMs !== undefined ? 60_000 : 120_000
    const response = await waitFor((m) => m.id === promptId, promptTimeout)
    if (response.error) {
      throw new Error(`session/prompt failed: ${response.error.message}`)
    }
    const stopReason = response.result?.stopReason
    const updates = inbox.filter(
      (m) =>
        m.method === 'session/update' &&
        (m.params as { sessionId?: string } | undefined)?.sessionId ===
          sessionId,
    )
    logLine('meta', {
      turn: turn + 1,
      stopReason,
      updateCount: updates.length,
    })

    if (cancelMs !== undefined && turn === 0) {
      if (stopReason !== 'cancelled') {
        throw new Error(`Expected stopReason cancelled, got ${String(stopReason)}`)
      }
    } else if (live) {
      if (stopReason !== 'end_turn') {
        throw new Error(
          `Live free-mode expected end_turn, got ${String(stopReason)}`,
        )
      }
      const hasChunk = updates.some((m) => {
        const update = (m.params as { update?: { sessionUpdate?: string } })
          ?.update
        return update?.sessionUpdate === 'agent_message_chunk'
      })
      if (!hasChunk) {
        throw new Error('Live free-mode: no agent_message_chunk streamed')
      }
    } else if (stopReason !== 'end_turn' && stopReason !== 'refusal') {
      // Without live credentials a refusal is acceptable for protocol framing.
      throw new Error(`Unexpected stopReason: ${String(stopReason)}`)
    }
  }

  exitCode = 0
  logLine('meta', { ok: true, live, pid: child.pid })
} catch (error) {
  logLine('meta', { ok: false, error: String(error) })
  process.stderr.write(`Harness failed: ${String(error)}\n`)
  exitCode = 1
} finally {
  fs.writeFileSync(
    transcriptPath,
    transcript.map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  )
  process.stderr.write(`Transcript: ${transcriptPath}\n`)
  child.stdin.end()
  // Allow release-on-stdin-close; force kill if hung.
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        killTree()
        resolve()
      }, 5_000),
    ),
  ])
  // Orphan check: child should be gone.
  if (child.exitCode === null && child.signalCode === null) {
    process.stderr.write('Warning: child still running after harness teardown\n')
    killTree()
    exitCode = 1
  }
}

process.exit(exitCode)
