import { spawn, spawnSync } from 'child_process'
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import type {
  TerminalCommandBroker,
  TerminalCommandProcess,
  TerminalCommandSpawnRequest,
} from '@codebuff/sdk'
import type { ChildProcess } from 'child_process'

import { getCliEnv, getSystemProcessEnv } from './env'
import { trackHelperProcess } from './helper-process-telemetry'
import { reportWindowsTerminalFailure } from './windows-terminal-health'

export const TERMINAL_COMMAND_BROKER_FLAG = '--terminal-command-broker'
const TERMINAL_COMMAND_BROKER_ENV = 'CODEBUFF_TERMINAL_COMMAND_BROKER'
const TERMINAL_COMMAND_BROKER_PROTOCOL_ENV =
  'CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL'

const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_PROTOCOL_BYTES = 64 * 1024
const PROTOCOL_FILE_PREFIX = 'freebuff-terminal-command-broker-'
const TERMINAL_COMMAND_BROKER_RECOVERY = 'Restart Freebuff and try again.'
const PROTOCOL_READ_RETRY_MS = 50
const PROTOCOL_READ_ATTEMPTS = 5
const MAX_BROKER_STDERR_TAIL_BYTES = 4 * 1024
// Cross-process contract: the detached broker emits this marker on stderr
// before reaping itself so the parent can surface the write failure reason.
const BROKER_STDERR_MARKER = '[freebuff-broker] protocol write failed:'
// The marker must be flushed before the broker SIGKILLs its own process group,
// but never at the cost of holding the shell tree open indefinitely.
const BROKER_STDERR_FLUSH_TIMEOUT_MS = 200

export type TerminalBrokerFailureStage = 'spawn' | 'stdio' | 'completion'
export type TerminalBrokerFailureCode =
  | 'failed_to_connect'
  | 'enoent'
  | 'eacces'
  | 'eperm'
  | 'epipe'
  | 'invalid_response'
  | 'protocol_missing'
  | 'protocol_write_failed'
  | 'response_too_large'
  | 'unknown'

export type TerminalBrokerFailureTelemetry = {
  stage: TerminalBrokerFailureStage
  failureCode: TerminalBrokerFailureCode
}

type BrokerProtocol =
  | { ok: true; exitCode: number | null }
  | { ok: false; error: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function classifyTerminalBrokerFailure(
  error: unknown,
): TerminalBrokerFailureCode {
  const rawCode =
    error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '').toUpperCase()
      : ''
  if (rawCode === 'ENOENT') return 'enoent'
  if (rawCode === 'EACCES') return 'eacces'
  if (rawCode === 'EPERM') return 'eperm'
  if (rawCode === 'EPIPE') return 'epipe'

  const message = errorMessage(error).toLowerCase()
  if (message.includes('failed to connect')) return 'failed_to_connect'
  if (message.includes('invalid response')) return 'invalid_response'
  if (message.includes(BROKER_STDERR_MARKER)) return 'protocol_write_failed'
  if (message.includes('protocol response was missing')) {
    return 'protocol_missing'
  }
  if (message.includes('response was too large')) return 'response_too_large'
  return 'unknown'
}

function reportTerminalBrokerFailure({
  stage,
  failureCode,
}: TerminalBrokerFailureTelemetry): void {
  reportWindowsTerminalFailure(AnalyticsEvent.TERMINAL_BROKER_SPAWN_FAILED, {
    stage,
    failureCode,
  })
}

function brokerFailure(error: unknown): Error {
  const message = errorMessage(error)
  return new Error(
    message.includes(TERMINAL_COMMAND_BROKER_RECOVERY)
      ? message
      : `${message}\n\n${TERMINAL_COMMAND_BROKER_RECOVERY}`,
  )
}

