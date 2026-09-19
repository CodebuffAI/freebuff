/** Optional local transport for Everest shell-output compression.
 * Terminal execution always finishes through Freebuff's own SDK and broker
 * before this module sees a result. No terminal command is run here.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'

export const EVEREST_FOCUS_INSTRUCTION = `
When calling run_terminal_command, put exactly one standalone comment on the
first line: # coact-focus: <the specific evidence needed next>. Keep the focus
narrow and preserve identifiers, paths, and diagnostic details. Use
# coact-focus: raw when exact complete output is needed. When Everest
compression is enabled, eligible terminal output is sent to Everest.
`

type BridgeResponse = {
  id: number
  text: string
  applied: boolean
  reason: string
}
type Request = (
  command: string,
  output: string,
  goal: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>
type Part = { type: string; value?: unknown }

const MIN_OUTPUT_CHARS = 2048
// Everest's installed gateway allows a 120-second cold-start retry.
const REQUEST_TIMEOUT_MS = 125_000
const FOCUS = /^# coact-focus: (\S.*)$/

export function isEligibleEverestCommand(
  command: string,
  output: string,
): boolean {
  const focus = FOCUS.exec(command.split(/\r?\n/, 1)[0] ?? '')?.[1]
  return Boolean(
    focus &&
    !['raw', 'verbatim', 'uncompressed', 'full output'].includes(
      focus.trim().toLowerCase(),
    ) &&
    output.length >= MIN_OUTPUT_CHARS,
  )
}

export class EverestBridge {
  private child: ReturnType<typeof spawn>
  private nextId = 1
  private pending = new Map<
    number,
    {
      original: string
      resolve: (text: string) => void
      reject: () => void
      timer: NodeJS.Timeout
      cleanup: () => void
    }
  >()
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  constructor(
    command = 'everest',
    args = ['freebuff-bridge'],
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = readline.createInterface({ input: this.child.stdout! })
    lines.on('line', (line) => this.receive(line))
    this.child.on('error', () => this.close())
    this.child.on('exit', () => this.close())
  }

  request(
    command: string,
    output: string,
    goal: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.closed) return Promise.reject(new Error('everest_unavailable'))
    if (signal?.aborted) return Promise.reject(new Error('everest_unavailable'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('everest_unavailable'))
      const onAbort = () => this.close()
      signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        fail()
        this.close()
      }, this.timeoutMs)
      this.pending.set(id, {
        original: output,
        resolve,
        reject: fail,
        timer,
        cleanup,
      })
      this.child.stdin!.write(
        JSON.stringify({ id, command, output, goal, cwd }) + '\n',
        (error) => {
          if (!error) return
          const waiting = this.pending.get(id)
          if (!waiting) return
          clearTimeout(waiting.timer)
          waiting.cleanup()
          this.pending.delete(id)
          waiting.reject()
          this.close()
        },
      )
    })
  }

  private receive(line: string): void {
    let response: BridgeResponse
    try {
      response = JSON.parse(line) as BridgeResponse
    } catch {
      this.close()
      return
    }
    const waiting = this.pending.get(response.id)
    if (!waiting) {
      this.close()
      return
    }
    clearTimeout(waiting.timer)
    waiting.cleanup()
    this.pending.delete(response.id)
    if (
      typeof response.text !== 'string' ||
      response.text.length === 0 ||
      typeof response.applied !== 'boolean' ||
      typeof response.reason !== 'string' ||
      response.reason.length > 128
    ) {
      waiting.reject()
      this.close()
      return
    }
    waiting.resolve(response.applied ? response.text : waiting.original)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.cleanup()
      waiting.reject()
    }
    this.pending.clear()
    this.child.stdin?.end()
    this.child.kill()
  }
}

let bridge: EverestBridge | null = null

function requestCompression(
  command: string,
  output: string,
  goal: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!bridge || bridge.isClosed) bridge = new EverestBridge()
  return bridge.request(command, output, goal, cwd, signal)
}

export function closeEverestBridge(): void {
  bridge?.close()
  bridge = null
}

/** Rewrite only completed stdout/stderr strings. All other SDK fields survive. */
export async function compressCompletedTerminalResult<T extends Part>(
  parts: T[],
  command: string,
  goal: string,
  cwd: string,
  request: Request = requestCompression,
  signal?: AbortSignal,
): Promise<T[]> {
  return Promise.all(
    parts.map(async (part) => {
      if (part.type !== 'json' || !part.value || typeof part.value !== 'object')
        return part
      const value = part.value as Record<string, unknown>
      // An interrupted command or a failed command needs its full diagnostics.
      if (
        typeof value.message === 'string' ||
        (typeof value.exitCode === 'number' && value.exitCode !== 0)
      ) {
        return part
      }
      let changed = false
      const rewritten = { ...value }
      for (const stream of ['stdout', 'stderr'] as const) {
        const original = value[stream]
        if (
          typeof original !== 'string' ||
          !isEligibleEverestCommand(command, original)
        )
          continue
        try {
          const text = await request(
            command,
            original,
            goal,
            path.resolve(cwd),
            signal,
          )
          if (typeof text !== 'string') continue
          rewritten[stream] = text
          changed ||= text !== original
        } catch {
          // Missing CLI, logout, timeout, or compressor failure leaves this stream intact.
        }
      }
      return changed ? { ...part, value: rewritten } : part
    }),
  )
}
