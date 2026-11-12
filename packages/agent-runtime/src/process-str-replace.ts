import { createPatch } from 'diff'

import { tryToDoStringReplacementWithExtraIndentation } from './generate-diffs-prompt'

import type { Logger } from '@codebuff/common/types/contracts/logger'

function normalizeLineEndings(params: { str: string }): string {
  return params.str.replace(/\r\n/g, '\n')
}

export async function processStrReplace(params: {
  path: string
  replacements: {
    oldString: string
    newString: string
    allowMultiple: boolean
  }[]
  initialContentPromise: Promise<string | null>
  logger: Logger
}): Promise<
  | {
      tool: 'str_replace'
      path: string
      content: string
      patch: string
      messages: string[]
    }
  | { tool: 'str_replace'; path: string; error: string }
> {
  const { path, replacements, initialContentPromise, logger } = params
  const initialContent = await initialContentPromise
  if (initialContent === null) {
    return {
      tool: 'str_replace',
      path,
      error:
        'The file does not exist, skipping. Please use the write_file tool to create the file.',
    }
  }

  // Process each oldString/newString pair
  let currentContent = initialContent
  let messages: string[] = []
  const lineEnding = currentContent.includes('\r\n') ? '\r\n' : '\n'

  for (const {
    oldString: oldStr,
    newString: newStr,
    allowMultiple,
  } of replacements) {
    // Regular case: require oldStr for replacements
    if (!oldStr) {
      messages.push(
        'The old string was empty, which does not match any content, skipping.',
      )
      continue
    }

    const normalizedCurrentContent = normalizeLineEndings({
      str: currentContent,
    })
    const normalizedOldStr = normalizeLineEndings({ str: oldStr })
    const normalizedNewStr = normalizeLineEndings({ str: newStr })

    // Seen 2026-11-04 from Solar Pro 4: the same replacement with oldString
    // equal to newString, re-sent until the turn was stopped, because "No
    // change to the file" alone did not say why.
    if (normalizedOldStr === normalizedNewStr) {
      messages.push(
        'The old string and the new string are identical, so this replacement changes nothing. If the file already has the text you want, this edit is done; otherwise send a new string that differs from the old one.',
      )
      continue
    }

    const match = tryMatchOldStr({
      initialContent: normalizedCurrentContent,
      oldStr: normalizedOldStr,
      newStr: normalizedNewStr,
      allowMultiple,
      logger,
    })
    let updatedOldStr: string | null
    let updatedNewStr = normalizedNewStr

    if (match.success) {
      updatedOldStr = match.oldStr
      updatedNewStr = match.newStr ?? normalizedNewStr
    } else {
      messages.push(match.error)
      updatedOldStr = null
    }

    currentContent =
      updatedOldStr === null
        ? normalizedCurrentContent
        : normalizedCurrentContent.replaceAll(
            updatedOldStr,
            () => updatedNewStr,
          )
  }

  currentContent = currentContent.replaceAll('\n', lineEnding)

  // If no successful replacements occurred, return error
  if (initialContent === currentContent) {
    logger.debug(
      {
        path,
        initialContent,
      },
      `processStrReplace: No change to ${path}`,
    )
    messages.push('No change to the file')
    return {
      tool: 'str_replace' as const,
      path,
      error: messages.join('\n\n'),
    }
  }

  let patch = createPatch(path, initialContent, currentContent)
  const lines = patch.split('\n')
  const hunkStartIndex = lines.findIndex((line) => line.startsWith('@@'))
  if (hunkStartIndex !== -1) {
    patch = lines.slice(hunkStartIndex).join('\n')
  }
  const finalPatch = patch

  logger.debug(
    {
      path,
      newContent: currentContent,
      patch: finalPatch,
      messages,
    },
    `processStrReplace: Updated file ${path}`,
  )

  return {
    tool: 'str_replace' as const,
    path,
    content: currentContent!,
    patch: finalPatch,
    messages,
  }
}

const tryMatchOldStr = (params: {
  initialContent: string
  oldStr: string
  newStr: string
  allowMultiple: boolean
  logger: Logger
}):
  | { success: true; oldStr: string; newStr?: string }
  | { success: false; error: string } => {
  const { initialContent, oldStr, newStr, allowMultiple, logger } = params
  // count the number of occurrences of oldStr in initialContent
  const count = countOccurrences(initialContent, oldStr)
  if (count === 1) {
    return { success: true, oldStr }
  }
  if (!allowMultiple && count > 1) {
    return {
      success: false,
      error: multipleOccurrencesError(oldStr, count),
    }
  }
  if (allowMultiple && count > 1) {
    // For allowMultiple=true with multiple occurrences, use the original oldStr
    return { success: true, oldStr }
  }

  const fuzzy = tryFuzzyMatch({ initialContent, oldStr, newStr, logger })
  if (fuzzy) {
    // The caller replaces every copy of the matched text, so a fuzzy match
    // must be as unique as an exact one: an edit meant for one place must
    // never rewrite its look-alikes elsewhere in the file.
    if (!allowMultiple && fuzzy.count > 1) {
      return {
        success: false,
        error: multipleOccurrencesError(oldStr, fuzzy.count),
      }
    }
    return { success: true, oldStr: fuzzy.oldStr, newStr: fuzzy.newStr }
  }

  const hint = closestMatchHint({ content: initialContent, oldStr })
  return {
    success: false,
    error:
      `The old string ${JSON.stringify(oldStr)} was not found in the file, skipping. Please try again with a different old string that matches the file content exactly.` +
      (hint ? `\n\n${hint}` : ''),
  }
}

