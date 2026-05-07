import path, { isAbsolute } from 'path'

import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import { isFileIgnored } from '@codebuff/common/project-file-tree'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { FileFilter } from './read-files'

const DEFAULT_MAX_LINES = 2000
const DEFAULT_MAX_BYTES = 50 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024

export type ReadFileResult =
  | {
      path: string
      content: string
    }
  | {
      errorMessage: string
    }

type TruncationResult = {
  content: string
  outputLines: number
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  firstLineExceedsLimit: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function truncateHead(content: string): TruncationResult {
  const lines = content.split('\n')
  const outputLines: string[] = []
  let outputBytes = 0

  for (const line of lines) {
    if (outputLines.length >= DEFAULT_MAX_LINES) {
      return {
        content: outputLines.join('\n'),
        outputLines: outputLines.length,
        truncated: true,
        truncatedBy: 'lines',
        firstLineExceedsLimit: false,
      }
    }

    const lineBytes =
      Buffer.byteLength(line, 'utf8') + (outputLines.length > 0 ? 1 : 0)
    if (outputLines.length === 0 && lineBytes > DEFAULT_MAX_BYTES) {
      return {
        content: '',
        outputLines: 0,
        truncated: true,
        truncatedBy: 'bytes',
        firstLineExceedsLimit: true,
      }
    }
    if (outputBytes + lineBytes > DEFAULT_MAX_BYTES) {
      return {
        content: outputLines.join('\n'),
        outputLines: outputLines.length,
        truncated: true,
        truncatedBy: 'bytes',
        firstLineExceedsLimit: false,
      }
    }

    outputLines.push(line)
    outputBytes += lineBytes
  }

  return {
    content: outputLines.join('\n'),
    outputLines: outputLines.length,
    truncated: false,
    truncatedBy: null,
    firstLineExceedsLimit: false,
  }
}

function getFileErrorResult(error: unknown): ReadFileResult {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    return { errorMessage: FILE_READ_STATUS.DOES_NOT_EXIST }
  }
  return { errorMessage: FILE_READ_STATUS.ERROR }
}

function formatReadContent(params: {
  allLines: string[]
  startLine: number
  limit?: number
}): string {
  const { allLines, startLine, limit } = params
  const startLineDisplay = startLine + 1
  const endLine =
    limit === undefined
      ? allLines.length
      : Math.min(startLine + limit, allLines.length)
  const selectedContent = allLines.slice(startLine, endLine).join('\n')
  const truncation = truncateHead(selectedContent)

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(
      Buffer.byteLength(allLines[startLine], 'utf8'),
    )
    return `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(
      DEFAULT_MAX_BYTES,
    )} limit. Use run_terminal_command to inspect this line.]`
  }

  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1
    const nextOffset = endLineDisplay + 1
    const limitNote =
      truncation.truncatedBy === 'bytes'
        ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`
        : ''
    return `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}${limitNote}. Use offset=${nextOffset} to continue.]`
  }

  if (endLine < allLines.length) {
    const remaining = allLines.length - endLine
    return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`
  }

  return truncation.content
}

function resolveProjectPath(params: {
  filePath: string
  cwd: string
}): { relativePath: string; fullPath: string } | { errorMessage: string } {
  const { filePath, cwd } = params
  const projectRoot = path.resolve(cwd)
  const relativePath = filePath.startsWith(projectRoot)
    ? path.relative(projectRoot, filePath)
    : filePath
  const fullPath = path.resolve(projectRoot, relativePath)

  if (
    isAbsolute(relativePath) ||
    (fullPath !== projectRoot && !fullPath.startsWith(projectRoot + path.sep))
  ) {
    return { errorMessage: FILE_READ_STATUS.OUTSIDE_PROJECT }
  }

  return { relativePath, fullPath }
}

export async function readFile(params: {
  filePath: string
  cwd: string
  fs: CodebuffFileSystem
  offset?: number
  limit?: number
  fileFilter?: FileFilter
}): Promise<ReadFileResult> {
  const { filePath, cwd, fs, offset, limit, fileFilter } = params

  const resolved = resolveProjectPath({ filePath, cwd })
  if ('errorMessage' in resolved) {
    return resolved
  }

  const { relativePath, fullPath } = resolved
  const filterResult = fileFilter?.(relativePath)
  if (filterResult?.status === 'blocked') {
    return { errorMessage: FILE_READ_STATUS.IGNORED }
  }
  const isExampleFile = filterResult?.status === 'allow-example'

  if (!fileFilter && !isExampleFile) {
    const ignored = await isFileIgnored({
      filePath: relativePath,
      projectRoot: cwd,
      fs,
    })
    if (ignored) {
      return { errorMessage: FILE_READ_STATUS.IGNORED }
    }
  }

  let stats: Awaited<ReturnType<CodebuffFileSystem['stat']>>
  try {
    stats = await fs.stat(fullPath)
  } catch (error) {
    return getFileErrorResult(error)
  }

  if (stats.isDirectory()) {
    return { errorMessage: `Cannot read directory: ${relativePath}` }
  }
  if (stats.size > MAX_FILE_BYTES) {
    return {
      errorMessage:
        FILE_READ_STATUS.TOO_LARGE +
        ` [${formatSize(stats.size)} exceeds ${formatSize(
          MAX_FILE_BYTES,
        )} limit. Use code_search or glob to find specific content.]`,
    }
  }

  let textContent: string
  try {
    textContent = await fs.readFile(fullPath, 'utf8')
  } catch (error) {
    return getFileErrorResult(error)
  }

  const allLines = textContent.split('\n')
  const startLine = offset ? offset - 1 : 0

  if (startLine >= allLines.length) {
    return {
      errorMessage: `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
    }
  }

  const outputText = formatReadContent({ allLines, startLine, limit })
  return {
    path: relativePath,
    content: isExampleFile
      ? FILE_READ_STATUS.TEMPLATE + '\n' + outputText
      : outputText,
  }
}
