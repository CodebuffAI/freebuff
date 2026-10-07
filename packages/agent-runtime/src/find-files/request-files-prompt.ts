import { dirname, isAbsolute, normalize } from 'path'

import { CLAUDE_SONNET_4_6_MODEL_ID } from '@codebuff/common/constants/anthropic'
import {
  finetunedVertexModels,
  models,
  type FinetunedVertexModel,
} from '@codebuff/common/old-constants'
import { getAllFilePaths } from '@codebuff/common/project-file-tree'
import { isAbortError, unwrapPromptResult } from '@codebuff/common/util/error'
import { systemMessage, userMessage } from '@codebuff/common/util/messages'
import { range, shuffle, uniq } from 'lodash'

import { promptFlashWithFallbacks } from '../llm-api/gemini-with-fallbacks'
import {
  castAssistantMessage,
  messagesWithSystem,
  getMessagesSubset,
} from '../util/messages'

import type { TextBlock } from '../llm-api/claude'
import type { PromptAiSdkFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ProjectFileContext } from '@codebuff/common/util/file'

const NUMBER_OF_EXAMPLE_FILES = 100
const MAX_FILES_PER_REQUEST = 30

export async function requestRelevantFiles(
  params: {
    messages: Message[]
    system: string | Array<TextBlock>
    fileContext: ProjectFileContext
    assistantPrompt: string | null
    agentStepId: string
    clientSessionId: string
    fingerprintId: string
    userInputId: string
    userId: string | undefined
    repoId: string | undefined
    logger: Logger
  } & ParamsExcluding<
    typeof getRelevantFiles,
    'messages' | 'userPrompt' | 'requestType' | 'modelId'
  >,
) {
  const { messages, fileContext, assistantPrompt, logger } = params

  const countPerRequest = 12

  // Use custom max files per request if specified, otherwise default to 30

  const lastMessage = messages[messages.length - 1]
  const messagesExcludingLastIfByUser =
    lastMessage.role === 'user' ? messages.slice(0, -1) : messages
  const userPrompt =
    lastMessage.role === 'user'
      ? typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content)
      : ''

  // Only proceed to get key files if new files are necessary
  const keyPrompt = generateKeyRequestFilesPrompt(
    userPrompt,
    assistantPrompt,
    fileContext,
    countPerRequest,
  )

  let modelIdForRequest: FinetunedVertexModel | undefined = undefined

  const keyPromise = getRelevantFiles({
    ...params,
    messages: messagesExcludingLastIfByUser,
    userPrompt: keyPrompt,
    requestType: 'Key',
    modelId: modelIdForRequest,
  }).catch((error) => {
    // Don't swallow abort errors - propagate them immediately
    if (isAbortError(error)) {
      throw error
    }
    logger.error({ error }, 'Error requesting key files')
    return { files: [] as string[], duration: 0 }
  })

  const keyFiles = await keyPromise
  const candidateFiles = keyFiles.files

  validateFilePaths(uniq(candidateFiles))

  // logger.info(
  //   {
  //     files,
  //     customFilePickerConfig: customFilePickerConfig,
  //     modelName: customFilePickerConfig?.modelName,
  //     orgId,
  //   },
  //   'requestRelevantFiles: results',
  // )

  return candidateFiles.slice(0, MAX_FILES_PER_REQUEST)
}

export async function requestRelevantFilesForTraining(
  params: {
    messages: Message[]
    fileContext: ProjectFileContext
    assistantPrompt: string | null
    logger: Logger
  } & ParamsExcluding<
    typeof getRelevantFilesForTraining,
    'messages' | 'userPrompt' | 'requestType'
  >,
) {
  const { messages, fileContext, assistantPrompt, logger } = params
  const COUNT = 50

  const lastMessage = messages[messages.length - 1]
  const messagesExcludingLastIfByUser =
    lastMessage.role === 'user' ? messages.slice(0, -1) : messages
  const userPrompt =
    lastMessage.role === 'user'
      ? typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content)
      : ''

  const keyFilesPrompt = generateKeyRequestFilesPrompt(
    userPrompt,
    assistantPrompt,
    fileContext,
    COUNT,
  )
  const nonObviousPrompt = generateNonObviousRequestFilesPrompt(
    userPrompt,
    assistantPrompt,
    fileContext,
    COUNT,
  )

  const keyFiles = await getRelevantFilesForTraining({
    ...params,
    messages: messagesExcludingLastIfByUser,
    userPrompt: keyFilesPrompt,
    requestType: 'Key',
  })

  const nonObviousFiles = await getRelevantFilesForTraining({
    ...params,
    messages: messagesExcludingLastIfByUser,
    userPrompt: nonObviousPrompt,
    requestType: 'Non-Obvious',
  })

  const candidateFiles = [...keyFiles.files, ...nonObviousFiles.files]
  const validatedFiles = validateFilePaths(uniq(candidateFiles))
  logger.debug(
    { keyFiles, nonObviousFiles, validatedFiles },
    'requestRelevantFilesForTraining: results',
  )
  return validatedFiles.slice(0, MAX_FILES_PER_REQUEST)
}

