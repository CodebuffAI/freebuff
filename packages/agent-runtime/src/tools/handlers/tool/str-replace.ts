import { postStreamProcessing } from './write-file'
import { processStrReplace } from '../../../process-str-replace'
import { isPathConfined } from '../../../util/path-confinement'
import { PATH_OUTSIDE_PROJECT_MESSAGE } from '../../../util/path-confinement'
import { FILE_READ_STATUS } from '@codebuff/common/constants/paths'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import { jsonToolResult } from '@codebuff/common/util/messages'
import {
  isDestructiveToolBlocked,
  DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
} from '../../../util/destructive-tool-gate'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { FileProcessingState } from './write-file'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

export const handleStrReplace = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<'str_replace'>
    agentTemplate: AgentTemplate

    fileProcessingState: FileProcessingState
    logger: Logger

    requestClientToolCall: (
      toolCall: ClientToolCall<'str_replace'>,
    ) => Promise<CodebuffToolOutput<'str_replace'>>
    writeToClient: (chunk: string) => void

    requestOptionalFile: RequestOptionalFileFn
  } & ParamsExcluding<RequestOptionalFileFn, 'filePath'>,
): Promise<{ output: CodebuffToolOutput<'str_replace'> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    agentTemplate,

    fileProcessingState,
    logger,

    requestClientToolCall,
    requestOptionalFile,
    writeToClient,
  } = params
  const { path, replacements } = toolCall.input

  if (isDestructiveToolBlocked(agentTemplate, 'str_replace')) {
    await previousToolCallFinished
    return {
      output: jsonToolResult({
        file: path,
        errorMessage: DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
      }),
    }
  }

  // Default path confinement: refuse edits outside the project root.
  if (!isPathConfined(path)) {
    await previousToolCallFinished
    return {
      output: [
        {
          type: 'json',
          value: {
            file: path,
            errorMessage: `${FILE_READ_STATUS.OUTSIDE_PROJECT} ${PATH_OUTSIDE_PROJECT_MESSAGE}`,
          },
        },
      ],
    }
  }

  if (!fileProcessingState.promisesByPath[path]) {
    fileProcessingState.promisesByPath[path] = []
  }

  const previousPromises = fileProcessingState.promisesByPath[path]
  const previousEdit = previousPromises[previousPromises.length - 1]

  const latestContentPromise = previousEdit
    ? previousEdit.then((maybeResult) =>
        maybeResult && 'content' in maybeResult
          ? maybeResult.content
          : requestOptionalFile({ ...params, filePath: path }),
      )
    : requestOptionalFile({ ...params, filePath: path })

  const newPromise = processStrReplace({
    path,
    replacements,
    initialContentPromise: latestContentPromise,
    logger,
  })
    .catch((error: any) => {
      logger.error(error, 'Error processing str_replace block')
      return {
        tool: 'str_replace' as const,
        path,
        error: `Error: Failed to process the str_replace block. ${typeof error === 'string' ? error : error.message}`,
      }
    })
    .then((fileProcessingResult) => ({
      ...fileProcessingResult,
      toolCallId: toolCall.toolCallId,
    }))

  fileProcessingState.promisesByPath[path].push(newPromise)
  fileProcessingState.allPromises.push(newPromise)

  await previousToolCallFinished

  const strReplaceResult = await newPromise
  const clientToolResult = await postStreamProcessing<'str_replace'>(
    strReplaceResult,
    fileProcessingState,
    writeToClient,
    requestClientToolCall,
  )

  const value = clientToolResult[0].value
  if ('messages' in strReplaceResult && 'message' in value) {
    value.message = [...strReplaceResult.messages, value.message].join('\n\n')
  }

  return { output: clientToolResult }
}) satisfies CodebuffToolHandlerFunction<'str_replace'>
