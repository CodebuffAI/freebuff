import { countTokens } from '@codebuff/agent-runtime/util/token-counter'
import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import { isFileIgnored } from '@codebuff/common/project-file-tree'
import {
  isEnvTemplateFilePath,
  isSensitiveEnvFilePath,
} from '@codebuff/common/util/env-file-path'
import {
  createFileReadLimiter,
  windowFileRead,
} from '@codebuff/common/util/file-read-limits'

import { resolveFilePath } from './path-utils'

import type { FileReadWindow } from '@codebuff/common/types/contracts/client'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

export type FileFilterResult = {
  status: 'blocked' | 'allow-example' | 'allow'
}

export type FileFilter = (filePath: string) => FileFilterResult

export async function getFiles(params: {
  filePaths: string[]
  cwd: string
  fs: CodebuffFileSystem
  fileWindows?: Record<string, FileReadWindow[]>
  /**
   * Apply the user-facing read_files output budget. Internal edit tools need
   * the complete file so replacements below the display limit can still match.
   */
  limitContent?: boolean
  /** Apply the read_files-only .env restriction. */
  enforceEnvPolicy?: boolean
  /**
   * Filter to classify files before reading.
   * If provided, the caller takes control of additional filtering. The SDK's
   * read_files .env policy applies by default, including ordinary gitignore
   * checks for env templates.
   */
  fileFilter?: FileFilter
}) {
  const {
    filePaths,
    cwd,
    fs,
    fileWindows,
    fileFilter,
    limitContent = true,
    enforceEnvPolicy = true,
  } = params
  // If the caller provides a filter, they own additional filtering decisions.
  // Otherwise the SDK also applies default gitignore checking.
  const hasCustomFilter = fileFilter !== undefined

  const result = Object.create(null) as Record<string, string | null>
  const seenPaths = new Set<string>()
  const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB - skip reading entirely
  const limiter = limitContent ? createFileReadLimiter({ countTokens }) : null

  for (const filePath of filePaths) {
    if (!filePath) {
      continue
    }

    const { relativePath, fullPath, isWithinProject } = resolveFilePath(
      cwd,
      filePath,
    )
    if (seenPaths.has(relativePath)) {
      continue
    }
    seenPaths.add(relativePath)

    if (enforceEnvPolicy && isSensitiveEnvFilePath(relativePath)) {
      result[relativePath] = FILE_READ_STATUS.IGNORED
      continue
    }

    // Apply file filter if provided
    const filterResult = fileFilter?.(relativePath)
    if (filterResult?.status === 'blocked') {
      result[relativePath] = FILE_READ_STATUS.IGNORED
      continue
    }
    const isEnvTemplate =
      enforceEnvPolicy && isEnvTemplateFilePath(relativePath)
    const isExampleFile =
      isEnvTemplate || filterResult?.status === 'allow-example'

    // Custom-filter callers own ordinary filtering decisions, except that env
    // templates must still obey gitignore when the read_files policy is active.
    if ((!hasCustomFilter || isEnvTemplate) && isWithinProject) {
      const ignored = await isFileIgnored({
        filePath: relativePath,
        projectRoot: cwd,
        fs,
        ...(isEnvTemplate ? { allowEnvTemplate: true } : {}),
      })
      if (ignored) {
        result[relativePath] = FILE_READ_STATUS.IGNORED
        continue
      }
    }

    try {
      // Safety check: skip reading files over 10MB to avoid OOM
      const stats = await fs.stat(fullPath)
      if (stats.size > MAX_FILE_BYTES) {
        result[relativePath] =
          FILE_READ_STATUS.TOO_LARGE +
          ` [${(stats.size / (1024 * 1024)).toFixed(1)}MB exceeds 10MB limit. Use code_search or glob to find specific content.]`
        continue
      }

      const content = await fs.readFile(fullPath, 'utf8')

      const windows =
        fileWindows?.[filePath] ??
        fileWindows?.[relativePath] ??
        (fullPath ? fileWindows?.[fullPath] : undefined)
      const windowedContent =
        limitContent && fileWindows !== undefined
          ? (windows?.length ? windows : [{}])
              .map((window: FileReadWindow) =>
                windowFileRead(content, window.offset, window.limit),
              )
              .join('\n\n')
          : content
      const returnedContent = limiter?.limit(windowedContent) ?? windowedContent
      result[relativePath] = isExampleFile
        ? FILE_READ_STATUS.TEMPLATE + '\n' + returnedContent
        : returnedContent
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        result[relativePath] = FILE_READ_STATUS.DOES_NOT_EXIST
      } else {
        result[relativePath] = FILE_READ_STATUS.ERROR
      }
    }
  }
  return { ...result }
}