export function isTerminalCommandBrokerInvocation(
  argv: string[],
  env: NodeJS.ProcessEnv = getSystemProcessEnv(),
): boolean {
  const brokerFlagIndex = argv.indexOf(TERMINAL_COMMAND_BROKER_FLAG)
  const endOfOptionsIndex = argv.indexOf('--')
  return (
    env[TERMINAL_COMMAND_BROKER_ENV] === '1' &&
    brokerFlagIndex !== -1 &&
    (endOfOptionsIndex === -1 || brokerFlagIndex < endOfOptionsIndex)
  )
}

function isSpawnRequest(value: unknown): value is TerminalCommandSpawnRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<TerminalCommandSpawnRequest>
  return (
    typeof request.executable === 'string' &&
    request.executable.length > 0 &&
    Array.isArray(request.args) &&
    request.args.every((arg) => typeof arg === 'string') &&
    typeof request.cwd === 'string' &&
    request.cwd.length > 0 &&
    Boolean(request.env) &&
    typeof request.env === 'object' &&
    !Array.isArray(request.env) &&
    Object.values(request.env).every((value) => typeof value === 'string')
  )
}

/**
 * Compare the protocol directory after resolving symlinks and Windows casing:
 * a raw string compare rejects the parent's own path when the temp dir is
 * reached through a link (macOS `/var` -> `/private/var`) or a differently
 * cased spelling.
 */
function normalizeProtocolDirectory(directory: string): string {
  let resolved = path.resolve(directory)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // The directory may not exist yet; the raw resolution stays comparable.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function protocolPathFromEnv(
  env: NodeJS.ProcessEnv = getSystemProcessEnv(),
): string {
  const protocolPath = env[TERMINAL_COMMAND_BROKER_PROTOCOL_ENV]
  if (!protocolPath) {
    throw new Error('terminal command broker protocol path was invalid')
  }

  const resolvedProtocolPath = path.resolve(protocolPath)
  if (
    normalizeProtocolDirectory(path.dirname(resolvedProtocolPath)) !==
      normalizeProtocolDirectory(os.tmpdir()) ||
    !path.basename(resolvedProtocolPath).startsWith(PROTOCOL_FILE_PREFIX)
  ) {
    throw new Error('terminal command broker protocol path was invalid')
  }
  return resolvedProtocolPath
}

function createProtocolPath(): string {
  return path.join(
    os.tmpdir(),
    `${PROTOCOL_FILE_PREFIX}${process.pid}-${crypto.randomUUID()}.json`,
  )
}

function removeProtocolFile(protocolPath: string): void {
  try {
    rmSync(protocolPath, { force: true })
  } catch {
    // Windows antivirus and indexers can briefly hold a closed temp file open.
    // Protocol cleanup must never replace the command's real result with EPERM.
  }
}

function writeProtocol(message: BrokerProtocol): void {
  const payload = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(payload) > MAX_PROTOCOL_BYTES) {
    throw new Error('terminal command broker response was too large')
  }
  // A constrained one-shot file avoids Bun's unreliable custom stdio pipes on
  // Windows. `wx` ensures even an accidentally reused path is never replaced.
  // Only the validated path is written: an unvalidated fallback would let a
  // corrupted environment place the protocol file outside the temp directory,
  // and a rejected path now surfaces on stderr instead of losing the response.
  writeFileSync(protocolPathFromEnv(), payload, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
}

function waitForParentDisconnect(): Promise<void> {
  const parentPid = process.ppid
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearInterval(parentPoll)
      resolve()
    }
    const parentIsAlive = () => {
      if (process.ppid !== parentPid) return false
      try {
        process.kill(parentPid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    // Polling avoids another custom stdio pipe. Bun's Windows implementation
    // has produced unhandled `Failed to connect` rejections while opening those
    // extra channels, which terminated the whole interactive CLI.
    const parentPoll = setInterval(() => {
      if (!parentIsAlive()) finish()
    }, 100)
  })
}

async function reapOwnProcessGroup(): Promise<never> {
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/pid', String(process.pid), '/t', '/f'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    killer.unref()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    process.exit(1)
  }
  try {
    process.kill(-process.pid, 'SIGKILL')
  } catch {
    process.exit(1)
  }
  process.exit(1)
}

