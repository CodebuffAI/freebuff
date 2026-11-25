import * as path from 'node:path'

import {
  DEFAULT_MAX_FILES,
  flattenTree,
  getProjectFileTree,
} from '@codebuff/common/project-file-tree'
import micromatch from 'micromatch'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

export async function glob(params: {
  pattern: string
  projectPath: string
  cwd?: string
  maxResults?: number
  fs: CodebuffFileSystem
}): Promise<CodebuffToolOutput<'glob'>> {
  const { pattern, projectPath, cwd, maxResults, fs } = params

  try {
    const fileTree = await getProjectFileTree({ projectRoot: projectPath, fs })
    const flattenedNodes = flattenTree(fileTree)
    let allFilePaths = flattenedNodes
      .filter((node) => node.type === 'file')
      .map((node) => node.filePath)

    if (cwd) {
      // Tree paths are project-relative and use '/' on every platform.
      const normalizedCwd = path
        .normalize(cwd)
        .split(path.sep)
        .join('/')
        .replace(/\/$/, '')
      if (normalizedCwd !== '.') {
        const cwdPrefix = `${normalizedCwd}/`
        allFilePaths = allFilePaths.filter(
          (filePath) =>
            filePath === normalizedCwd || filePath.startsWith(cwdPrefix),
        )
      }
    }

    const allMatchingFiles = micromatch(allFilePaths, pattern)
    const matchingFiles =
      maxResults === undefined
        ? allMatchingFiles
        : allMatchingFiles.slice(0, maxResults)
    const resultsCapped = matchingFiles.length < allMatchingFiles.length

    // The scan behind this stops silently at DEFAULT_MAX_FILES, breadth-first,
    // so on a large project the deepest directories are never visited and every
    // pattern below the cut-off answers "0 files". Say the scan was partial
    // instead of letting the agent read that as proof the files don't exist.
    const truncated = flattenedNodes.length >= DEFAULT_MAX_FILES

    return [
      {
        type: 'json',
        value: {
          files: matchingFiles,
          count: allMatchingFiles.length,
          message:
            `Found ${allMatchingFiles.length} file(s) matching pattern "${pattern}"${cwd ? ` in directory "${cwd}"` : ''}` +
            (resultsCapped
              ? `. Showing the first ${matchingFiles.length}; narrow the pattern or set cwd to see the rest.`
              : '') +
            (truncated
              ? `. Warning: the project scan hit its ${DEFAULT_MAX_FILES}-file limit, so the deepest directories were not searched and this result may be incomplete. Narrow the search with cwd, or use run_terminal_command (find/dir) to check.`
              : ''),
        },
      },
    ]
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return [
      {
        type: 'json',
        value: {
          errorMessage: `Failed to search for files: ${errorMessage}`,
        },
      },
    ]
  }
}
