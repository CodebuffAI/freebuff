import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { withTimeoutOr } from '@codebuff/common/util/promise'

import {
  parseOSCResponse,
  calculateBrightness,
  themeFromBgColor,
  themeFromFgColor,
  terminalSupportsOSC,
  detectTerminalThemeWithSupportTestHook,
  detectBgColorEvidence,
  getGlobalOscTimeout,
  getQueryOscTimeout,
} from '../terminal-color-detection'

// ============================================================================
// parseOSCResponse Tests
// ============================================================================

describe('parseOSCResponse', () => {
  test('parses 8-bit RGB response (2 hex digits)', () => {
    const response = '\x1b]11;rgb:ff/00/80\x07'
    const result = parseOSCResponse(response)
    expect(result).toEqual([255, 0, 128])
  })

  test('parses 16-bit RGB response (4 hex digits)', () => {
    const response = '\x1b]11;rgb:ffff/0000/8080\x07'
    const result = parseOSCResponse(response)
    // 16-bit values are normalized: ffff -> 255, 0000 -> 0, 8080 -> 128
    expect(result).toEqual([255, 0, 128])
  })

  test('parses response with ST terminator', () => {
    const response = '\x1b]11;rgb:00/ff/00\x1b\\'
    const result = parseOSCResponse(response)
    expect(result).toEqual([0, 255, 0])
  })

  test('parses black background', () => {
    const response = '\x1b]11;rgb:0000/0000/0000\x07'
    const result = parseOSCResponse(response)
    expect(result).toEqual([0, 0, 0])
  })

  test('parses white background', () => {
    const response = '\x1b]11;rgb:ffff/ffff/ffff\x07'
    const result = parseOSCResponse(response)
    expect(result).toEqual([255, 255, 255])
  })

  test('returns null for invalid response', () => {
    expect(parseOSCResponse('')).toBeNull()
    expect(parseOSCResponse('invalid')).toBeNull()
    expect(parseOSCResponse('rgb:')).toBeNull()
    expect(parseOSCResponse('rgb:ff/ff')).toBeNull() // Missing blue
  })

  test('parses response with extra content', () => {
    const response = 'prefix \x1b]11;rgb:12/34/56\x07 suffix'
    const result = parseOSCResponse(response)
    expect(result).toEqual([18, 52, 86])
  })

  test('handles case-insensitive hex values', () => {
    const response = '\x1b]11;rgb:Aa/Bb/Cc\x07'
    const result = parseOSCResponse(response)
    expect(result).toEqual([170, 187, 204])
  })
})

// ============================================================================
// calculateBrightness Tests
// ============================================================================

describe('calculateBrightness', () => {
  test('calculates brightness for black', () => {
    expect(calculateBrightness([0, 0, 0])).toBe(0)
  })

  test('calculates brightness for white', () => {
    // Due to floating point: 0.2126*255 + 0.7152*255 + 0.0722*255 = 254.9999... -> 254
    expect(calculateBrightness([255, 255, 255])).toBe(254)
  })

  test('calculates brightness for pure red', () => {
    // 0.2126 * 255 = 54.213
    expect(calculateBrightness([255, 0, 0])).toBe(54)
  })

  test('calculates brightness for pure green', () => {
    // 0.7152 * 255 = 182.376
    expect(calculateBrightness([0, 255, 0])).toBe(182)
  })

  test('calculates brightness for pure blue', () => {
    // 0.0722 * 255 = 18.411
    expect(calculateBrightness([0, 0, 255])).toBe(18)
  })

  test('calculates brightness for mid-gray', () => {
    const result = calculateBrightness([128, 128, 128])
    // Should be close to 128
    expect(result).toBeGreaterThan(125)
    expect(result).toBeLessThan(130)
  })

  test('green contributes most to brightness (ITU-R BT.709)', () => {
    const redBrightness = calculateBrightness([255, 0, 0])
    const greenBrightness = calculateBrightness([0, 255, 0])
    const blueBrightness = calculateBrightness([0, 0, 255])

    expect(greenBrightness).toBeGreaterThan(redBrightness)
    expect(greenBrightness).toBeGreaterThan(blueBrightness)
    expect(redBrightness).toBeGreaterThan(blueBrightness)
  })
})

// ============================================================================
// themeFromBgColor Tests
// ============================================================================

