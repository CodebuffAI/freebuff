/**
 * Terminal Color Detection using OSC 10/11 Escape Sequences
 *
 * This module provides utilities for detecting terminal theme (dark/light) by querying
 * the terminal's foreground and background colors using OSC (Operating System Command)
 * escape sequences.
 *
 * OSC 10: Query foreground (text) color
 * OSC 11: Query background color
 */

import { openSync, closeSync, writeSync, constants } from 'fs'

import { getCliEnv } from './env'
import { withTimeoutOr } from '@codebuff/common/util/promise'

import type { CliEnv } from '../types/env'

// Timeout constants
const OSC_QUERY_TIMEOUT_MS = 500 // Timeout for individual OSC query
const GLOBAL_OSC_TIMEOUT_MS = 2000 // Global timeout for entire detection process

/**
 * Check if the current terminal supports OSC color queries
 */
export function terminalSupportsOSC(
  env: CliEnv = getCliEnv(),
): boolean {
  const term = env.TERM || ''
  const termProgram = env.TERM_PROGRAM || ''

  // Known compatible terminals
  const supportedPrograms = [
    'iTerm.app',
    'Apple_Terminal',
    'WezTerm',
    'Alacritty',
    'kitty',
    'Ghostty',
    'vscode',
  ]

  if (supportedPrograms.some((p) => termProgram.includes(p))) {
    return true
  }

  const supportedTerms = [
    'xterm-256color',
    'xterm-kitty',
    'alacritty',
    'wezterm',
    'ghostty',
  ]

  if (supportedTerms.some((t) => term.includes(t))) {
    return true
  }

  // Check if we have a TTY
  return process.stdin.isTTY === true
}

/**
 * Build OSC query string
 * @param oscCode - The OSC code (10 for foreground, 11 for background)
 */
function buildOscQuery(oscCode: number): string {
  return `\x1b]${oscCode};?\x07`
}

/**
 * Query the terminal for OSC color information.
 * 
 * IMPORTANT: This function reads from stdin because OSC responses come through
 * the PTY which appears on stdin. This means it MUST be run BEFORE any other
 * stdin listeners (like OpenTUI) are attached. OSC detection runs at the very
 * start of main() in index.tsx, before OpenTUI is initialized.
 * 
 * @param ttyPath - Path to TTY for writing the query
 * @param query - The OSC query string to send
 * @returns The raw response string or null if query failed
 */
