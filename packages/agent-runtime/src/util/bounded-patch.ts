import { createPatch, formatPatch } from 'diff'

/**
 * jsdiff's line diff is Myers, O((N+M)·D) in time, and it runs synchronously.
 * A str_replace on a large file with mixed line endings rewrites every LF line
 * (process-str-replace.ts re-applies one ending), so D is the whole file: on
 * 2026-11-23 one such edit held a Cloud runner's event loop for 9-17 minutes,
 * every chat lease on it lapsed, and each restart of the turn froze the next
 * runner (7 runners in a row, ~100 turns cut). A 32k-line mixed file took
 * ~70 s; with these caps a 100k-line one takes ~0.25 s.
 */
export const PATCH_MAX_EDIT_LINES = 2_000
/** Backstop for a huge file whose edit stays under the line cap. */
export const PATCH_DIFF_TIMEOUT_MS = 1_000
/** jsdiff's default context. */
const CONTEXT_LINES = 4

/**
 * `createPatch`, but never one that blocks the process for long: past the
 * caps it returns a single hunk from the first changed line to the last one.
 * Both apply with `applyPatch` to give exactly `newStr`; the fallback is just
 * not minimal.
 */
export function createBoundedPatch(
  path: string,
  oldStr: string,
  newStr: string,
): string {
  return (
    createPatch(path, oldStr, newStr, undefined, undefined, {
      maxEditLength: PATCH_MAX_EDIT_LINES,
      timeout: PATCH_DIFF_TIMEOUT_MS,
    }) ?? spanPatch(path, oldStr, newStr)
  )
}

/** Lines with their `\n` kept, as jsdiff compares them. */
function linesOf(text: string): string[] {
  if (!text) return []
  const parts = text.split('\n')
  const lines = parts.map((line, i) =>
    i < parts.length - 1 ? `${line}\n` : line,
  )
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** One hunk over everything between the common first and last lines. O(N). */
export function spanPatch(path: string, oldStr: string, newStr: string) {
  const a = linesOf(oldStr)
  const b = linesOf(newStr)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++
  const lead = Math.min(start, CONTEXT_LINES)
  const trail = Math.min(end, CONTEXT_LINES)
  const lines: string[] = []
  // Only a file's last line can lack its newline; jsdiff marks it after that line.
  const push = (prefix: ' ' | '-' | '+', line: string) => {
    if (line.endsWith('\n')) lines.push(prefix + line.slice(0, -1))
    else lines.push(prefix + line, '\\ No newline at end of file')
  }
  for (let i = start - lead; i < start; i++) push(' ', a[i])
  for (let i = start; i < a.length - end; i++) push('-', a[i])
  for (let i = start; i < b.length - end; i++) push('+', b[i])
  for (let i = a.length - end; i < a.length - end + trail; i++) push(' ', a[i])
  return formatPatch({
    oldFileName: path,
    newFileName: path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: [
      {
        oldStart: start - lead + 1,
        oldLines: a.length - end + trail - (start - lead),
        newStart: start - lead + 1,
        newLines: b.length - end + trail - (start - lead),
        lines,
      },
    ],
  })
}