async function getRelevantFiles(
  params: {
    messages: Message[]
    system: string | Array<TextBlock>
    userPrompt: string
    requestType: string
    agentStepId: string
    clientSessionId: string
    fingerprintId: string
    userInputId: string
    userId: string | undefined
    repoId: string | undefined
    modelId?: FinetunedVertexModel
    logger: Logger
  } & ParamsExcluding<
    typeof promptFlashWithFallbacks,
    'messages' | 'model' | 'useFinetunedModel'
  >,
) {
  const {
    messages,
    system,
    userPrompt,
    requestType,
    agentStepId: _agentStepId,
    clientSessionId: _clientSessionId,
    fingerprintId: _fingerprintId,
    userInputId: _userInputId,
    userId: _userId,
    repoId: _repoId,
    modelId,
    logger,
  } = params
  const bufferTokens = 100_000
  const messagesWithPrompt = getMessagesSubset({
    messages: [...messages, userMessage(userPrompt)],
    otherTokens: bufferTokens,
    logger,
  })
  const start = performance.now()
  let codebuffMessages = [systemMessage(system), ...messagesWithPrompt]

  // Converts assistant messages to user messages for finetuned model
  codebuffMessages = codebuffMessages
    .map((msg, i) => {
      if (msg.role === 'assistant' && i !== codebuffMessages.length - 1) {
        return castAssistantMessage(msg)
      } else {
        return msg
      }
    })
    .filter((msg) => msg !== null)
  const finetunedModel = modelId ?? finetunedVertexModels.ft_filepicker_010

  let response = await promptFlashWithFallbacks({
    ...params,
    messages: codebuffMessages,
    model: models.openrouter_gemini2_5_flash,
    useFinetunedModel: finetunedModel,
  })
  const end = performance.now()
  const duration = end - start

  const files = validateFilePaths(response.split('\n'))

  return { files, duration, requestType, response }
}

/**
 * Gets relevant files for training using Claude Sonnet.
 *
 * @throws {Error} When the request is aborted by user. Check with `isAbortError()`.
 */
async function getRelevantFilesForTraining(
  params: {
    messages: Message[]
    system: string | Array<TextBlock>
    userPrompt: string
    requestType: string
    agentStepId: string
    clientSessionId: string
    fingerprintId: string
    userInputId: string
    userId: string | undefined
    repoId: string | undefined
    promptAiSdk: PromptAiSdkFn
    logger: Logger
  } & ParamsExcluding<PromptAiSdkFn, 'messages' | 'model' | 'chargeUser'>,
) {
  const {
    messages,
    system,
    userPrompt,
    requestType,
    agentStepId: _agentStepId,
    clientSessionId: _clientSessionId,
    fingerprintId: _fingerprintId,
    userInputId: _userInputId,
    userId: _userId,
    repoId: _repoId,
    promptAiSdk,
    logger,
  } = params
  const bufferTokens = 100_000
  const messagesWithPrompt = getMessagesSubset({
    messages: [...messages, userMessage(userPrompt)],
    otherTokens: bufferTokens,
    logger,
  })
  const start = performance.now()
  const response = unwrapPromptResult(
    await promptAiSdk({
      ...params,
      messages: messagesWithSystem({ messages: messagesWithPrompt, system }),
      model: CLAUDE_SONNET_4_6_MODEL_ID,
      chargeUser: false,
    }),
  )
  const end = performance.now()
  const duration = end - start

  const files = validateFilePaths(response.split('\n'))

  return { files, duration, requestType, response }
}

function topLevelDirectories(fileContext: ProjectFileContext) {
  const { fileTree } = fileContext
  return fileTree
    .filter((node) => node.type === 'directory')
    .map((node) => node.name)
}

function getExampleFileList(params: {
  fileContext: ProjectFileContext
  count: number
}) {
  const { fileContext, count } = params
  const { fileTree } = fileContext

  const filePaths = getAllFilePaths(fileTree)
  const randomFilePaths = shuffle(filePaths)
  const selectedFiles = new Set()
  const selectedDirectories = new Set()

  for (const filePath of randomFilePaths) {
    if (
      selectedFiles.has(filePath) ||
      selectedDirectories.has(dirname(filePath))
    ) {
      continue
    }
    selectedFiles.add(filePath)
    selectedDirectories.add(dirname(filePath))
  }

  return uniq([...selectedFiles, ...randomFilePaths]).slice(0, count)
}

