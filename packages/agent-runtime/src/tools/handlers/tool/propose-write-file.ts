import {
  getProposedContent,
  setProposedContent,
} from './proposed-content-store'
import { createBoundedPatch } from '../../../util/bounded-patch'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

/**
 * Proposes writing a file without actually applying the changes.
 * Simply overwrites the file exactly with the given content (creating if it doesn't exist).
 * Returns a unified diff of the changes for review.
 */
export const handleProposeWriteFile = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<'propose_write_file'>

    logger: Logger
    runId: string

    requestOptionalFile: RequestOptionalFileFn
  } & ParamsExcluding<RequestOptionalFileFn, 'filePath'>,
): Promise<{ output: CodebuffToolOutput<'propose_write_file'> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    logger: _logger,
    runId,
    requestOptionalFile,
  } = params
  const { path, content } = toolCall.input

  // Get content from proposed state first (by runId), then fall back to disk
  const getProposedOrDiskContent = async (): Promise<string | null> => {
    const proposedContent = getProposedContent(runId, path)
    if (proposedContent !== undefined) {
      return proposedContent
    }
    return requestOptionalFile({ ...params, filePath: path })
  }

  const initialContent = await getProposedOrDiskContent()

  // Normalize content (remove leading newline if present)
  const newContent = content.startsWith('\n') ? content.slice(1) : content

  // Store the proposed content for future propose calls on the same file (by runId)
  setProposedContent(runId, path, Promise.resolve(newContent))

  await previousToolCallFinished

  // Generate unified diff
  const oldContent = initialContent ?? ''
  let patch = createBoundedPatch(path, oldContent, newContent)
  
  // Strip the header lines, keep only from @@ onwards
  const lines = patch.split('\n')
  const hunkStartIndex = lines.findIndex((line) => line.startsWith('@@'))
  if (hunkStartIndex !== -1) {
    patch = lines.slice(hunkStartIndex).join('\n')
  }

  const isNewFile = initialContent === null
  const message = isNewFile ? `Proposed new file ${path}` : `Proposed changes to ${path}`

  return {
    output: [
      {
        type: 'json',
        value: {
          file: path,
          message,
          unifiedDiff: patch,
        },
      },
    ],
  }
}) as CodebuffToolHandlerFunction<'propose_write_file'>
