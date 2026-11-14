import path from 'path'

import { countTokens } from '@codebuff/agent-runtime/util/token-counter'
import {
  getImageMimeType,
  isProviderSupportedImageMediaType,
  MAX_IMAGE_BASE64_SIZE,
} from '@codebuff/common/constants/images'
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
import {
  PROJECT_UNDERSTANDING_NON_TEXT_MESSAGE,
  isProjectUnderstandingNonTextPath,
  looksLikeBinaryContent,
} from '@codebuff/common/project-understanding/non-text-files'
import { projectUnderstandingReadRefusal } from '@codebuff/common/project-understanding/skipped-files'

import { resolveFilePath } from './path-utils'

import type {
  FileReadWindow,
  RequestImageFileFn,
} from '@codebuff/common/types/contracts/client'
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
  /**
   * Refuse what the project-understanding agent never reads: non-text files
   * (by extension before reading, and by a NUL in the first 4 KB after), and
   * lockfiles, generated files and files over 100 KB (by path, then by the
   * stat's size, before reading; skipped-files.ts). Off by default; only the
   * project-understanding agent's run sets it
   * (`RunOptions.refuseNonTextFileReads`).
   */
  refuseNonText?: boolean
}) {
  const {
    filePaths,
    cwd,
    fs,
    fileWindows,
    fileFilter,
    limitContent = true,
    enforceEnvPolicy = true,
    refuseNonText = false,
  } = params
  // If the caller provides a filter, they own additional filtering decisions.
  // Otherwise explicit reads honor agent ignore files, not discovery exclusions.
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

    if (refuseNonText && isProjectUnderstandingNonTextPath(relativePath)) {
      result[relativePath] =
        `${FILE_READ_STATUS.IGNORED} ${PROJECT_UNDERSTANDING_NON_TEXT_MESSAGE}`
      continue
    }
    const pathRefusal = refuseNonText
      ? projectUnderstandingReadRefusal(relativePath)
      : null
    if (pathRefusal) {
      result[relativePath] = pathRefusal
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

    // Explicit reads may name Git-ignored artifacts. Keep the full discovery
    // policy for env templates and the background project-understanding agent.
    if ((!hasCustomFilter || isEnvTemplate) && isWithinProject) {
      const ignored = await isFileIgnored({
        filePath: relativePath,
        projectRoot: cwd,
        fs,
        ...(isEnvTemplate ? { allowEnvTemplate: true } : {}),
        ...(!isEnvTemplate && !refuseNonText ? { explicitRead: true } : {}),
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
      const sizeRefusal = refuseNonText
        ? projectUnderstandingReadRefusal(relativePath, stats.size)
        : null
      if (sizeRefusal) {
        result[relativePath] = sizeRefusal
        continue
      }

      const content = await fs.readFile(fullPath, 'utf8')
      if (refuseNonText && looksLikeBinaryContent(content)) {
        result[relativePath] =
          `${FILE_READ_STATUS.IGNORED} ${PROJECT_UNDERSTANDING_NON_TEXT_MESSAGE}`
        continue
      }

      const windows = fileWindows?.[filePath]
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

/**
 * The largest image read_files attaches: the base64 ceiling the CLI enforces on
 * a pasted image after compressing it. The SDK has no image codec to shrink a
 * larger file, so the refusal tells the model how to make a smaller copy.
 */
const MAX_IMAGE_READ_BYTES = Math.floor((MAX_IMAGE_BASE64_SIZE * 3) / 4)

/** read_files for an image: the same policy as `getFiles`, but the bytes. */
export async function getImageFile(params: {
  filePath: string
  cwd: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
}): ReturnType<RequestImageFileFn> {
  const { filePath, cwd, fs, fileFilter } = params
  const { relativePath, fullPath, isWithinProject } = resolveFilePath(
    cwd,
    filePath,
  )
  const ext = path.extname(relativePath)
  const mediaType = getImageMimeType(ext)
  if (!mediaType) return { path: relativePath, error: FILE_READ_STATUS.ERROR }
  // A BMP or TIFF is an image we recognise but no vision provider decodes:
  // attached anyway, it 400s this turn AND every later turn of the thread
  // (history is replayed) with "unsupported image ... webp, png, jpeg, and
  // gif". Refuse here, where the model can still act on it.
  if (!isProviderSupportedImageMediaType(mediaType)) {
    return {
      path: relativePath,
      error:
        FILE_READ_STATUS.ERROR +
        ` [${ext} images cannot be attached; models accept only PNG, JPEG, GIF and WebP. Convert it with a terminal command (for example \`magick ${relativePath} /tmp/preview.png\`) and read that instead.]`,
    }
  }
  if (
    isSensitiveEnvFilePath(relativePath) ||
    fileFilter?.(relativePath).status === 'blocked'
  ) {
    return { path: relativePath, error: FILE_READ_STATUS.IGNORED }
  }
  if (
    !fileFilter &&
    isWithinProject &&
    (await isFileIgnored({
      filePath: relativePath,
      projectRoot: cwd,
      fs,
      explicitRead: true,
    }))
  ) {
    return { path: relativePath, error: FILE_READ_STATUS.IGNORED }
  }

  try {
    const stats = await fs.stat(fullPath)
    if (stats.size > MAX_IMAGE_READ_BYTES) {
      const kb = (bytes: number) => Math.round(bytes / 1024)
      return {
        path: relativePath,
        error:
          FILE_READ_STATUS.TOO_LARGE +
          ` [Image is ${kb(stats.size)} KB; images over ${kb(MAX_IMAGE_READ_BYTES)} KB cannot be attached. Save a downscaled copy with a terminal command (for example \`magick ${relativePath} -resize 1024x1024 /tmp/preview.png\`) and read that instead.]`,
      }
    }
    const data = Buffer.from(await fs.readFile(fullPath)).toString('base64')
    return { path: relativePath, data, mediaType, bytes: stats.size }
  } catch (error) {
    const missing =
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    return {
      path: relativePath,
      error: missing ? FILE_READ_STATUS.DOES_NOT_EXIST : FILE_READ_STATUS.ERROR,
    }
  }
}
