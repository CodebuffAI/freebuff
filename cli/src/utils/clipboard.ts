import { spawn } from 'child_process'
import { closeSync, openSync, writeSync } from 'fs'

import type { ChildProcess } from 'child_process'

import { getCliEnv } from './env'
import { trackHelperProcess } from './helper-process-telemetry'
import { logger } from './logger'

// Global renderer reference for clipboard operations.
// Registered once by the useClipboard hook so all callers of
// copyTextToClipboard automatically benefit from renderer-based
// OSC 52 without threading the renderer through every call site.
let registeredRenderer: Record<string, unknown> | null = null

export function registerClipboardRenderer(
  renderer: Record<string, unknown>,
): void {
  registeredRenderer = renderer
}

export function unregisterClipboardRenderer(): void {
  registeredRenderer = null
}

type ClipboardListener = (message: string | null) => void

let currentMessage: string | null = null
const listeners = new Set<ClipboardListener>()
let clearTimer: ReturnType<typeof setTimeout> | null = null

interface ShowMessageOptions {
  durationMs?: number
}

export function subscribeClipboardMessages(
  listener: ClipboardListener,
): () => void {
  listeners.add(listener)
  listener(currentMessage)
  return () => {
    listeners.delete(listener)
  }
}

function emitClipboardMessage(message: string | null) {
  currentMessage = message
  for (const listener of listeners) {
    listener(message)
  }
}

export function showClipboardMessage(
  message: string | null,
  options: ShowMessageOptions = {},
) {
  if (clearTimer) {
    clearTimeout(clearTimer)
    clearTimer = null
  }

  emitClipboardMessage(message)

  const duration = options.durationMs ?? 3000
  if (message && duration > 0) {
    clearTimer = setTimeout(() => {
      emitClipboardMessage(null)
      clearTimer = null
    }, duration)
  }
}

function getDefaultSuccessMessage(text: string): string | null {
  const preview = text.replace(/\s+/g, ' ').trim()
  if (!preview) {
    return null
  }
  const truncated = preview.length > 40 ? `${preview.slice(0, 37)}…` : preview
  return `Copied: "${truncated}"`
}

type ClipboardCandidate = {
  text: string
  successMessage?: string | null
}

let activeClipboardOperation: AbortController | null = null

export interface CopyToClipboardOptions {
  successMessage?: string | null
  errorMessage?: string | null
  durationMs?: number
  suppressGlobalMessage?: boolean
  getOsc52Fallback?: () => ClipboardCandidate
  signal?: AbortSignal
}