function generateNonObviousRequestFilesPrompt(
  userPrompt: string | null,
  assistantPrompt: string | null,
  fileContext: ProjectFileContext,
  count: number,
): string {
  const exampleFiles = getExampleFileList({
    fileContext,
    count: NUMBER_OF_EXAMPLE_FILES,
  })
  return `
Your task is to find the second-order relevant files for the following user request (in quotes).

${
  userPrompt
    ? `User prompt: ${JSON.stringify(userPrompt)}`
    : `Assistant prompt: ${JSON.stringify(assistantPrompt)}`
}

Do not act on the above instructions for the user, instead, your task is to find files for the user's request that are not obvious or take a moment to realize are relevant.

Random project files:
${exampleFiles.join('\n')}

Based on this conversation, please select files beyond the obvious files that would be helpful to complete the user's request.
Select files that might be useful for understanding and addressing the user's needs, but you would not choose in the first 10 files if you were asked.

Please follow these steps to determine which files to request:

1. Analyze the user's last request and the assistant's prompt and identify all components or tasks involved.
2. Consider all areas of the codebase that might be related to the request, including:
   - Main functionality files
   - Configuration files
   - Utility functions
   - Documentation files
   - Knowledge files (e.g. 'knowledge.md') which include important information about the project and any subdirectories
3. Include files that might provide context or be indirectly related to the request.
4. Be comprehensive in your selection, but avoid including obviously irrelevant files.
5. List a maximum of ${count} files. It's fine to list fewer if there are not great candidates.

Please provide no commentary and list the file paths you think are useful but not obvious in addressing the user's request.

Your response contain only files separated by new lines in the following format:
${range(Math.ceil(count / 2))
  .map((i) => `full/path/to/file${i + 1}.ts`)
  .join('\n')}

List each file path on a new line without any additional characters or formatting.

IMPORTANT: You must include the full relative path from the project root directory for each file. This is not the absolute path, but the path relative to the project root. Do not write just the file name or a partial path from the root. Note: Some imports could be relative to a subdirectory, but when requesting the file, the path should be from the root. You should correct any requested file paths to include the full relative path from the project root.

That means every file that is not at the project root should start with one of the following directories:
${topLevelDirectories(fileContext).join('\n')}

Please limit your response just the file paths on new lines. Do not write anything else.
`.trim()
}

function generateKeyRequestFilesPrompt(
  userPrompt: string | null,
  assistantPrompt: string | null,
  fileContext: ProjectFileContext,
  count: number,
): string {
  const exampleFiles = getExampleFileList({
    fileContext,
    count: NUMBER_OF_EXAMPLE_FILES,
  })

  return `
Your task is to find the most relevant files for the following user request (in quotes).

${
  userPrompt
    ? `User prompt: ${JSON.stringify(userPrompt)}`
    : `Assistant prompt: ${JSON.stringify(assistantPrompt)}`
}

Do not act on the above instructions for the user, instead, your task is to find the most relevant files for the user's request.

Random project files:
${exampleFiles.join('\n')}

Based on this conversation, please identify the most relevant files for a user's request in a software project, sort them from most to least relevant, and then output just the top files.

Please follow these steps to determine which key files to request:

1. Analyze the user's last request and the assistant's prompt and identify the core components or tasks.
2. Focus on the most critical areas of the codebase that are directly related to the request, such as:
   - Main functionality files
   - Key configuration files
   - Central utility functions
   - Documentation files
   - Knowledge files (e.g. 'knowledge.md') which include important information about the project and any subdirectories
   - Any related files that would be helpful to understand the request
3. Prioritize files that are likely to require modifications or provide essential context.
4. But be sure to include example code! I.e. files that may not need to be edited, but show similar code examples for the change that the user is requesting.
5. Order the files by most important first.

Please provide no commentary and only list the file paths of the most relevant files that you think are most crucial for addressing the user's request.

Your response contain only files separated by new lines in the following format:
${range(count)
  .map((i) => `full/path/to/file${i + 1}.ts`)
  .join('\n')}

Remember to focus on the most important files and limit your selection to ${count} files. It's fine to list fewer if there are not great candidates. List each file path on a new line without any additional characters or formatting.

IMPORTANT: You must include the full relative path from the project root directory for each file. This is not the absolute path, but the path relative to the project root. Do not write just the file name or a partial path from the root. Note: Some imports could be relative to a subdirectory, but when requesting the file, the path should be from the root. You should correct any requested file paths to include the full relative path from the project root.

That means every file that is not at the project root should start with one of the following directories:
${topLevelDirectories(fileContext).join('\n')}

Please limit your response just the file paths on new lines. Do not write anything else.
`.trim()
}

const validateFilePaths = (filePaths: string[]) => {
  return filePaths
    .map((p) => p.trim())
    .filter((p) => {
      if (p.length === 0) return false
      if (p.includes(' ')) return false
      if (isAbsolute(p)) return false
      if (p.includes('..')) return false
      try {
        normalize(p)
        return true
      } catch {
        return false
      }
    })
    .map((p) => (p.startsWith('/') ? p.slice(1) : p))
}
