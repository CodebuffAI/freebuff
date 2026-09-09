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

    const match = tryMatchOldStr({
      initialContent: normalizedCurrentContent,
      oldStr: normalizedOldStr,
      newStr: normalizedNewStr,
      allowMultiple,
      logger,
    })
    let updatedOldStr: string | null

    if (match.success) {
      updatedOldStr = match.oldStr
    } else {
      messages.push(match.error)
      updatedOldStr = null
    }

    currentContent =
      updatedOldStr === null
        ? normalizedCurrentContent
        : normalizedCurrentContent.replaceAll(
            updatedOldStr,
            () => normalizedNewStr,
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
}): { success: true; oldStr: string } | { success: false; error: string } => {
  const { initialContent, oldStr, newStr, allowMultiple, logger } = params
  // count the number of occurrences of oldStr in initialContent
  const count = initialContent.split(oldStr).length - 1
  if (count === 1) {
    return { success: true, oldStr }
  }
  if (!allowMultiple && count > 1) {
    return {
      success: false,
      error: `Found ${count} occurrences of ${JSON.stringify(oldStr)} in the file. Please try again with a longer (more specified) old string or set allowMultiple to true.`,
    }
  }
  if (allowMultiple && count > 1) {
    // For allowMultiple=true with multiple occurrences, use the original oldStr
    return { success: true, oldStr }
  }

  const newChange = tryToDoStringReplacementWithExtraIndentation({
    oldFileContent: initialContent,
    searchContent: oldStr,
    replaceContent: newStr,
  })
  if (newChange) {
    logger.debug('Matched with indentation modification')
    return { success: true, oldStr: newChange.searchContent }
  } else {
    // Try matching without any whitespace as a last resort
    const noWhitespaceSearch = oldStr.replace(/\s+/g, '')
    const noWhitespaceOld = initialContent.replace(/\s+/g, '')
    // An old string made only of whitespace has nothing left to search for
    // once its whitespace is stripped, and `indexOf('')` would vacuously
    // succeed at position 0, producing an empty match that `replaceAll` then
    // turns into newStr inserted between every character of the file.
    const noWhitespaceIndex =
      noWhitespaceSearch === ''
        ? -1
        : noWhitespaceOld.indexOf(noWhitespaceSearch)

    if (noWhitespaceIndex >= 0) {
      // Count non-whitespace characters to find the real position
      let realIndex = 0
      let nonWhitespaceCount = 0
      while (nonWhitespaceCount < noWhitespaceIndex) {
        if (initialContent[realIndex].match(/\S/)) {
          nonWhitespaceCount++
        }
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
      if (initialContent.includes(actualContent)) {
        logger.debug('Matched with whitespace removed')
        return { success: true, oldStr: actualContent }
      }
    }
  }
  return {
    success: false,
    error: `The old string ${JSON.stringify(oldStr)} was not found in the file, skipping. Please try again with a different old string that matches the file content exactly.`,
  }
}
