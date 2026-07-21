import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { ChildProcess } from 'child_process'

import { stripColors } from '../../../common/src/util/string'
import { getSystemProcessEnv } from '../env'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'

const COMMAND_OUTPUT_LIMIT = 50_000
const TRUNCATION_MARKER = '\n[...TRUNCATED DUE TO LENGTH...]\n'
const MAX_PENDING_COLOR_SEQUENCE_LENGTH = 32
const INCOMPLETE_COLOR_SEQUENCE_REGEX = /\x1B\[[0-9;]*$/
// Grace period between SIGTERM and SIGKILL for commands that trap or ignore
// SIGTERM.
const KILL_ESCALATION_MS = 1500

/**
 * Retains a bounded prefix and suffix while continuing to drain a child
 * process's output. This keeps noisy commands from growing the CLI process to
 * multiple gigabytes before the result is truncated.
 */
export class BoundedOutputBuffer {
  private head = ''
  private tail = ''
  private truncated = false
  private pendingColorSequence = ''
  private readonly headLimit: number
  private readonly tailLimit: number

  constructor(private readonly maxLength: number) {
    if (maxLength < TRUNCATION_MARKER.length) {
      throw new Error('Output limit must fit the truncation marker')
    }
    const retainedLength = Math.max(0, maxLength - TRUNCATION_MARKER.length)
    this.headLimit = Math.ceil(retainedLength / 2)
    this.tailLimit = Math.floor(retainedLength / 2)
  }

  append(value: string): void {
    if (!value) return

    let normalized = this.pendingColorSequence + value
    this.pendingColorSequence = ''
    const incompleteColorSequence = normalized.match(
      INCOMPLETE_COLOR_SEQUENCE_REGEX,
    )?.[0]
    if (
      incompleteColorSequence &&
      incompleteColorSequence.length <= MAX_PENDING_COLOR_SEQUENCE_LENGTH
    ) {
      this.pendingColorSequence = incompleteColorSequence
      normalized = normalized.slice(0, -incompleteColorSequence.length)
    }
    normalized = stripColors(normalized)
    if (!normalized) return

    if (!this.truncated) {
      const combined = this.head + normalized
      if (combined.length <= this.maxLength) {
        this.head = combined
        return
      }

      this.truncated = true
      this.head = combined.slice(0, this.headLimit)
      this.tail = this.tailLimit === 0 ? '' : combined.slice(-this.tailLimit)
      return
    }

    this.tail =
      this.tailLimit === 0
        ? ''
        : (this.tail + normalized).slice(-this.tailLimit)
  }

  get retainedLength(): number {
    return this.head.length + this.tail.length
  }

  format(): string {
    if (!this.truncated) {
      return this.head
    }
    return this.head + TRUNCATION_MARKER + this.tail
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  // SAFETY: Never kill our own process. If a child somehow has the same pid
  // as this process (e.g. pid reuse race, or the child ran a command that
  // reports the parent's pid), skip it to prevent self-kill which would
  // leave the terminal buffer unflushed and cause ASCII/UTF-8 decoding errors.
  if (child.pid === process.pid) {
    return
  }

  if (os.platform() === 'win32' && child.pid) {
    // Node's child.kill() only terminates the direct process on Windows. Since
    // the direct process is Git Bash, killing it first can orphan Bun/Node
    // grandchildren before the later SIGKILL escalation has a tree to find.
    // taskkill snapshots and force-terminates the complete descendant tree.
    const result = spawnSync(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000,
      },
    )
    if (!result.error && result.status === 0) return
  }

  if (os.platform() !== 'win32' && child.pid) {
    try {
      // Negative pid signals the whole process group.
      process.kill(-child.pid, signal)
      return
    } catch {
      // Process group may already be gone; fall back to a direct kill.
    }
  }
  try {
    child.kill(signal)
  } catch {}
}

function isProcessGroupAlive(child: ChildProcess): boolean {
  if (os.platform() === 'win32' || !child.pid) {
    return child.exitCode === null && child.signalCode === null
  }
  try {
    // Signal 0 checks for any remaining member without changing its state.
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

// Children are spawned detached on POSIX (own process group) so that abort and
// timeout can kill the whole tree. That also detaches them from this process's
// lifetime, so sweep any still-running children when this process exits.
const liveChildren = new Set<ChildProcess>()
let exitSweepInstalled = false

export type ActiveTerminalCommandProcess = {
  pid: number
  processGroupId?: number
}

/**
 * Return the process IDs owned by in-flight terminal tools. Commands are
 * started in their own process group on POSIX, where the group ID matches the
 * child PID. No command text or environment is exposed: diagnostics are often
 * pasted into bug reports and those values may contain secrets.
 */
export function getActiveTerminalCommandProcesses(): ActiveTerminalCommandProcess[] {
  return Array.from(liveChildren).flatMap((child) => {
    if (!child.pid) return []
    return [
      {
        pid: child.pid,
        ...(os.platform() === 'win32' ? {} : { processGroupId: child.pid }),
      },
    ]
  })
}

function installExitSweep() {
  if (exitSweepInstalled) return
  exitSweepInstalled = true
  process.on('exit', () => {
    for (const child of liveChildren) {
      // SAFETY: Never kill our own process in the exit sweep. liveChildren
      // should never contain process.pid, but guard defensively to prevent
      // the self-kill scenario that would leave the terminal buffer unflushed.
      if (child.pid === process.pid) continue
      killProcessGroup(child, 'SIGKILL')
    }
  })
}

// Common locations where Git Bash might be installed on Windows
const GIT_BASH_COMMON_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
]

// WSL bash paths that are often unreliable (VM may not be running, quote escaping issues)
// These are checked last as a fallback only
const WSL_BASH_PATH_PATTERNS = ['system32', 'windowsapps']

/**
 * Find bash executable on Windows.
 * Priority:
 * 1. CODEBUFF_GIT_BASH_PATH environment variable (user override)
 * 2. Common Git Bash installation locations (most reliable)
 * 3. Non-WSL bash in PATH (e.g., Git Bash added to PATH)
 * 4. WSL bash in PATH (last resort - System32, WindowsApps)
 *
 * WSL bash is deprioritized because it can fail with cryptic errors when:
 * - The WSL VM is not running
 * - Quote/argument escaping issues between Windows and Linux
 * - UTF-16 encoding mismatches
 */
function findWindowsBash(env: NodeJS.ProcessEnv): string | null {
  // Check for user-specified path via environment variable
  const customPath = env.CODEBUFF_GIT_BASH_PATH
  if (customPath && fs.existsSync(customPath)) {
    return customPath
  }

  // Check common Git Bash installation locations first (most reliable)
  for (const commonPath of GIT_BASH_COMMON_PATHS) {
    if (fs.existsSync(commonPath)) {
      return commonPath
    }
  }

  // Fall back to bash.exe in PATH, but skip WSL paths initially
  const pathEnv = env.PATH || env.Path || ''
  const pathDirs = pathEnv.split(path.delimiter)
  const wslFallbackPaths: string[] = []

  for (const dir of pathDirs) {
    const dirLower = dir.toLowerCase()
    const isWslPath = WSL_BASH_PATH_PATTERNS.some((pattern) =>
      dirLower.includes(pattern),
    )

    const bashPath = path.join(dir, 'bash.exe')
    if (fs.existsSync(bashPath)) {
      if (isWslPath) {
        // Save WSL paths for last resort
        wslFallbackPaths.push(bashPath)
      } else {
        // Non-WSL bash in PATH (e.g., Git Bash added to PATH)
        return bashPath
      }
    }

    // Also check for just 'bash' (without .exe)
    const bashPathNoExt = path.join(dir, 'bash')
    if (fs.existsSync(bashPathNoExt)) {
      if (isWslPath) {
        wslFallbackPaths.push(bashPathNoExt)
      } else {
        return bashPathNoExt
      }
    }
  }

  // Last resort: use WSL bash if nothing else is available
  // WSL can be unreliable (VM not running, quote escaping issues, UTF-16 encoding)
  if (wslFallbackPaths.length > 0) {
    return wslFallbackPaths[0]
  }

  return null
}

/**
 * Create an error message for Windows users when bash is not available.
 */
function createWindowsBashNotFoundError(): Error {
  return new Error(
    `Bash is required but was not found on this Windows system.

To fix this, you have several options:

1. Install Git for Windows (includes bash.exe):
   Download from: https://git-scm.com/download/win

2. Use WSL (Windows Subsystem for Linux):
   Run in PowerShell (Admin): wsl --install
   Then run Codebuff inside WSL.

3. Set a custom bash path:
   Set the CODEBUFF_GIT_BASH_PATH environment variable to your bash.exe location.
   Example: set CODEBUFF_GIT_BASH_PATH=C:\\path\\to\\bash.exe`,
  )
}

export function runTerminalCommand({
  command,
  process_type,
  cwd,
  timeout_seconds,
  env,
  signal,
}: {
  command: string
  process_type: 'SYNC' | 'BACKGROUND'
  cwd: string
  timeout_seconds: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<CodebuffToolOutput<'run_terminal_command'>> {
  if (process_type === 'BACKGROUND') {
    throw new Error('BACKGROUND process_type not implemented')
  }

  return new Promise((resolve, reject) => {
    const isWindows = os.platform() === 'win32'
    const processEnv = {
      ...getSystemProcessEnv(),
      ...(env ?? {}),
    } as NodeJS.ProcessEnv
    if (isWindows) {
      // Preserve other MSYS options while preventing Git Bash descendants from
      // allocating a ConPTY despite the detached/hidden process flags.
      processEnv.MSYS = [processEnv.MSYS, 'disable_pcon']
        .filter(Boolean)
        .join(' ')
    }

    if (signal?.aborted) {
      resolve([
        {
          type: 'json',
          value: {
            command,
            message: 'Command cancelled: the run was aborted by the user.',
          },
        },
      ])
      return
    }

    let shell: string
    let shellArgs: string[]

    if (isWindows) {
      const bashPath = findWindowsBash(processEnv)
      if (!bashPath) {
        reject(createWindowsBashNotFoundError())
        return
      }
      shell = bashPath
      shellArgs = ['-c']
    } else {
      shell = 'bash'
      shellArgs = ['-c']
    }

    // Resolve cwd to absolute path
    const resolvedCwd = path.resolve(cwd)

    const childProcess = spawn(shell, [...shellArgs, command], {
      cwd: resolvedCwd,
      env: processEnv,
      stdio: 'pipe',
      // Give the command its own process group so that killing it (timeout or
      // user abort) also kills any grandchild processes. On POSIX this uses a
      // negative pid kill against the process group. On Windows `detached: true`
      // maps to DETACHED_PROCESS, which combined with CREATE_NO_WINDOW (from
      // windowsHide) fully detaches the child from the parent's console.
      // Without DETACHED_PROCESS, console-attached descendants can open
      // CONIN$/CONOUT$ directly even when stdio is piped, stealing the VT input
      // that ConPTY generates for the TUI's mouse/focus tracking and echoing it
      // as gibberish like `^[[I^[[<35;12;7M` painted over the UI.
      detached: true,
      windowsHide: true,
    })

    liveChildren.add(childProcess)
    installExitSweep()

    const stdout = new BoundedOutputBuffer(COMMAND_OUTPUT_LIMIT)
    const stderr = new BoundedOutputBuffer(COMMAND_OUTPUT_LIMIT)
    let timer: NodeJS.Timeout | null = null
    let sigkillTimer: NodeJS.Timeout | null = null
    let processFinished = false

    const killChildProcess = () => {
      killProcessGroup(childProcess, 'SIGTERM')
      // Escalate in case the command traps or ignores SIGTERM.
      sigkillTimer = setTimeout(() => {
        sigkillTimer = null
        if (isProcessGroupAlive(childProcess)) {
          killProcessGroup(childProcess, 'SIGKILL')
        }
        liveChildren.delete(childProcess)
      }, KILL_ESCALATION_MS)
      sigkillTimer.unref?.()
    }

    const onAbort = () => {
      if (processFinished) return
      processFinished = true

      if (timer) {
        clearTimeout(timer)
      }
      killChildProcess()

      resolve([
        {
          type: 'json',
          value: {
            command,
            stdout: stdout.format(),
            ...(stderr.retainedLength > 0 ? { stderr: stderr.format() } : {}),
            message:
              'Command interrupted: the run was aborted by the user and the process was killed before it completed.',
          },
        },
      ])

      // The result is already settled; stop buffering output from a child
      // that may linger through the SIGTERM grace period.
      childProcess.stdout.destroy()
      childProcess.stderr.destroy()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // Set up timeout if timeout_seconds >= 0 (infinite timeout when < 0)
    if (timeout_seconds >= 0) {
      timer = setTimeout(() => {
        if (!processFinished) {
          processFinished = true
          signal?.removeEventListener('abort', onAbort)
          killChildProcess()
          reject(
            new Error(`Command timed out after ${timeout_seconds} seconds`),
          )
        }
      }, timeout_seconds * 1000)
    }

    // Collect stdout
    childProcess.stdout.on('data', (data: Buffer) => {
      stdout.append(data.toString())
    })

    // Collect stderr
    childProcess.stderr.on('data', (data: Buffer) => {
      stderr.append(data.toString())
    })

    // Handle process completion
    childProcess.on('close', (exitCode) => {
      if (sigkillTimer) {
        // The shell can exit while a grandchild ignores SIGTERM. Keep both the
        // registry entry and escalation timer in that case so the process
        // group is still visible to diagnostics and receives SIGKILL.
        if (!isProcessGroupAlive(childProcess)) {
          clearTimeout(sigkillTimer)
          sigkillTimer = null
          liveChildren.delete(childProcess)
        }
      } else {
        liveChildren.delete(childProcess)
      }

      if (processFinished) return
      processFinished = true

      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)

      // Truncate stdout to prevent excessive output
      const truncatedStdout = stdout.format()
      const truncatedStderr = stderr.format()

      // Include stderr in stdout for compatibility with existing behavior
      const combinedOutput = {
        command,
        stdout: truncatedStdout,
        ...(truncatedStderr ? { stderr: truncatedStderr } : {}),
        ...(exitCode !== null ? { exitCode } : {}),
      }

      resolve([{ type: 'json', value: combinedOutput }])
    })

    // Handle spawn errors
    childProcess.on('error', (error) => {
      liveChildren.delete(childProcess)

      if (processFinished) return
      processFinished = true

      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)

      reject(new Error(`Failed to spawn command: ${error.message}`))
    })
  })
}
