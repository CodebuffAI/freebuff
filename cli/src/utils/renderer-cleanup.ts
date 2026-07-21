import { resetTerminalTitle } from './terminal-title'
import { stopActiveRun } from './active-run'
import { flushLiveChatState } from './run-state-storage'
import { TERMINAL_RESET_SEQUENCES } from './terminal-reset-sequences'
import { stopTerminalWatchdog } from './terminal-watchdog'

import type { CliRenderer } from '@opentui/core'


let renderer: CliRenderer | null = null
let handlersInstalled = false
let terminalStateReset = false

/**
 * Reset terminal state by writing escape sequences directly to stdout.
 * This is called BEFORE renderer.destroy() to ensure sequences are sent
 * even if the renderer is in a bad state.
 *
 * This is especially important on Windows where signals like SIGTERM and SIGHUP
 * don't work, so we rely on the 'exit' event which is guaranteed to run.
 *
 * After writing the reset sequences, we attempt to flush stdout to ensure the
 * data reaches the terminal before the process exits. Without this flush, a
 * sudden process.exit() can leave terminal escape sequences buffered and never
 * sent, causing garbled output and ASCII/UTF-8 decoding errors on the next
 * terminal prompt.
 */
function resetTerminalState(): void {
  if (terminalStateReset) return
  terminalStateReset = true

  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
    }
  } catch {
    // Ignore errors - stdin may already be closed
  }
  try {
    // Reset terminal title to default
    resetTerminalTitle()
    // Write directly to stdout - this is synchronous and will complete
    // before the process exits, ensuring the terminal is reset
    if (process.stdout.isTTY) {
      process.stdout.write(TERMINAL_RESET_SEQUENCES)
      // NOTE: do NOT call destroy() here — that discards buffered data.
      // TTY writes are synchronous (write() syscall goes directly to the
      // PTY), so the data reaches the kernel buffer before the call returns.
      // process.exit() then terminates cleanly and the kernel flushes fd 1.
    }
  } catch {
    // Ignore errors - stdout may already be closed
  }
}

/**
 * Clean up the renderer by calling destroy().
 * This resets terminal state to prevent garbled output after exit.
 */
function cleanup(): void {
  // We're on the clean-shutdown path, so the watchdog must not fire — kill it
  // before anything else (synchronous, so no race with our own exit).
  stopTerminalWatchdog()

  // Finalize the active message before reading the live provider. This makes
  // the synchronous flush include the interruption UI and prevents a late
  // SDK callback from continuing to own the chat while shutdown proceeds.
  stopActiveRun('process-exit')

  // Persist any in-flight chat state first (synchronous, best-effort) so
  // closing the terminal or killing the process mid-run doesn't lose the turn.
  flushLiveChatState()

  // Reset terminal state by writing escape sequences directly to stdout.
  // This ensures mouse mode, focus reporting, etc. are disabled even if
  // renderer.destroy() fails or doesn't fully clean up.
  resetTerminalState()

  if (renderer && !renderer.isDestroyed) {
    try {
      renderer.destroy()
    } catch {
      // Ignore errors during cleanup - we're exiting anyway
    }
    renderer = null
  }
}

/**
 * Install process-level signal handlers to ensure terminal cleanup on all exit scenarios.
 * Call this once after creating the renderer in index.tsx.
 *
 * This handles:
 * - SIGTERM (kill)
 * - SIGHUP (terminal hangup)
 * - SIGINT (Ctrl+C)
 * - beforeExit / exit events
 * - uncaughtException / unhandledRejection
 *
 * Note: SIGKILL cannot be caught - it's an immediate termination signal.
 */
export function installProcessCleanupHandlers(cliRenderer: CliRenderer): void {
  if (handlersInstalled) return
  handlersInstalled = true
  renderer = cliRenderer

  const cleanupAndExit = (exitCode: number) => {
    cleanup()
    // Ensure stdout and stderr are drained before exit. Without this, pending
    // writes (e.g. terminal reset sequences from cleanup()) may be buffered
    // and lost, leaving the terminal in a garbled state.
    try {
      process.stdout._handle?.setBlocking?.(true)
    } catch {
      // _handle may not exist in Bun or on some platforms
    }
    process.exit(exitCode)
  }

  // SIGTERM - Default kill signal (e.g., `kill <pid>`)
  process.on('SIGTERM', () => {
    cleanupAndExit(0)
  })

  // SIGHUP - Terminal hangup (e.g., closing the terminal window)
  process.on('SIGHUP', () => {
    cleanupAndExit(0)
  })

  // SIGINT - Ctrl+C
  process.on('SIGINT', () => {
    cleanupAndExit(0)
  })

  // beforeExit - Called when the event loop is empty and about to exit
  process.on('beforeExit', () => {
    cleanup()
  })

  // exit - Last chance to run synchronous cleanup code
  process.on('exit', () => {
    // Guard: prevent double-cleanup if this is called from cleanupAndExit
    // (which calls cleanup() before process.exit(), which triggers this
    // 'exit' event handler and calls cleanup() again).
    if (!handlersInstalled) return
    handlersInstalled = false
    cleanup()
  })

  // uncaughtException - Safety net for unhandled errors
  process.on('uncaughtException', (error) => {
    cleanup() // Exit alt screen FIRST so error output is visible on the main screen
    try {
      console.error('Uncaught exception:', error)
    } catch {
      // Ignore logging errors
    }
    process.exit(1)
  })

  // unhandledRejection - Safety net for unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    cleanup() // Exit alt screen FIRST so error output is visible on the main screen
    try {
      console.error('Unhandled rejection:', reason)
    } catch {
      // Ignore logging errors
    }
    process.exit(1)
  })
}