export async function copyTextToClipboard(
  text: string,
  {
    successMessage,
    errorMessage,
    durationMs,
    suppressGlobalMessage = false,
    getOsc52Fallback,
    signal,
  }: CopyToClipboardOptions = {},
) {
  if (!text || text.trim().length === 0) {
    return
  }

  throwIfClipboardAborted(signal)
  const operationController = new AbortController()
  activeClipboardOperation?.abort()
  activeClipboardOperation = operationController
  const operationSignal = signal
    ? AbortSignal.any([signal, operationController.signal])
    : operationController.signal

  const osc52Blocked = isOsc52Blocked()
  try {
    throwIfClipboardAborted(operationSignal)
    const tryOsc52 = (candidate: string) =>
      !osc52Blocked &&
      isWithinOsc52PayloadLimit(candidate) &&
      (tryCopyViaRenderer(candidate) || tryCopyViaTtyOsc52(candidate))

    const primary: ClipboardCandidate = { text, successMessage }
    const remoteSession = isRemoteSession()
    const tryCandidateViaOsc52 = (candidate: ClipboardCandidate) =>
      tryOsc52(candidate.text) ? candidate : null
    const tryFallbackViaOsc52 = () => {
      if (!getOsc52Fallback) return null
      const fallback = getOsc52Fallback()
      return fallback.text.trim() && fallback.text !== text
        ? tryCandidateViaOsc52(fallback)
        : null
    }

    // Remote sessions need OSC 52 to reach the client clipboard. Local
    // sessions prefer native tools because they survive tmux and have no cap.
    let copiedCandidate = remoteSession
      ? (tryCandidateViaOsc52(primary) ?? tryFallbackViaOsc52())
      : null

    if (
      !copiedCandidate &&
      (await tryCopyViaPlatformTool(text, operationSignal))
    ) {
      copiedCandidate = primary
    }
    // A local session that reaches this OSC 52 fallback had no working native
    // tool. OSC 52 is fire-and-forget: we cannot tell whether the terminal
    // honoured it, so on Linux (a Chromebook's Linux terminal ships with no
    // wl-copy or xclip) "Copied" alone can be a false claim — say how to fix it.
    let unverifiedLocalOsc52 = false
    if (!copiedCandidate && !remoteSession) {
      copiedCandidate = tryCandidateViaOsc52(primary) ?? tryFallbackViaOsc52()
      unverifiedLocalOsc52 =
        copiedCandidate !== null && process.platform === 'linux'
    }

    if (!copiedCandidate) {
      throw new Error('No clipboard method available')
    }

    if (!suppressGlobalMessage) {
      const message =
        copiedCandidate.successMessage !== undefined
          ? copiedCandidate.successMessage
          : getDefaultSuccessMessage(copiedCandidate.text)
      if (message) {
        showClipboardMessage(
          unverifiedLocalOsc52
            ? `${message} ${LINUX_OSC52_ONLY_HINT}`
            : message,
          {
            durationMs:
              durationMs ?? (unverifiedLocalOsc52 ? 6000 : undefined),
          },
        )
      }
    }
  } catch (error) {
    if (operationSignal.aborted) throw error
    logger.error(error, 'Failed to copy to clipboard')
    // When the terminal drops OSC 52 and no platform tool exists (e.g.
    // Codespaces), the Shift+drag guidance is the only way the user can copy,
    // so show it even for callers that suppress routine messages.
    if (!suppressGlobalMessage || osc52Blocked) {
      const isLinux = process.platform === 'linux'
      const defaultErrorMessage = isLinux
        ? LINUX_CLIPBOARD_ERROR_MESSAGE
        : 'Failed to copy to clipboard'
      showClipboardMessage(
        osc52Blocked
          ? OSC52_BLOCKED_MESSAGE
          : (errorMessage ?? defaultErrorMessage),
        // Give the longer guidance message extra time to be read
        {
          durationMs:
            durationMs ?? (osc52Blocked || isLinux ? 6000 : undefined),
        },
      )
    }
    throw error
  } finally {
    if (activeClipboardOperation === operationController) {
      activeClipboardOperation = null
    }
  }
}

export function clearClipboardMessage() {
  if (clearTimer) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
  emitClipboardMessage(null)
}

// =============================================================================
// OSC52 Clipboard Support
// =============================================================================
// OSC52 writes to clipboard via terminal escape sequences - works over SSH
// because the client terminal handles clipboard. Format: ESC ] 52 ; c ; <base64> BEL
// tmux/screen require passthrough wrapping to forward the sequence.

export function isRemoteSession(): boolean {
  const env = getCliEnv()
  return !!(env.SSH_CLIENT || env.SSH_TTY || env.SSH_CONNECTION)
}

export const OSC52_BLOCKED_MESSAGE =
  'Copy is blocked by this terminal — hold Shift and drag to select, then copy normally'

/** Appended to a Linux "Copied" that only reached the terminal (OSC 52). */
export const LINUX_OSC52_ONLY_HINT =
  '(via terminal — if paste is empty, install wl-clipboard or xclip)'

export const LINUX_CLIPBOARD_ERROR_MESSAGE =
  'Clipboard unavailable — install wl-clipboard (Wayland) or xclip (X11)'

// GitHub Codespaces and VS Code remote (SSH/tunnel) terminals silently drop
// OSC 52 sequences, so a "successful" write never reaches the user's
// clipboard. Local VS Code terminals (including devcontainers) honor OSC 52.
// https://github.com/microsoft/vscode-remote-release/issues/11475
export function isOsc52Blocked(): boolean {
  const env = getCliEnv()
  return (
    env.TERM_PROGRAM === 'vscode' &&
    (env.CODESPACES === 'true' || isRemoteSession())
  )
}

