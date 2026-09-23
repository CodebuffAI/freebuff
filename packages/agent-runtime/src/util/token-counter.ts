import { Buffer } from 'node:buffer'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

// Only a fallback / estimate for content the provider has not seen yet. The
// agent loop anchors context size to each response's usage. Never BPE-tokenize
// here: one long run of spaces can otherwise block an embedded web server for
// minutes, including during resume, compaction, and cancellation.
const CHARS_PER_TOKEN = 3

/** Flat per-image/file cost. Anthropic bills a large image at ~1600 tokens; we
 *  use that ceiling instead of counting the base64 as text (which JSON.stringify
 *  would do), where a single screenshot is hundreds of thousands of chars. */
const IMAGE_TOKEN_ESTIMATE = 1600

/** Per-message structural overhead (role marker, delimiters) Anthropic adds on
 *  top of the raw content. */
const PER_MESSAGE_TOKEN_OVERHEAD = 8

// ASCII keeps the cheap three-characters-per-token estimate. UTF-8 expansion
// is charged at one token per extra byte instead of being discounted too:
// emoji and other multibyte text can be token-dense despite few JS characters.
// byteLength scans natively without allocating a buffer or invoking BPE.
function estimatedTextLength(text: string): number {
  return (
    text.length +
    (Buffer.byteLength(text, 'utf8') - text.length) * CHARS_PER_TOKEN
  )
}

export function countTokens(text: string): number {
  return Math.ceil(estimatedTextLength(text) / CHARS_PER_TOKEN)
}

export function countTokensJson(value: unknown): number {
  // Inspect lengths without serializing (and duplicating) multi-MB tool output.
  // Bound traversal too: a deeply nested/wide payload is oversized, not zero.
  let remaining = 100_000
  const ancestors = new Set<object>()
  const length = (value: unknown, depth: number): number => {
    if (--remaining < 0 || depth > 100) return Number.MAX_SAFE_INTEGER
    if (typeof value === 'string') return estimatedTextLength(value) + 2
    if (value === null) return 4
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value).length
    if (typeof value !== 'object') return 0
    if (ancestors.has(value)) return Number.MAX_SAFE_INTEGER
    ancestors.add(value)
    let total = 2
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      total +=
        (Array.isArray(value) ? 1 : estimatedTextLength(key) + 4) +
        length((value as Record<string, unknown>)[key], depth + 1)
      if (total >= Number.MAX_SAFE_INTEGER) {
        total = Number.MAX_SAFE_INTEGER
        break
      }
    }
    ancestors.delete(value)
    return total
  }
  return Math.ceil(length(value, 0) / CHARS_PER_TOKEN)
}

/**
 * Estimate tokens for a list of messages by counting the content the model
 * actually tokenizes (text, tool inputs, tool results, a flat cost per image)
 * plus a small per-message overhead — not the JSON envelope. Avoids the
 * scaffolding inflation of `countTokensJson(messages)` and, crucially, counting
 * image/file base64 character-for-character. These are cheap length estimates,
 * not exact token counts; model-reported usage takes precedence in the loop.
 */
export function countTokensMessages(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    total += PER_MESSAGE_TOKEN_OVERHEAD

    // content is typed as an array, but tolerate string / missing content the
    // same way the replaced JSON.stringify did (see getTextContent), so a stray
    // shape can't crash or mis-count the estimate.
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') {
      total += countTokens(content)
      continue
    }
    if (!Array.isArray(content)) {
      continue
    }

    for (const part of content as Array<Record<string, unknown>>) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          total += countTokens(part.text as string)
          break
        case 'tool-call':
          total +=
            countTokens(part.toolName as string) + countTokensJson(part.input)
          break
        case 'json': // tool result payload
          total += countTokensJson(part.value)
          break
        case 'image':
        case 'file':
        case 'media':
          total += IMAGE_TOKEN_ESTIMATE
          break
        default: // unknown shape: JSON fallback so we never under-count
          total += countTokensJson(part)
      }
    }
  }
  return total
}

export function countTokensForFiles(
  files: Record<string, string | null>,
): Record<string, number> {
  const tokenCounts: Record<string, number> = {}
  for (const [filePath, content] of Object.entries(files)) {
    tokenCounts[filePath] = content ? countTokens(content) : 0
  }
  return tokenCounts
}
