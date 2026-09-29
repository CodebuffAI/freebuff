/** Terminal-safe normalization for advertiser-authored creative copy. */

import { sanitizeTerminalText } from './terminal-safe-text'

/**
 * Strip sequences that can repaint a terminal, write its clipboard, disguise
 * text direction, or break width calculations. Applied at serve even when the
 * campaign API also validates at ingest: old/admin-written rows are untrusted.
 * The general rule lives in ./terminal-safe-text.ts; creative is also trimmed.
 */
export function sanitizeAdText(input: string): string {
  return sanitizeTerminalText(input).trim()
}

export function isAdTextSafe(input: string): boolean {
  return sanitizeAdText(input) === input.trim()
}

export function sanitizeAdUrl(raw: string): string {
  const cleaned = sanitizeAdText(raw)
  let parsed: URL
  try {
    parsed = new URL(cleaned)
  } catch {
    throw new Error('creative url is not a valid absolute URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`creative url protocol not allowed: ${parsed.protocol}`)
  }
  return parsed.toString()
}
