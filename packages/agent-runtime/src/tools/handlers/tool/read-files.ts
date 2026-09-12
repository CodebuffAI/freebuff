import { isSupportedImageExtension } from '@codebuff/common/constants/images'
import { jsonToolResult, mediaToolResult } from '@codebuff/common/util/messages'

import { getFileReadingUpdates } from '../../../get-file-reading-updates'
import { renderReadFilesResult } from '../../../util/render-read-files-result'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  FileReadWindow,
  RequestImageFileFn,
} from '@codebuff/common/types/contracts/client'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'

type ToolName = 'read_files'

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return dot > separator && isSupportedImageExtension(path.slice(dot))
}

export const handleReadFiles = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>
    agentTemplate: AgentTemplate

    fileContext: ProjectFileContext
    requestImageFile?: RequestImageFileFn
  } & ParamsExcluding<
    typeof getFileReadingUpdates,
    'requestedFiles' | 'fileWindows'
  >,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    agentTemplate,

    fileContext,
    requestImageFile,
  } = params
  const { paths } = toolCall.input

  await previousToolCallFinished

  const windowed = agentTemplate.windowedFileReads === true
  const requestedFiles: string[] = []
  // Images skip the text read entirely: decoded as UTF-8 a PNG is a wall of
  // replacement characters, and the model reports "raw bytes" instead of
  // describing the picture. A host that cannot read binary leaves them in
  // `requestedFiles`, which keeps its old behavior.
  const imagePaths: string[] = []
  // Null-prototype: these are keyed by a model-supplied path, so a plain object
  // would resolve `__proto__`, `constructor`, `toString` and friends to
  // inherited members. `??=` then sees a truthy non-Set / non-Array and leaves
  // it, and the next `.has`/`.push` throws. Same reason sdk/src/tools/
  // read-files.ts builds its result map this way.
  const fileWindows: Record<string, FileReadWindow[]> = Object.create(null)
  const seenWindows: Record<string, Set<string>> = Object.create(null)
  for (const entry of paths) {
    const path = typeof entry === 'string' ? entry : entry.path
    if (requestImageFile && isImagePath(path)) {
      if (!imagePaths.includes(path)) imagePaths.push(path)
      continue
    }
    requestedFiles.push(path)
    if (!windowed) continue
    const window =
      typeof entry === 'string'
        ? {}
        : { offset: entry.offset, limit: entry.limit }
    const key = `${window.offset ?? ''}:${window.limit ?? ''}`
    const seen = (seenWindows[path] ??= new Set())
    if (seen.has(key) || seen.has(':')) continue
    seen.add(key)
    if (key === ':') {
      fileWindows[path] = [window]
      continue
    }
    ;(fileWindows[path] ??= []).push(window)
  }

  const addedFiles =
    requestedFiles.length > 0 || imagePaths.length === 0
      ? await getFileReadingUpdates({
          ...params,
          requestedFiles,
          fileWindows: windowed ? fileWindows : undefined,
        })
      : []

  const images = requestImageFile
    ? await Promise.all(
        imagePaths.map((filePath) => requestImageFile({ filePath })),
      )
    : []
  const imageEntries = images.map((image) => ({
    path: image.path,
    content:
      'data' in image
        ? `[IMAGE] ${image.mediaType}, ${Math.max(1, Math.round(image.bytes / 1024))} KB. The image is attached after this result.`
        : image.error,
  }))

  return {
    output: [
      ...jsonToolResult(
        renderReadFilesResult(
          [...addedFiles, ...imageEntries],
          fileContext.tokenCallers ?? {},
        ),
      ),
      ...images.flatMap((image) =>
        'data' in image
          ? mediaToolResult({ data: image.data, mediaType: image.mediaType })
          : [],
      ),
    ],
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