function countOccurrences(content: string, search: string): number {
  return content.split(search).length - 1
}

function multipleOccurrencesError(oldStr: string, count: number): string {
  return `Found ${count} occurrences of ${JSON.stringify(oldStr)} in the file. Please try again with a longer (more specified) old string or set allowMultiple to true.`
}

/**
 * The matches tried after an exact one fails: extra leading indentation, then
 * all whitespace ignored. `count` is how many places the loose form fits.
 */
function tryFuzzyMatch(params: {
  initialContent: string
  oldStr: string
  newStr: string
  logger: Logger
}): { oldStr: string; newStr?: string; count: number } | null {
  const { initialContent, oldStr, newStr, logger } = params
  const newChange = tryToDoStringReplacementWithExtraIndentation({
    oldFileContent: initialContent,
    searchContent: oldStr,
    replaceContent: newStr,
  })
  if (newChange) {
    logger.debug('Matched with indentation modification')
    // Indented to match: the replacement takes the same extra indentation.
    return {
      oldStr: newChange.searchContent,
      newStr: newChange.replaceContent,
      count: countOccurrences(initialContent, newChange.searchContent),
    }
  }

  // Try matching without any whitespace as a last resort
  const noWhitespaceSearch = oldStr.replace(/\s+/g, '')
  if (!noWhitespaceSearch) return null
  const noWhitespaceOld = initialContent.replace(/\s+/g, '')
  const noWhitespaceIndex = noWhitespaceOld.indexOf(noWhitespaceSearch)
  if (noWhitespaceIndex < 0) return null

  // Count non-whitespace characters to find the real position
  let realIndex = 0
  let nonWhitespaceCount = 0
  while (nonWhitespaceCount < noWhitespaceIndex) {
    if (initialContent[realIndex].match(/\S/)) {
      nonWhitespaceCount++
    }
    realIndex++
  }
  // Skip whitespace before the first matched character
  while (
    realIndex < initialContent.length &&
    !initialContent[realIndex].match(/\S/)
  ) {
    realIndex++
  }

  // Count non-whitespace characters in search content to find length
  let searchLength = 0
  let nonWhitespaceSearchCount = 0
  while (
    nonWhitespaceSearchCount < noWhitespaceSearch.length &&
    realIndex + searchLength < initialContent.length
  ) {
    if (initialContent[realIndex + searchLength].match(/\S/)) {
      nonWhitespaceSearchCount++
    }
    searchLength++
  }

  // Find the actual content with original whitespace
  const actualContent = initialContent.slice(
    realIndex,
    realIndex + searchLength,
  )
  logger.debug('Matched with whitespace removed')
  return {
    oldStr: actualContent,
    count: countOccurrences(noWhitespaceOld, noWhitespaceSearch),
  }
}

const HINT_MAX_LINES = 20
const HINT_MAX_LINE_CHARS = 200
const HINT_MAX_CHARS = 2_000
// Shorter lines (`}`, `});`, `</div>`) appear everywhere and say nothing
// about where the old string was meant to be.
const HINT_MIN_KEY_CHARS = 4

// Curly quotes a model types as straight ones. `\s` already covers
// non-breaking spaces.
const LOOKALIKE = /[\u2018\u2019\u201C\u201D\u00A0]/

function lineKey(line: string): string {
  return line
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * On a miss, the file's lines that best fit the old string, so the model can
 * correct it in one retry instead of re-reading the file or guessing again.
 * Lines compare by content, ignoring whitespace and curly quotes;
 * the hint is shown only when at least half of the old string's lines fit.
 */
function closestMatchHint(params: {
  content: string
  oldStr: string
}): string | null {
  const oldLines = params.oldStr.split('\n')
  const oldKeys = new Set(
    oldLines.map(lineKey).filter((key) => key.length >= HINT_MIN_KEY_CHARS),
  )
  if (oldKeys.size === 0) return null

  const fileLines = params.content.split('\n')
  const hits = fileLines.map((line) => (oldKeys.has(lineKey(line)) ? 1 : 0))
  const window = Math.min(oldLines.length, fileLines.length)

  let sum = 0
  let best = 0
  let bestStart = 0
  for (let i = 0; i < fileLines.length; i++) {
    sum += hits[i] - (i >= window ? hits[i - window] : 0)
    if (sum > best) {
      best = sum
      bestStart = Math.max(0, i - window + 1)
    }
  }
  if (best < Math.ceil(oldKeys.size / 2)) return null

  const from = Math.max(0, bestStart - 1)
  const to = Math.min(
    fileLines.length,
    bestStart + window + 1,
    from + HINT_MAX_LINES,
  )
  const width = String(to).length
  let body = ''
  for (let i = from; i < to; i++) {
    let line = fileLines[i]
    if (line.length > HINT_MAX_LINE_CHARS) {
      line = `${line.slice(0, HINT_MAX_LINE_CHARS)}…`
    }
    const row = `${String(i + 1).padStart(width)} | ${line}\n`
    if (body.length + row.length > HINT_MAX_CHARS) break
    body += row
  }

  const region = fileLines.slice(bestStart, bestStart + window).join('\n')
  const lookalikeNote =
    LOOKALIKE.test(region) && !LOOKALIKE.test(params.oldStr)
      ? ' These lines contain curly quotes or non-breaking spaces where your old string has plain ones; copy them exactly.'
      : ''
  return `The closest matching lines in the file are below (the line numbers and " | " are not part of the file). They may not be the place you meant.${lookalikeNote}\n${body.trimEnd()}`
}
