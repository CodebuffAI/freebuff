import { AbortError } from '@codebuff/common/util/error'
import { partition } from 'lodash'

import { processFileBlock } from '../../../process-file-block'
import { isPathConfined } from '../../../util/path-confinement'
import { FILE_READ_STATUS } from '@codebuff/common/constants/paths'
import { PATH_OUTSIDE_PROJECT_MESSAGE } from '../../../util/path-confinement'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import { jsonToolResult } from '@codebuff/common/util/messages'
import {
  isDestructiveToolBlocked,
  DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
} from '../../../util/destructive-tool-gate'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { AgentState } from '@codebuff/common/types/session-state'

type FileProcessingTools = 'write_file' | 'str_replace' | 'create_plan'
export type FileProcessing<
  T extends FileProcessingTools = FileProcessingTools,
> = {
  tool: T
  path: string
  toolCallId: string
} & (
  | {
      content: string
      patch?: string
      messages: string[]
    }
  | {
      error: string
    }
)

export type FileProcessingState = {
  promisesByPath: Record<string, Promise<FileProcessing>[]>
  allPromises: Promise<FileProcessing>[]
  fileChangeErrors: Extract<FileProcessing, { error: string }>[]
  fileChanges: Exclude<FileProcessing, { error: string }>[]
  firstFileProcessed: boolean
}

export function getFileProcessingValues(
  state: FileProcessingState,
): FileProcessingState {
  const fileProcessingValues: FileProcessingState = {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
  }
  for (const [key, value] of Object.entries(state)) {
    const typedKey = key as keyof typeof fileProcessingValues
    if (typedKey in fileProcessingValues) {
      fileProcessingValues[typedKey] = value as any
    }
  }
  return fileProcessingValues
}

export const handleWriteFile = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<'write_file'>

    agentState: AgentState
    agentTemplate: AgentTemplate
    clientSessionId: string
    fileProcessingState: FileProcessingState
    fingerprintId: string
    logger: Logger
    prompt: string | undefined
    userId: string | undefined
    userInputId: string

    requestClientToolCall: (
      toolCall: ClientToolCall<'write_file'>,
    ) => Promise<CodebuffToolOutput<'write_file'>>
    requestOptionalFile: RequestOptionalFileFn
    writeToClient: (chunk: string) => void
  } & ParamsExcluding<RequestOptionalFileFn, 'filePath'>,
): Promise<{ output: CodebuffToolOutput<'write_file'> }> => {
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
  const { path, content } = toolCall.input

  if (isDestructiveToolBlocked(agentTemplate, 'write_file')) {
    await previousToolCallFinished
    return {
      output: jsonToolResult({
        file: path,
        errorMessage: DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
      }),
    }
  }

  // Default path confinement: refuse writes outside the project root.
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

  const fileProcessingPromisesByPath = fileProcessingState.promisesByPath
  const fileProcessingPromises = fileProcessingState.allPromises

  // Initialize state for this file path if needed
  if (!fileProcessingPromisesByPath[path]) {
    fileProcessingPromisesByPath[path] = []
  }
  const previousPromises = fileProcessingPromisesByPath[path]
  const previousEdit = previousPromises[previousPromises.length - 1]

  const latestContentPromise = previousEdit
    ? previousEdit.then((maybeResult) =>
        maybeResult && 'content' in maybeResult
          ? maybeResult.content
          : requestOptionalFile({ ...params, filePath: path }),
      )
    : requestOptionalFile({ ...params, filePath: path })

  const fileContentWithoutStartNewline = content.startsWith('\n')
    ? content.slice(1)
    : content

  logger.debug({ path, content }, `write_file ${path}`)

  const newPromise = processFileBlock({
    path,
    initialContentPromise: latestContentPromise,
    newContent: fileContentWithoutStartNewline,
    logger,
  })
    .then((result) => {
      // Check for abort and throw at the boundary
      if (result.aborted) {
        throw new AbortError(result.reason)
      }
      return result.value
    })
    .catch((error) => {
      // AbortError propagates up - don't convert to tool error
      if (error instanceof AbortError) {
        throw error
      }
      logger.error(error, 'Error processing write_file block')
      return {
        tool: 'write_file' as const,
        path,
        error: `Error: Failed to process the write_file block. ${typeof error === 'string' ? error : error.message}`,
      }
    })
    .then(async (fileProcessingResult) => ({
      ...fileProcessingResult,
      toolCallId: toolCall.toolCallId,
    }))
  fileProcessingPromisesByPath[path].push(newPromise)
  fileProcessingPromises.push(newPromise)

  await previousToolCallFinished

  return {
    output: await postStreamProcessing<'write_file'>(
      await newPromise,
      fileProcessingState,
      writeToClient,
      requestClientToolCall,
    ),
  }
}) satisfies CodebuffToolHandlerFunction<'write_file'>

export async function postStreamProcessing<T extends FileProcessingTools>(
  toolCall: FileProcessing<T>,
  fileProcessingState: FileProcessingState,
  writeToClient: (chunk: string) => void,
  requestClientToolCall: (
    toolCall: ClientToolCall<T>,
  ) => Promise<CodebuffToolOutput<T>>,
): Promise<CodebuffToolOutput<T>> {
  const allFileProcessingResults = await Promise.all(
    fileProcessingState.allPromises,
  )
  if (!fileProcessingState.firstFileProcessed) {
    ;[fileProcessingState.fileChangeErrors, fileProcessingState.fileChanges] =
      partition(allFileProcessingResults, (result) => 'error' in result)

    if (
      fileProcessingState.fileChanges.length === 0 &&
      allFileProcessingResults.length > 0
    ) {
      writeToClient('No changes to existing files.\n')
    }
    if (fileProcessingState.fileChanges.length > 0) {
      writeToClient(`\n`)
    }
    fileProcessingState.firstFileProcessed = true
  } else {
    // Update the arrays with new results for subsequent tool calls
    const [newErrors, newChanges] = partition(
      allFileProcessingResults,
      (result) => 'error' in result,
    )
    fileProcessingState.fileChangeErrors = newErrors as Extract<
      FileProcessing,
      { error: string }
    >[]
    fileProcessingState.fileChanges = newChanges as Exclude<
      FileProcessing,
      { error: string }
    >[]
  }

  // Note: toolCallResults was previously assigned but unused - errors are returned directly now

  const errors = fileProcessingState.fileChangeErrors.filter(
    (result) => result.toolCallId === toolCall.toolCallId,
  )
  if (errors.length > 0) {
    if (errors.length > 1) {
      throw new Error(
        `Internal error: Unexpected number of matching errors for ${JSON.stringify(toolCall)}, found ${errors.length}, expected 1`,
      )
    }

    const { path, error } = errors[0]
    return [
      {
        type: 'json',
        value: {
          file: path,
          errorMessage: error,
        },
      },
    ]
  }

  const changes = fileProcessingState.fileChanges.filter(
    (result) => result.toolCallId === toolCall.toolCallId,
  )
  if (changes.length !== 1) {
    throw new Error(
      `Internal error: Unexpected number of matching changes for ${JSON.stringify(toolCall)}, found ${changes.length}, expected 1`,
    )
  }

  const { patch, content, path } = changes[0]
  const clientToolCall: ClientToolCall<T> = {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.tool,
    input: patch
      ? { type: 'patch' as const, path, content: patch }
      : { type: 'file' as const, path, content },
  } as ClientToolCall<T>
  return await requestClientToolCall(clientToolCall)
}