async function sendOscQuery(
  ttyPath: string,
  query: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    // Guard: Must have TTY for both reading and writing
    if (!process.stdin.isTTY) {
      resolve(null)
      return
    }

    let ttyWriteFd: number | null = null
    let timeoutId: NodeJS.Timeout | null = null
    let resolved = false
    let response = ''
    let wasRawMode = false
    let dataHandler: ((data: Buffer) => void) | null = null

    const cleanup = () => {
      if (resolved) return
      resolved = true

      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }

      // Remove data handler from stdin
      if (dataHandler) {
        process.stdin.removeListener('data', dataHandler)
        dataHandler = null
      }

      // Restore raw mode state
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        try {
          process.stdin.setRawMode(wasRawMode)
        } catch {
          // Ignore errors restoring raw mode
        }
      }

      // Pause stdin so we leave it non-flowing before other listeners attach
      try {
        process.stdin.pause()
      } catch {
        // Ignore pause errors
      }

      // Close TTY write fd
      if (ttyWriteFd !== null) {
        try {
          closeSync(ttyWriteFd)
        } catch {
          // Ignore close errors
        }
        ttyWriteFd = null
      }
    }

    const resolveWith = (value: string | null) => {
      if (resolved) return
      cleanup()
      resolve(value)
    }

    try {
      // Open TTY for writing the query
      try {
        ttyWriteFd = openSync(ttyPath, constants.O_WRONLY)
      } catch {
        resolveWith(null)
        return
      }

      // Save current raw mode state and enable raw mode to capture escape sequences.
      // Without raw mode, the terminal buffers input line-by-line and OSC responses
      // (which don't end with newlines) would never be delivered.
      wasRawMode = process.stdin.isRaw ?? false
      if (process.stdin.setRawMode) {
        try {
          process.stdin.setRawMode(true)
        } catch {
          // Continue anyway - some terminals might work without raw mode
        }
      }

      // Set up timeout
      timeoutId = setTimeout(() => {
        resolveWith(response.length > 0 ? response : null)
      }, OSC_QUERY_TIMEOUT_MS)

      // Set up event-based reading from stdin.
      // OSC responses come through the PTY which appears on stdin.
      dataHandler = (data: Buffer) => {
        if (resolved) return

        const chunk = data.toString('utf8')
        response += chunk

        // Check for complete response
        const hasBEL = response.includes('\x07')
        const hasST = response.includes('\x1b\\')
        const hasRGB =
          /rgb:[0-9a-fA-F]{2,4}\/[0-9a-fA-F]{2,4}\/[0-9a-fA-F]{2,4}/.test(
            response,
          )

        // A complete response has RGB data AND a terminator (BEL or ST)
        // Some terminals might send RGB without proper terminator, so we accept that too
        if (hasRGB && (hasBEL || hasST || response.length > 30)) {
          resolveWith(response)
        }
      }

      process.stdin.on('data', dataHandler)
      process.stdin.resume()

      // Write the OSC query to TTY
      try {
        writeSync(ttyWriteFd, query)
      } catch {
        resolveWith(null)
        return
      }
    } catch {
      resolveWith(null)
    }
  })
}

/**
 * Query terminal for OSC color
 */
export async function queryTerminalOSC(
  oscCode: number,
): Promise<string | null> {
  const ttyPath = process.platform === 'win32' ? 'CON' : '/dev/tty'
  const query = buildOscQuery(oscCode)
  return sendOscQuery(ttyPath, query)
}

/**
 * Parse RGB values from OSC response
 * @param response - The raw OSC response string
 * @returns RGB tuple [r, g, b] normalized to 0-255, or null if parsing failed
 */
export function parseOSCResponse(
  response: string,
): [number, number, number] | null {
  // Extract RGB values from response
  const match = response.match(
    /rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/,
  )

  if (!match) return null

  const [, rHex, gHex, bHex] = match
  if (!rHex || !gHex || !bHex) return null

  // Convert hex to decimal
  let r = parseInt(rHex, 16)
  let g = parseInt(gHex, 16)
  let b = parseInt(bHex, 16)

  // Normalize 16-bit (4 hex digits) to 8-bit
  if (rHex.length === 4) {
    r = Math.floor(r / 257)
    g = Math.floor(g / 257)
    b = Math.floor(b / 257)
  }

  return [r, g, b]
}

const XTERM_COLOR_STEPS = [0, 95, 135, 175, 215, 255]
const ANSI_16_COLORS: [number, number, number][] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

function xtermColorToRGB(index: number): [number, number, number] | null {
  if (!Number.isFinite(index) || index < 0) {
    return null
  }

  if (index < ANSI_16_COLORS.length) {
    return ANSI_16_COLORS[index]
  }

  if (index >= 16 && index <= 231) {
    const base = index - 16
    const r = Math.floor(base / 36)
    const g = Math.floor((base % 36) / 6)
    const b = base % 6
    return [
      XTERM_COLOR_STEPS[r] ?? 0,
      XTERM_COLOR_STEPS[g] ?? 0,
      XTERM_COLOR_STEPS[b] ?? 0,
    ]
  }

  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10
    return [level, level, level]
  }

  return null
}

