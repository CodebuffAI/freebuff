import { FILE_READ_STATUS } from '../constants/paths'

import type { FileReadWindow } from '../types/contracts/client'

/** Maximum source characters returned by one read_files tool call. */
export const MAX_READ_FILES_CHARS = 100_000

/** Maximum estimated tokens returned by one read_files tool call. */
export const MAX_READ_FILES_TOKENS = 20_000

/** Maximum lines returned per file in one read_files tool call. */
export const MAX_READ_FILE_LINES = 2_000

/** Maximum characters returned per file in one read_files tool call. */
export const MAX_READ_FILE_CHARS = 50_000

export function windowFileRead(
  content: string,
  offset?: number,
  limit?: number,
): string {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const totalLines = lines.length
  const safeOffset = offset !== undefined && Number.isFinite(offset) ? offset : 1
  const safeLimit = limit !== undefined && Number.isFinite(limit) ? limit : MAX_READ_FILE_LINES
  const start = Math.max(1, Math.floor(safeOffset))
  const maxLines = Math.min(
    Math.max(1, Math.floor(safeLimit)),
    MAX_READ_FILE_LINES,
  )

  if (start > totalLines) {
    return `[read_files: ${totalLines} lines total; offset ${start} is beyond the end of the file.]`
  }

  let end = Math.min(totalLines, start - 1 + maxLines)
  let selected = lines.slice(start - 1, end).join('\n')
  let charCapped = false
  if (selected.length > MAX_READ_FILE_CHARS) {
    charCapped = true
    let chars = 0
    let count = 0
    for (let i = start - 1; i < end; i++) {
      const lineLength = lines[i].length + (count > 0 ? 1 : 0)
      if (chars + lineLength > MAX_READ_FILE_CHARS && count > 0) break
      chars += lineLength
      count++
    }
    end = start - 1 + count
    selected = lines.slice(start - 1, end).join('\n')
  }

  if (start === 1 && end === totalLines) {
    return content
  }

  const charCapNote = charCapped
    ? ` The window was shortened to stay under ${MAX_READ_FILE_CHARS.toLocaleString()} characters.`
    : ''
  const continueNote =
    end < totalLines
      ? ` Use code_search to locate the part you need and read a window around it, or call read_files again with offset=${end + 1} to continue.`
      : ''
  return `${selected}\n\n[read_files: showing lines ${start}-${end} of ${totalLines}.${charCapNote}${continueNote}]`
}

export type FileReadWindows = Record<string, FileReadWindow[]>

/**
 * Read the line windows a `windowedFileReads` agent forwarded with a read_files
 * call, if any. Absent for every other agent, and that absence is what keeps
 * the legacy whole-file behavior.
 *
 * Hosted surfaces (Freebuff Web/Cloud on Daytona, and the browser runtime) run
 * read_files through their own override rather than the SDK's local reader, so
 * each has to pick the windows out of the tool input itself.
 */
export function fileReadWindowsOf(input: unknown): FileReadWindows | undefined {
  const windows =
    input && typeof input === 'object'
      ? (input as { fileWindows?: unknown }).fileWindows
      : undefined
  return windows && typeof windows === 'object' && !Array.isArray(windows)
    ? (windows as FileReadWindows)
    : undefined
}

/**
 * Apply one file's windows to its content.
 *
 * Call this BEFORE the read budget (`createFileReadLimiter`), the order the
 * SDK's local reader uses. The other way round, an offset past the budget's
 * truncation point answers "beyond the end of the file" for a file that has
 * those lines.
 *
 * A path with no explicit window still goes through `windowFileRead`, which is
 * where the per-file 2,000-line cap comes from — that cap, more than the
 * explicit offsets, is what a windowed agent saves on a large file.
 */
export function applyFileReadWindows(
  content: string,
  windows: FileReadWindow[] | undefined,
): string {
  // `Array.isArray`, not a truthiness check on `.length`: callers look these up
  // by a model-supplied path in a map that lost its null prototype crossing the
  // wire as JSON, so `windows` can be `Function.prototype` for a file named
  // `constructor` — truthy, with a `.length` of 1 and no `.map`.
  const list = Array.isArray(windows) && windows.length > 0 ? windows : [{}]
  return list
    .map((window) => windowFileRead(content, window?.offset, window?.limit))
    .join('\n\n')
}

/** Small chunks avoid pathological BPE runtimes on repetitive Unicode. */
const TOKEN_CHUNK_CHARS = 1_024