describe('themeFromBgColor', () => {
  test('returns dark for black background', () => {
    expect(themeFromBgColor([0, 0, 0])).toBe('dark')
  })

  test('returns light for white background', () => {
    expect(themeFromBgColor([255, 255, 255])).toBe('light')
  })

  test('returns dark for dark gray', () => {
    expect(themeFromBgColor([50, 50, 50])).toBe('dark')
  })

  test('returns light for light gray', () => {
    expect(themeFromBgColor([200, 200, 200])).toBe('light')
  })

  test('threshold is at 128', () => {
    // Just below threshold
    expect(themeFromBgColor([127, 127, 127])).toBe('dark')
    // Just above threshold
    expect(themeFromBgColor([130, 130, 130])).toBe('light')
  })

  test('handles common dark themes', () => {
    // VS Code Dark+
    expect(themeFromBgColor([30, 30, 30])).toBe('dark')
    // Dracula
    expect(themeFromBgColor([40, 42, 54])).toBe('dark')
    // One Dark
    expect(themeFromBgColor([40, 44, 52])).toBe('dark')
  })

  test('handles common light themes', () => {
    // VS Code Light+
    expect(themeFromBgColor([255, 255, 255])).toBe('light')
    // Solarized Light
    expect(themeFromBgColor([253, 246, 227])).toBe('light')
  })
})

// ============================================================================
// themeFromFgColor Tests
// ============================================================================

describe('themeFromFgColor', () => {
  test('returns dark for bright foreground (indicates dark background)', () => {
    expect(themeFromFgColor([255, 255, 255])).toBe('dark')
    expect(themeFromFgColor([200, 200, 200])).toBe('dark')
  })

  test('returns light for dark foreground (indicates light background)', () => {
    expect(themeFromFgColor([0, 0, 0])).toBe('light')
    expect(themeFromFgColor([50, 50, 50])).toBe('light')
  })

  test('inverts the logic from themeFromBgColor', () => {
    const colors: [number, number, number][] = [
      [0, 0, 0],
      [128, 128, 128],
      [255, 255, 255],
    ]

    for (const color of colors) {
      const bgResult = themeFromBgColor(color)
      const fgResult = themeFromFgColor(color)
      // Foreground and background should give opposite results
      // (bright fg = dark theme, dark fg = light theme)
      if (bgResult === 'dark') {
        expect(fgResult).toBe('light')
      } else {
        expect(fgResult).toBe('dark')
      }
    }
  })
})

// ============================================================================
// withTimeoutOr Tests
// ============================================================================

describe('withTimeoutOr', () => {
  test('returns promise result if it resolves before timeout', async () => {
    const fastPromise = Promise.resolve('success')
    const result = await withTimeoutOr(fastPromise, 1000, 'timeout')
    expect(result).toBe('success')
  })

  test('returns timeout value if promise takes too long', async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('late'), 500)
    })
    const result = await withTimeoutOr(slowPromise, 50, 'timeout')
    expect(result).toBe('timeout')
  })

  test('returns null timeout value', async () => {
    const slowPromise = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve('late'), 500)
    })
    const result = await withTimeoutOr(slowPromise, 50, null)
    expect(result).toBeNull()
  })

  test('clears timeout after promise resolves', async () => {
    const fastPromise = Promise.resolve('success')
    // This should not cause any issues with dangling timeouts
    await withTimeoutOr(fastPromise, 10000, 'timeout')
    // If the timeout wasn't cleared, this test would hang
  })

  test('handles rejected promises', async () => {
    const failingPromise = Promise.reject(new Error('test error'))
    await expect(withTimeoutOr(failingPromise, 1000, 'timeout')).rejects.toThrow(
      'test error',
    )
  })

  test('handles immediate resolution', async () => {
    const result = await withTimeoutOr(Promise.resolve(42), 0, -1)
    // Promise.resolve is always faster than setTimeout(0)
    expect(result).toBe(42)
  })
})

// ============================================================================
// terminalSupportsOSC Tests
// ============================================================================