function detectBgColorFromEnv(
  env: CliEnv = getCliEnv(),
): [number, number, number] | null {
  const termBackground = env.TERM_BACKGROUND?.toLowerCase()
  if (termBackground === 'dark') {
    return [0, 0, 0]
  }
  if (termBackground === 'light') {
    return [255, 255, 255]
  }

  const colorFgBg = env.COLORFGBG
  if (!colorFgBg) return null

  const parts = colorFgBg
    .split(';')
    .map((part) => parseInt(part, 10))
    .filter((value) => Number.isFinite(value))

  if (parts.length === 0) {
    return null
  }

  const bgIndex = parts[parts.length - 1]
  return xtermColorToRGB(bgIndex)
}

/**
 * Calculate brightness using ITU-R BT.709 luminance formula
 * @param rgb - RGB tuple [r, g, b] in 0-255 range
 * @returns Brightness value 0-255
 */
export function calculateBrightness([r, g, b]: [
  number,
  number,
  number,
]): number {
  // Relative luminance coefficients (ITU-R BT.709)
  const LUMINANCE_RED = 0.2126
  const LUMINANCE_GREEN = 0.7152
  const LUMINANCE_BLUE = 0.0722

  return Math.floor(
    LUMINANCE_RED * r + LUMINANCE_GREEN * g + LUMINANCE_BLUE * b,
  )
}

/**
 * Determine theme from background color
 * @param rgb - RGB tuple [r, g, b]
 * @returns 'dark' if background is dark, 'light' if background is light
 */
export function themeFromBgColor(
  rgb: [number, number, number],
): 'dark' | 'light' {
  const brightness = calculateBrightness(rgb)
  const THRESHOLD = 128 // Middle of 0-255 range

  return brightness > THRESHOLD ? 'light' : 'dark'
}

/**
 * Determine theme from foreground color (inverted logic)
 * @param rgb - RGB tuple [r, g, b]
 * @returns 'dark' if foreground is bright (dark background), 'light' if foreground is dark
 */
export function themeFromFgColor(
  rgb: [number, number, number],
): 'dark' | 'light' {
  const brightness = calculateBrightness(rgb)
  // Bright foreground = dark background theme
  return brightness > 128 ? 'dark' : 'light'
}

/**
 * Core detection logic without any timeout wrapping
 * This is the actual detection implementation
 */
async function detectTerminalThemeCore(
  env: CliEnv = getCliEnv(),
): Promise<'dark' | 'light' | null> {
  // Check if terminal supports OSC
  if (!terminalSupportsOSC(env)) {
    return null
  }

  // Try background color first (OSC 11) - more reliable
  const bgResponse = await queryTerminalOSC(11)
  if (bgResponse) {
    const bgRgb = parseOSCResponse(bgResponse)
    if (bgRgb) {
      return themeFromBgColor(bgRgb)
    }
  }

  // Fallback to foreground color (OSC 10)
  const fgResponse = await queryTerminalOSC(10)
  if (fgResponse) {
    const fgRgb = parseOSCResponse(fgResponse)
    if (fgRgb) {
      return themeFromFgColor(fgRgb)
    }
  }

  // Fallback to COLORFGBG environment variable if available
  const envBgRgb = detectBgColorFromEnv(env)
  if (envBgRgb) {
    return themeFromBgColor(envBgRgb)
  }

  return null
}

/**
 * Detect terminal theme by querying OSC 10/11
 * Wrapped with a global timeout to prevent hanging
 * @returns 'dark', 'light', or null if detection failed
 */
export async function detectTerminalTheme(): Promise<'dark' | 'light' | null> {
  try {
    return await withTimeoutOr(
      detectTerminalThemeCore(),
      GLOBAL_OSC_TIMEOUT_MS,
      null,
    )
  } catch {
    return null
  }
}

/**
 * Get the global OSC timeout value (for testing/debugging)
 */
export function getGlobalOscTimeout(): number {
  return GLOBAL_OSC_TIMEOUT_MS
}

/**
 * Get the per-query OSC timeout value (for testing/debugging)
 */
export function getQueryOscTimeout(): number {
  return OSC_QUERY_TIMEOUT_MS
}
