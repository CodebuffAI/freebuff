import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { ChildProcess } from 'child_process'

import {
  stripAnsi,
  truncateStringWithMessage,
} from '../../../common/src/util/string'
import { getSystemProcessEnv } from '../env'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'

const COMMAND_OUTPUT_LIMIT = 50_000
// Grace period between SIGTERM and SIGKILL for commands that trap or ignore
// SIGTERM.
const KILL_ESCALATION_MS = 1500

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
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

// Children are spawned detached on POSIX (own process group) so that abort and
// timeout can kill the whole tree. That also detaches them from this process's
// lifetime, so sweep any still-running children when this process exits.
const liveChildren = new Set<ChildProcess>()
let exitSweepInstalled = false
function installExitSweep() {
  if (exitSweepInstalled) return
  exitSweepInstalled = true
  process.on('exit', () => {
    for (const child of liveChildren) {
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
const WSL_BASH_PATH_PATTERNS = [
  'system32',
  'windowsapps',
]

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
    const isWslPath = WSL_BASH_PATH_PATTERNS.some(pattern => dirLower.includes(pattern))
    
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
      // Use a plain-text sudo prompt so sudo doesn't emit ANSI color/cursor
      // sequences when asking for a password. Without this, sudo writes
      // decorated prompts to /dev/tty that can bleed into the TUI.
      SUDO_PROMPT: '[sudo] password: ',
      // Signal to child programs that this is a dumb non-interactive terminal
      // so they suppress color output and cursor-movement sequences.
      // (Only set if the caller hasn't explicitly overridden it.)
      ...((env ?? {}).TERM === undefined && { TERM: 'dumb' }),
    } as NodeJS.ProcessEnv

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
      // On POSIX, give the command its own process group so that killing it
      // (timeout or user abort) also kills any grandchild processes.
      detached: !isWindows,
      // On Windows, give the child its own invisible console (CREATE_NO_WINDOW)
      // instead of attaching it to the TUI's console. Console-attached
      // descendants can open CONIN$/CONOUT$ directly (cmd, pause, choice,
      // PSReadLine, ...) even when stdio is piped, stealing the VT input that
      // ConPTY generates for the TUI's mouse/focus tracking and echoing it as
      // gibberish like `^[[I^[[<35;12;7M` painted over the UI.
      windowsHide: true,
    })

    liveChildren.add(childProcess)
    installExitSweep()

    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | null = null
    let sigkillTimer: NodeJS.Timeout | null = null
    let processFinished = false

    const killChildProcess = () => {
      killProcessGroup(childProcess, 'SIGTERM')
      // Escalate in case the command traps or ignores SIGTERM.
      sigkillTimer = setTimeout(() => {
        sigkillTimer = null
        if (childProcess.exitCode === null && childProcess.signalCode === null) {
          killProcessGroup(childProcess, 'SIGKILL')
        }
      }, KILL_ESCALATION_MS)
      sigkillTimer.unref?.()
    }

    const truncateOutput = (str: string) =>
      truncateStringWithMessage({
        // Strip all ANSI/VT escape sequences (not just color codes) so that
        // cursor-movement, scroll-region, alternate-screen and other control
        // sequences emitted by sudo and interactive programs don't bleed into
        // the TUI and corrupt its scroll state or render garbage characters.
        // Also normalise bare \r that sudo uses to overwrite its prompt line.
        str: stripAnsi(str).replace(/\r/g, ''),
        maxLength: COMMAND_OUTPUT_LIMIT,
        remove: 'MIDDLE',
      })

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
            stdout: truncateOutput(stdout),
            ...(stderr ? { stderr: truncateOutput(stderr) } : {}),
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
      stdout += data.toString()
    })

    // Collect stderr
    childProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // Handle process completion
    childProcess.on('close', (exitCode) => {
      liveChildren.delete(childProcess)
      if (sigkillTimer) {
        clearTimeout(sigkillTimer)
        sigkillTimer = null
      }

      if (processFinished) return
      processFinished = true

      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)

      // Truncate stdout to prevent excessive output
      const truncatedStdout = truncateOutput(stdout)
      const truncatedStderr = truncateOutput(stderr)

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