describe('terminalSupportsOSC', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Reset env to original values
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('returns true for iTerm.app', () => {
    process.env.TERM_PROGRAM = 'iTerm.app'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for Apple_Terminal', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for vscode', () => {
    process.env.TERM_PROGRAM = 'vscode'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for kitty via TERM', () => {
    process.env.TERM_PROGRAM = ''
    process.env.TERM = 'xterm-kitty'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for xterm-256color', () => {
    process.env.TERM_PROGRAM = ''
    process.env.TERM = 'xterm-256color'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for alacritty via TERM', () => {
    process.env.TERM_PROGRAM = ''
    process.env.TERM = 'alacritty'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for WezTerm', () => {
    process.env.TERM_PROGRAM = 'WezTerm'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('returns true for Ghostty', () => {
    process.env.TERM_PROGRAM = 'Ghostty'
    expect(terminalSupportsOSC()).toBe(true)
  })

  test('checks for partial match in TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'something-vscode-something'
    expect(terminalSupportsOSC()).toBe(true)
  })
})

// ============================================================================
// Timeout Constants Tests
// ============================================================================

describe('timeout constants', () => {
  test('global timeout is reasonable', () => {
    const timeout = getGlobalOscTimeout()
    expect(timeout).toBeGreaterThan(0)
    expect(timeout).toBeLessThanOrEqual(5000) // Should be at most 5 seconds
  })

  test('query timeout is less than global timeout', () => {
    const queryTimeout = getQueryOscTimeout()
    const globalTimeout = getGlobalOscTimeout()
    expect(queryTimeout).toBeLessThan(globalTimeout)
  })

  test('query timeout is reasonable', () => {
    const timeout = getQueryOscTimeout()
    expect(timeout).toBeGreaterThan(0)
    expect(timeout).toBeLessThanOrEqual(2000) // Should be at most 2 seconds
  })
})

// ============================================================================
// Integration-style Tests (without actual TTY)
// ============================================================================

describe('theme detection edge cases', () => {
  test('correctly identifies solarized dark', () => {
    // Solarized Dark background: #002b36
    const rgb: [number, number, number] = [0, 43, 54]
    expect(themeFromBgColor(rgb)).toBe('dark')
  })

  test('correctly identifies solarized light', () => {
    // Solarized Light background: #fdf6e3
    const rgb: [number, number, number] = [253, 246, 227]
    expect(themeFromBgColor(rgb)).toBe('light')
  })

  test('correctly identifies monokai background', () => {
    // Monokai background: #272822
    const rgb: [number, number, number] = [39, 40, 34]
    expect(themeFromBgColor(rgb)).toBe('dark')
  })

  test('correctly identifies nord background', () => {
    // Nord background: #2e3440
    const rgb: [number, number, number] = [46, 52, 64]
    expect(themeFromBgColor(rgb)).toBe('dark')
  })

  test('correctly identifies github light background', () => {
    // GitHub Light background: #ffffff
    const rgb: [number, number, number] = [255, 255, 255]
    expect(themeFromBgColor(rgb)).toBe('light')
  })

  test('correctly identifies gruvbox dark', () => {
    // Gruvbox Dark background: #282828
    const rgb: [number, number, number] = [40, 40, 40]
    expect(themeFromBgColor(rgb)).toBe('dark')
  })

  test('correctly identifies gruvbox light', () => {
    // Gruvbox Light background: #fbf1c7
    const rgb: [number, number, number] = [251, 241, 199]
    expect(themeFromBgColor(rgb)).toBe('light')
  })
})

// ============================================================================
// OSC Response Format Tests
// ============================================================================

describe('OSC response format variations', () => {
  test('handles response from iTerm2', () => {
    // iTerm2 typically sends 4-digit hex
    const response = '\x1b]11;rgb:1c1c/1c1c/1e1e\x07'
    const result = parseOSCResponse(response)
    expect(result).not.toBeNull()
    expect(themeFromBgColor(result!)).toBe('dark')
  })

  test('handles response from Terminal.app', () => {
    // Apple Terminal sends 4-digit hex
    const response = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
    const result = parseOSCResponse(response)
    expect(result).toEqual([255, 255, 255])
  })

  test('handles response from kitty', () => {
    // kitty sends 2-digit hex
    const response = '\x1b]11;rgb:00/00/00\x07'
    const result = parseOSCResponse(response)
    expect(result).toEqual([0, 0, 0])
  })

  test('handles response with extra escape sequences', () => {
    // Some terminals add extra escape sequences
    const response = '\x1b[?1;2c\x1b]11;rgb:28/2c/34\x07'
    const result = parseOSCResponse(response)
    expect(result).toEqual([40, 44, 52])
    expect(themeFromBgColor(result!)).toBe('dark')
  })

  test('handles tmux passthrough response', () => {
    // tmux wraps the response
    const response = '\x1bPtmux;\x1b\x1b]11;rgb:1e/1e/2e\x1b\x1b\\\x1b\\'
    // The RGB pattern should still be found
    const result = parseOSCResponse(response)
    expect(result).toEqual([30, 30, 46])
  })
})

// ============================================================================
// detectBgColorEvidence Tests (sync first-frame evidence)
// ============================================================================

describe('detectBgColorEvidence', () => {
  const originalEnv = { ...process.env }

  const clearColorEnv = () => {
    delete process.env.TERM_BACKGROUND
    delete process.env.COLORFGBG
    delete process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM_VERSION
    delete process.env.XTERM_VERSION
    delete process.env.TERM
  }

  beforeEach(() => {
    process.env = { ...originalEnv }
    clearColorEnv()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('returns black rgb for TERM_BACKGROUND=dark', () => {
    process.env.TERM_BACKGROUND = 'dark'
    expect(detectBgColorEvidence()).toEqual([0, 0, 0])
  })

  test('returns white rgb for TERM_BACKGROUND=light', () => {
    process.env.TERM_BACKGROUND = 'light'
    expect(detectBgColorEvidence()).toEqual([255, 255, 255])
  })

  test('resolves COLORFGBG background index (dark)', () => {
    process.env.COLORFGBG = '15;0'
    expect(detectBgColorEvidence()).toEqual([0, 0, 0])
    expect(themeFromBgColor(detectBgColorEvidence()!)).toBe('dark')
  })

  test('resolves COLORFGBG background index (light)', () => {
    process.env.COLORFGBG = '0;15'
    const rgb = detectBgColorEvidence()
    expect(rgb).not.toBeNull()
    expect(themeFromBgColor(rgb!)).toBe('light')
  })

  test('env evidence wins even when the terminal supports OSC', () => {
    // OSC-capable terminal: no fallback applies, but COLORFGBG is still
    // usable as first-frame evidence ahead of the probe's answer.
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.COLORFGBG = '0;15'
    expect(detectBgColorEvidence()).not.toBeNull()
    expect(themeFromBgColor(detectBgColorEvidence()!)).toBe('light')
  })

  test('applies the Apple Terminal fallback when OSC is unsupported', () => {
    // Old-version Apple Terminal skipping the query: explicit supportsOsc
    // pin, since the host pty would otherwise steer terminalSupportsOSC().
    process.env.TERM = 'fb-test-vt'
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    process.env.TERM_PROGRAM_VERSION = '250'
    const rgb = detectBgColorEvidence(undefined, false)
    expect(rgb).toEqual([255, 255, 255])
    expect(themeFromBgColor(rgb!)).toBe('light')
  })

  test('does not apply terminal fallbacks when a query will be sent', () => {
    // OSC-capable terminal: the query answer supersedes the fallback, so
    // the first frame must not assume it.
    process.env.TERM_PROGRAM = 'WezTerm'
    process.env.TERM = 'wezterm'
    expect(detectBgColorEvidence()).toBeNull()
  })

  test('returns null when nothing is conclusive (no env, no fallback)', () => {
    // A terminal that will be queried (supportsOsc=true) must not guess from
    // nothing: the first frame falls through to OS detection, exactly the
    // old order's behavior before an answer.
    process.env.TERM = 'screen-256color'
    process.env.TERM_PROGRAM = 'tmux'
    expect(detectBgColorEvidence(undefined, true)).toBeNull()
    // And without a query path or a known terminal hint there is simply no
    // evidence either.
    expect(detectBgColorEvidence(undefined, false)).toBeNull()
  })
})

// ============================================================================
// detectTerminalThemeWithSupportTestHook Tests (async query path, env-driven)
// ============================================================================

describe('detectTerminalThemeWithSupportTestHook', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.TERM_BACKGROUND
    delete process.env.COLORFGBG
    delete process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM_VERSION
    delete process.env.XTERM_VERSION
    delete process.env.TERM
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('unsupported-OSC terminal resolves from COLORFGBG without querying', async () => {
    process.env.TERM = 'ansi'
    process.env.COLORFGBG = '0;15'
    const theme = await detectTerminalThemeWithSupportTestHook(false)
    expect(theme).toBe('light')
  })

  test('unsupported-OSC terminal resolves from TERM_BACKGROUND', async () => {
    process.env.TERM = 'ansi'
    process.env.TERM_BACKGROUND = 'dark'
    const theme = await detectTerminalThemeWithSupportTestHook(false)
    expect(theme).toBe('dark')
  })

  test('unsupported-OSC Apple Terminal falls back per version', async () => {
    process.env.TERM = 'ansi'
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    process.env.TERM_PROGRAM_VERSION = '250'
    const theme = await detectTerminalThemeWithSupportTestHook(false)
    expect(theme).toBe('light')
  })

  test('unsupported-OSC terminal with no signals returns null', async () => {
    process.env.TERM = 'dumb'
    process.env.TERM_PROGRAM = 'tmux'
    const theme = await detectTerminalThemeWithSupportTestHook(false)
    expect(theme).toBeNull()
  })

  test('env signals apply even for OSC-capable terminals when it has no answer', async () => {
    // CI stdin is non-TTY, so queryTerminalOSC resolves null immediately even
    // with supportsOsc=true: the query "fails" and the env answer applies,
    // matching a terminal that supports OSC but swallowed the query (the
    // settle-vs-evidence merge in index.tsx leans on this parity).
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.COLORFGBG = '15;0'
    const theme = await detectTerminalThemeWithSupportTestHook(true)
    expect(theme).toBe('dark')
  })
})