async function readRequest(): Promise<TerminalCommandSpawnRequest> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new Error('terminal command broker request exceeded 4 MiB')
    }
    chunks.push(buffer)
  }

  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isSpawnRequest(value)) {
    throw new Error('terminal command broker received an invalid request')
  }
  return value
}

/**
 * Deliver the write-failure marker before the detached broker kills its own
 * process group. `process.stderr` is an asynchronous pipe on POSIX, so without
 * waiting for the write callback the reason can be lost with the process; the
 * wait is bounded so shell-tree containment never stalls behind it.
 */
function flushBrokerStderrMarker(error: unknown): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(finish, BROKER_STDERR_FLUSH_TIMEOUT_MS)
    try {
      process.stderr.write(
        `\n${BROKER_STDERR_MARKER} ${errorMessage(error)}\n`,
        finish,
      )
    } catch {
      // The pipe may already be gone; the parent still sees the missing file.
      finish()
    }
  })
}

/** Run inside the detached helper process. It never initializes OpenTUI. */
export async function serveTerminalCommandBroker(): Promise<void> {
  const parentDisconnected = waitForParentDisconnect()
  const commandResult = (async (): Promise<BrokerProtocol> => {
    try {
      const request = await readRequest()
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        // Commands are non-interactive. Their output is relayed through the
        // broker, while stdin is EOF and no console handle exists to inherit.
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: false,
        windowsHide: true,
      })
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      return { ok: true, exitCode }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })()

  const outcome = await Promise.race([
    commandResult.then((message) => ({ kind: 'result', message }) as const),
    parentDisconnected.then(() => ({ kind: 'parent-disconnected' }) as const),
  ])
  if (outcome.kind === 'parent-disconnected') return reapOwnProcessGroup()

  try {
    writeProtocol(outcome.message)
  } catch (error) {
    // Never vanish silently: relay the write failure on stderr so the parent
    // can explain the missing protocol instead of a generic ENOENT message.
    await flushBrokerStderrMarker(error)
    // Reap here explicitly: a failed write must not leave the detached shell
    // tree alive any longer than a successful one.
    return reapOwnProcessGroup()
  }

  // Normal cleanup belongs to this detached process. In particular, Windows
  // taskkill must not block the parent CLI's renderer thread after every
  // successful command.
  await reapOwnProcessGroup()
}

function parseProtocol(value: string): BrokerProtocol {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed)) {
    throw new Error('terminal command broker returned an invalid response')
  }
  if (
    parsed.ok === true &&
    'exitCode' in parsed &&
    (typeof parsed.exitCode === 'number' || parsed.exitCode === null)
  ) {
    return { ok: true, exitCode: parsed.exitCode }
  }
  if (
    parsed.ok === false &&
    'error' in parsed &&
    typeof parsed.error === 'string'
  ) {
    return { ok: false, error: parsed.error }
  }
  throw new Error('terminal command broker returned an invalid response')
}

function terminateProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

function isProcessGroupAlive(child: ChildProcess): boolean {
  if (!child.pid) return false
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null
  }
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

function defaultBrokerInvocation(): {
  executable: string
  args: string[]
} {
  return {
    executable: process.execPath,
    args:
      getCliEnv().CODEBUFF_IS_BINARY === 'true'
        ? [TERMINAL_COMMAND_BROKER_FLAG]
        : [
            path.join(import.meta.dir, '..', 'entry.ts'),
            TERMINAL_COMMAND_BROKER_FLAG,
          ],
  }
}