type LimitedFileRead = {
  content: string
  includedChars: number
  includedTokens: number
}

type FileReadLimiterOptions = {
  /** A conservative local token estimator, including any desired safety factor. */
  countTokens?: (text: string) => number
}

function avoidSplittingSurrogatePair(text: string, end: number): number {
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff
  ) {
    return end - 1
  }
  return end
}

function limitContentByTokens(
  content: string,
  tokenBudget: number,
  countTokens: (text: string) => number,
): { chars: number; tokens: number; truncated: boolean } {
  let chars = 0
  let tokens = 0

  while (chars < content.length) {
    let chunkEnd = Math.min(chars + TOKEN_CHUNK_CHARS, content.length)
    chunkEnd = avoidSplittingSurrogatePair(content, chunkEnd)
    if (chunkEnd === chars) chunkEnd++

    const chunk = content.slice(chars, chunkEnd)
    const chunkTokens = countTokens(chunk)
    if (tokens + chunkTokens <= tokenBudget) {
      chars = chunkEnd
      tokens += chunkTokens
      continue
    }
    // Keep only complete, independently verified chunks. This can leave less
    // than one chunk of budget unused, but avoids costly exact-prefix fitting.
    return { chars, tokens, truncated: true }
  }

  return { chars, tokens, truncated: false }
}

function limitFileReadContent(
  content: string,
  remainingChars: number,
  remainingTokens: number,
  countTokens?: (text: string) => number,
): LimitedFileRead {
  const charLimit = Math.min(content.length, Math.max(0, remainingChars))
  const safeCharLimit = avoidSplittingSurrogatePair(content, charLimit)
  const charLimitedContent = content.slice(0, safeCharLimit)
  const tokenBudget = Math.max(0, remainingTokens)
  const tokenLimit = countTokens
    ? limitContentByTokens(charLimitedContent, tokenBudget, countTokens)
    : {
        chars: charLimitedContent.length,
        tokens: 0,
        truncated: false,
      }
  const includedChars = tokenLimit.chars
  const includedTokens = tokenLimit.tokens

  if (includedChars === content.length) {
    return { content, includedChars, includedTokens }
  }

  let notice: string
  if (tokenLimit.truncated) {
    const hitAggregateLimit = remainingTokens < MAX_READ_FILES_TOKENS
    notice = hitAggregateLimit
      ? `${FILE_READ_STATUS.TOO_LARGE}: The combined read_files output exceeded the ${MAX_READ_FILES_TOKENS.toLocaleString()} estimated-token limit. This file was truncated after ${includedTokens.toLocaleString()} estimated tokens. Read it separately or use code_search for the relevant section.`
      : `${FILE_READ_STATUS.TOO_LARGE}: This file exceeded the ${MAX_READ_FILES_TOKENS.toLocaleString()} estimated-token per-file limit. It was truncated after ${includedTokens.toLocaleString()} estimated tokens. Use code_search or a more targeted read for the relevant section.`
  } else {
    const hitAggregateLimit = remainingChars < MAX_READ_FILES_CHARS
    notice = hitAggregateLimit
      ? `${FILE_READ_STATUS.TOO_LARGE}: The combined read_files output exceeded the ${MAX_READ_FILES_CHARS.toLocaleString()} character hard limit. This file was truncated after ${includedChars.toLocaleString()} characters. Read it separately or use code_search for the relevant section.`
      : `${FILE_READ_STATUS.TOO_LARGE}: This file is ${content.length.toLocaleString()} characters, exceeding the ${MAX_READ_FILES_CHARS.toLocaleString()} character hard limit. The content above has been truncated. Use code_search or a more targeted read for the relevant section.`
  }

  return {
    content:
      includedChars === 0
        ? notice
        : `${content.slice(0, includedChars)}\n\n${notice}`,
    includedChars,
    includedTokens,
  }
}

/**
 * Creates an ordered limiter for one read_files invocation. Status/error
 * messages should bypass this limiter so they do not consume the content
 * budget.
 */
export function createFileReadLimiter(options: FileReadLimiterOptions = {}) {
  let remainingChars = MAX_READ_FILES_CHARS
  let remainingTokens = MAX_READ_FILES_TOKENS

  return {
    limit(content: string): string {
      const limited = limitFileReadContent(
        content,
        remainingChars,
        remainingTokens,
        options.countTokens,
      )
      remainingChars -= limited.includedChars
      remainingTokens -= limited.includedTokens
      return limited.content
    },
  }
}
