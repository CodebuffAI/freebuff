/**
 * Terminal-safe normalization for text a remote party wrote and a terminal UI
 * will draw: advertiser creative, server notices, error messages from a
 * response body.
 *
 * A terminal interprets bytes, not strings. Text that reaches it with an ESC
 * or C1 control intact can write the user's clipboard (OSC 52), draw a link
 * whose visible text is not its target (OSC 8), move the cursor and repaint
 * other parts of the screen (CSI), retitle the window, or flip text direction
 * so a reviewer and the user read different words. The renderer does not
 * filter these, so every such string is cleaned before it is drawn.
 */

const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g
const STRING_COMMAND =
  /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x07|\x9c|$)/g
const SHORT_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g
/** C0 except `\n`, DEL, and C1. `\t` and `\r` are normalized before this. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Unicode Default_Ignorable_Code_Point characters are invisible, so they can
 * split a prohibited word or change its display without changing what a
 * reviewer sees. Keep this explicit rather than relying on a runtime Unicode
 * table: creative validation must be deterministic across our supported Bun
 * and browser runtimes. This covers the full property as of Unicode 16,
 * including bidi controls, tags, and both variation-selector blocks.
 */
const DEFAULT_IGNORABLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu

/**
 * Strip every escape sequence (OSC, DCS/SOS/PM/APC, CSI, short ESC, 7- and
 * 8-bit forms), every other C0/C1 control, and the invisible Unicode
 * formatting characters. Newlines survive (CR and CRLF become `\n`); a tab
 * becomes two spaces. Printable text is otherwise unchanged and NOT trimmed,
 * so indentation in a diagram or a code sample keeps its shape.
 */
export function sanitizeTerminalText(input: string): string {
  return input
    .replace(OSC, '')
    .replace(STRING_COMMAND, '')
    .replace(CSI, '')
    .replace(SHORT_ESCAPE, '')
    .replace(DEFAULT_IGNORABLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROL, '')
}

/**
 * {@link sanitizeTerminalText} applied to every string inside a parsed JSON
 * value (object keys excluded), returning a copy of the same shape. For a
 * response body whose free-text fields are drawn in the terminal: sanitizing
 * the whole document at the parse site means a field added later is covered
 * without anyone remembering to. Identifiers and URLs are unaffected — no
 * legitimate one contains a control character.
 */
export function sanitizeTerminalStrings<T>(value: T): T {
  return sanitizeValue(value, 0) as T
}

const MAX_DEPTH = 32

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeTerminalText(value)
  if (value === null || typeof value !== 'object') return value
  // Anything nested deeper than a real response is dropped rather than walked.
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1))
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeValue(item, depth + 1)
  }
  return out
}
