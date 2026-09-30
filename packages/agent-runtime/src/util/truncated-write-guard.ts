/**
 * Guards against applying a file edit that was cut off mid-generation.
 *
 * Two independent checks, because a cut-off edit reaches us in two shapes:
 *
 * 1. The tool call's arguments are themselves incomplete JSON. A response
 *    that hits the model's output limit (or loses its connection) inside a
 *    tool call still delivers that call: the OpenAI-compatible provider flushes
 *    every unfinished call at end of stream with whatever argument text had
 *    arrived. OpenRouter reports such a cut as `finish_reason: "tool_calls"`
 *    (the real reason, `max_output_tokens`, is only in `native_finish_reason`),
 *    so the step looks like an ordinary tool-calling step. Parsing already
 *    fails on these, but the generic "malformed arguments, re-issue the call"
 *    error that used to answer them sent the model straight back into the
 *    same oversized write, or into "writing the file in parts" with a tool
 *    that replaces the whole file. {@link isTruncatedJsonPrefix} recognises the
 *    shape so the model is told what actually happened.
 *
 * 2. The arguments are complete, but `write_file` would replace an existing
 *    file with a much shorter copy of itself that stops mid-expression — the
 *    model rewrote the file from a view it believed was complete. See
 *    {@link detectTruncatedRewrite}.
 */

/** Tools whose call changes files on disk. A truncated call to one of these
 *  gets the "nothing was written" answer rather than the generic one. */
export const FILE_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'str_replace',
  'apply_patch',
  'propose_write_file',
  'propose_str_replace',
  'create_plan',
])

/**
 * True when `text` is the beginning of a JSON object, array or string that
 * stops before it is closed — the shape of tool-call arguments cut off
 * mid-generation. Only meaningful for text that `JSON.parse` already
 * rejected.
 *
 * Deliberately a bracket/string scanner rather than a parser: it answers
 * "was this cut short?", not "is this valid?". A closer that does not match
 * its opener is malformed rather than truncated, and returns false so that
 * case keeps the ordinary malformed-arguments error.
 */
export function isTruncatedJsonPrefix(text: string): boolean {
  const s = text.trim()
  if (!s) return false
  const first = s[0]
  if (first !== '{' && first !== '[' && first !== '"') return false

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      const open = stack.pop()
      if (open === undefined) return false
      if ((open === '{') !== (ch === '}')) return false
    }
  }
  return inString || stack.length > 0
}

/** Best-effort `path` from arguments that did not parse, for the message. */
export function extractPathFromPartialArguments(
  text: string,
): string | undefined {
  const match = text.match(/"path"\s*:\s*("(?:[^"\\]|\\.)*")/)
  if (!match) return undefined
  try {
    const path = JSON.parse(match[1]!)
    return typeof path === 'string' && path ? path : undefined
  } catch {
    return undefined
  }
}

export function truncatedToolCallMessage(
  toolName: string,
  path: string | undefined,
): string {
  const cause =
    'the response most likely hit the output token limit, or the connection dropped mid-response'
  if (!FILE_MUTATING_TOOL_NAMES.has(toolName)) {
    return `Your ${toolName} call was cut off before its arguments were complete (${cause}), so it was not run. Re-issue it with complete arguments.`
  }
  const target = path ? `\`${path}\`` : 'the file'
  return [
    `Your ${toolName} call was cut off before its arguments were complete (${cause}). It was NOT applied: nothing was written, and ${target} is unchanged on disk.`,
    'Do not re-send the same oversized call, and do not conclude that the file itself is truncated.',
    'Make smaller edits instead: change existing files with str_replace, a few targeted replacements per call. For a large new file, create it with a shorter write_file and add the remaining sections with further str_replace calls.',
    'Never write a partial version of an existing file with write_file: it replaces the entire file with exactly what you send.',
  ].join(' ')
}

/** Files shorter than this are never refused: a rewrite of a small file is
 *  cheap to redo and too small for the signals below to be meaningful. */
export const TRUNCATED_REWRITE_MIN_EXISTING_LINES = 30
/** The new content must be under this fraction of the old (by characters). */
export const TRUNCATED_REWRITE_MAX_SIZE_RATIO = 0.6

/**
 * Net count of unclosed `(`, `[` and `{`. Naive on purpose — it does not know
 * any language's strings or comments — and only ever compared against the
 * same count on the file being replaced, so a file whose literals throw the
 * count off simply never trips the guard.
 */
export function netOpenBrackets(text: string): number {
  let open = 0
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') open++
    else if (ch === ')' || ch === ']' || ch === '}') open--
  }
  return open
}

export type TruncatedRewrite = {
  oldLines: number
  newLines: number
  openBrackets: number
  lastLine: string
}

const lineCount = (text: string) => text.split('\n').length

/**
 * A `write_file` that would replace an existing file with a copy that looks
 * cut off: much shorter than the file, and ending with brackets left open
 * where the current file closes all of its own.
 *
 * All three conditions must hold, so a legitimate rewrite — a shorter file
 * that is still a complete program — is never refused. The failure this
 * catches is the one users reported on 2026-09-29: a 316-line file replaced by
 * a fragment ending in `ui.horizontal_wrapped(ui`.
 */
export function detectTruncatedRewrite(
  oldContent: string,
  newContent: string,
): TruncatedRewrite | null {
  const oldLines = lineCount(oldContent)
  if (oldLines < TRUNCATED_REWRITE_MIN_EXISTING_LINES) return null
  if (
    newContent.length >=
    oldContent.length * TRUNCATED_REWRITE_MAX_SIZE_RATIO
  ) {
    return null
  }
  if (netOpenBrackets(oldContent) !== 0) return null
  const openBrackets = netOpenBrackets(newContent)
  if (openBrackets <= 0) return null

  const trimmed = newContent.trimEnd()
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim()
  return {
    oldLines,
    newLines: lineCount(newContent),
    openBrackets,
    lastLine: lastLine.length > 120 ? `…${lastLine.slice(-120)}` : lastLine,
  }
}

export function truncatedRewriteMessage(
  path: string,
  rewrite: TruncatedRewrite,
): string {
  return [
    `Refused to write \`${path}\`: the new content (${rewrite.newLines} lines) is far shorter than the current file (${rewrite.oldLines} lines) and ends with ${rewrite.openBrackets} unclosed bracket${rewrite.openBrackets === 1 ? '' : 's'} (last line: \`${rewrite.lastLine}\`), so it looks like a cut-off copy of the file.`,
    'Nothing was written; the file on disk is unchanged.',
    'To change part of this file, use str_replace. If you really mean to replace the whole file, send its complete new content in a single write_file call.',
  ].join(' ')
}