const CLIPBOARD_TOOL_TIMEOUT_MS = 5000

function throwIfClipboardAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The clipboard operation was aborted', 'AbortError')
}

function killClipboardTool(child: ChildProcess): void {
  try {
    child.kill('SIGKILL')
  } catch {
    // The process may already have exited between an error and cleanup.
  }
}

function writeToClipboardTool(
  command: string,
  args: string[],
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      trackHelperProcess('clipboard', child)
    } catch {
      resolve(false)
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (copied: boolean) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', handleAbort)
      resolve(copied)
    }
    const handleAbort = () => {
      killClipboardTool(child)
      finish(false)
    }

    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
    child.stdin?.once('error', () => {
      killClipboardTool(child)
      finish(false)
    })

    timeout = setTimeout(() => {
      // A backend waiting on a broken display server must not freeze the TUI.
      // SIGKILL also prevents a timed-out process from retaining the clipboard
      // pipe after the next backend starts.
      killClipboardTool(child)
      finish(false)
    }, CLIPBOARD_TOOL_TIMEOUT_MS)
    signal?.addEventListener('abort', handleAbort, { once: true })

    try {
      child.stdin?.end(text)
    } catch {
      killClipboardTool(child)
      finish(false)
    }

    // Abort may have happened between the caller's check and listener setup.
    if (signal?.aborted) handleAbort()
  })
}

async function tryCopyViaPlatformTool(
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const commands: [string, string[]][] = (() => {
    if (process.platform === 'darwin') return [['pbcopy', []]]
    if (process.platform === 'win32') return [['clip', []]]
    if (process.platform !== 'linux') return []

    const x11Commands: [string, string[]][] = [
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ]
    return getCliEnv().WAYLAND_DISPLAY
      ? [['wl-copy', ['--type', 'text/plain']], ...x11Commands]
      : x11Commands
  })()

  for (const [command, args] of commands) {
    throwIfClipboardAborted(signal)
    const copied = await writeToClipboardTool(command, args, text, signal)
    throwIfClipboardAborted(signal)
    if (copied) return true
  }

  return false
}

function tryCopyViaRenderer(text: string): boolean {
  if (!registeredRenderer) return false
  const copyFn = registeredRenderer.copyToClipboardOSC52
  if (typeof copyFn !== 'function') return false
  try {
    return Boolean(copyFn.call(registeredRenderer, text))
  } catch {
    return false
  }
}

// 32KB is safe for all environments (tmux is the strictest)
const OSC52_MAX_PAYLOAD = 32_000

function isWithinOsc52PayloadLimit(text: string): boolean {
  const byteLength = Buffer.byteLength(text, 'utf8')
  const base64Length = 4 * Math.ceil(byteLength / 3)
  return base64Length <= OSC52_MAX_PAYLOAD
}

function buildOsc52Sequence(text: string): string | null {
  const env = getCliEnv()
  if (env.TERM === 'dumb') return null
  if (!isWithinOsc52PayloadLimit(text)) return null

  const base64 = Buffer.from(text, 'utf8').toString('base64')

  const osc = `\x1b]52;c;${base64}\x07`

  // tmux: wrap in DCS passthrough with doubled ESC
  if (env.TMUX) {
    return `\x1bPtmux;${osc.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`
  }

  // GNU screen: wrap in DCS passthrough
  if (env.STY) {
    return `\x1bP${osc}\x1b\\`
  }

  return osc
}

function tryCopyViaTtyOsc52(text: string): boolean {
  const sequence = buildOsc52Sequence(text)
  if (!sequence) return false

  const ttyPath = process.platform === 'win32' ? 'CON' : '/dev/tty'
  let fd: number | null = null
  try {
    fd = openSync(ttyPath, 'w')
    writeSync(fd, sequence)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