export function createTerminalCommandBroker({
  invocation = defaultBrokerInvocation,
  terminate = terminateProcessGroup,
  reportFailure = reportTerminalBrokerFailure,
}: {
  invocation?: () => { executable: string; args: string[] }
  terminate?: typeof terminateProcessGroup
  reportFailure?: (failure: TerminalBrokerFailureTelemetry) => void
} = {}): TerminalCommandBroker {
  const report = (stage: TerminalBrokerFailureStage, error: unknown): void => {
    try {
      reportFailure({
        stage,
        failureCode: classifyTerminalBrokerFailure(error),
      })
    } catch {
      // An injected or future reporter must never replace the broker failure.
    }
  }

  return {
    start(request): TerminalCommandProcess {
      let child: ChildProcess
      let terminationRequested = false
      const protocolPath = createProtocolPath()
      try {
        const { executable, args } = invocation()
        child = spawn(executable, args, {
          env: {
            ...getSystemProcessEnv(),
            [TERMINAL_COMMAND_BROKER_ENV]: '1',
            [TERMINAL_COMMAND_BROKER_PROTOCOL_ENV]: protocolPath,
          },
          // Do not add custom fd 3/4 pipes here. On Windows, Bun establishes
          // each pipe through node:net and can reject that handshake outside
          // ChildProcess's error event, crashing the CLI as an unhandled
          // rejection. Standard stdin/stdout/stderr are sufficient: the spawn
          // request uses stdin and the result uses the one-shot protocol file.
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        })
      } catch (error) {
        report('spawn', error)
        removeProtocolFile(protocolPath)
        throw brokerFailure(error)
      }
      // Bun can return a child with null pipes for ENOENT, then emit the spawn
      // error asynchronously. Always observe it, including the synchronous
      // validation-failure path below, so a missing helper cannot crash the CLI.
      child.once('error', () => {})
      trackHelperProcess('terminal_command', child)
      if (!child.stdin || !child.stdout || !child.stderr) {
        terminate(child, 'SIGKILL')
        removeProtocolFile(protocolPath)
        const error = new Error('could not open terminal command broker pipes')
        report('stdio', error)
        throw brokerFailure(error)
      }

      // Cancellation can close the broker while this small request is still
      // flushing. The process completion path reports real startup failures;
      // keep a late EPIPE from becoming an unrelated uncaught exception.
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(request))

      // The broker writes the one-shot file immediately before its own exit,
      // but close can still edge ahead on some filesystems (tmpfs, AV). ENOENT
      // is retried, and a bounded stderr tail explains an unrecoverable miss.
      let brokerStderrTail = ''
      child.stderr.on('data', (chunk: Buffer) => {
        const next = brokerStderrTail + chunk.toString('utf8')
        brokerStderrTail =
          next.length > MAX_BROKER_STDERR_TAIL_BYTES
            ? next.slice(next.length - MAX_BROKER_STDERR_TAIL_BYTES)
            : next
      })

      const closed = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', () => resolve())
      })

      const readProtocol = async (): Promise<BrokerProtocol> => {
        for (let attempt = 0; attempt < PROTOCOL_READ_ATTEMPTS; attempt++) {
          try {
            const payload = readFileSync(protocolPath)
            if (payload.byteLength > MAX_PROTOCOL_BYTES) {
              throw new Error('terminal command broker response was too large')
            }
            return parseProtocol(payload.toString('utf8').trim())
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            if (attempt < PROTOCOL_READ_ATTEMPTS - 1) {
              await new Promise((resolve) =>
                setTimeout(resolve, PROTOCOL_READ_RETRY_MS),
              )
            }
          }
        }
        const tail = brokerStderrTail.trim()
        throw new Error(
          tail
            ? `terminal command broker protocol response was missing\nBroker stderr: ${tail}`
            : 'terminal command broker protocol response was missing',
        )
      }

      const completion = closed
        .then(readProtocol)
        .catch((error) => {
          if (!terminationRequested) report('completion', error)
          throw brokerFailure(error)
        })
        .then((message) => {
          if (!message.ok) throw new Error(message.error)
          return message.exitCode
        })
        .finally(() => removeProtocolFile(protocolPath))

      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        completion,
        kill: (signal) => {
          terminationRequested = true
          terminate(child, signal)
        },
        isAlive: () => isProcessGroupAlive(child),
      }
    },
  }
}

export const terminalCommandBroker = createTerminalCommandBroker()
