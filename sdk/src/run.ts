import path from 'path'

import { callMainPrompt } from '@codebuff/agent-runtime/main-prompt'
import {
  buildUserMessageContent,
  withSystemTags,
} from '@codebuff/agent-runtime/util/messages'
import { MAX_AGENT_STEPS_DEFAULT } from '@codebuff/common/constants/agents'
import { toOptionalFile } from '@codebuff/common/constants/paths'
import {
  getMCPClient,
  listMCPTools,
  callMCPTool,
} from '@codebuff/common/mcp/client'
import { toolNames } from '@codebuff/common/tools/constants'
import { clientToolCallSchema } from '@codebuff/common/tools/list'
import { AgentOutputSchema } from '@codebuff/common/types/session-state'
import { extractApiErrorDetails } from '@codebuff/common/util/error'
import { cloneDeep } from 'lodash'

import { getErrorStatusCode } from './error-utils'
import { getAgentRuntimeImpl } from './impl/agent-runtime'
import { getUserInfoFromApiKey } from './impl/database'
import { initialSessionState, applyOverridesToSessionState } from './run-state'
import { changeFile } from './tools/change-file'
import { applyPatchTool } from './tools/apply-patch'
import { codeSearch } from './tools/code-search'
import { glob } from './tools/glob'
import { listDirectory } from './tools/list-directory'
import { getProjectPathLookupKeys } from './tools/path-utils'
import { getFiles } from './tools/read-files'
import { readUrl } from './tools/read-url'
import { runTerminalCommand } from './tools/run-terminal-command'

import type { CustomToolDefinition } from './custom-tool'
import type { RunState } from './run-state'
import type { FileFilter } from './tools/read-files'
import type { ServerAction } from '@codebuff/common/actions'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  PublishedToolName,
  ToolName,
} from '@codebuff/common/tools/constants'
import type {
  ClientToolCall,
  ClientToolName,
  CodebuffToolOutput,
  PublishedClientToolName,
} from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type {
  ImagePart,
  TextPart,
  ToolResultOutput,
} from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { SessionState } from '@codebuff/common/types/session-state'
import type { Source } from '@codebuff/common/types/source'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

/**
 * Wraps content for user messages, ensuring text is wrapped in <user_message> tags.
 * Uses buildUserMessageContent from agent-runtime for consistency.
 */
const wrapContentForUserMessage = (
  content?: (TextPart | ImagePart)[],
): (TextPart | ImagePart)[] | undefined => {
  if (!content || content.length === 0) {
    return content
  }
  // Delegate to the shared utility which handles wrapping correctly
  return buildUserMessageContent(undefined, undefined, content)
}

export type CodebuffClientOptions = {
  apiKey?: string

  cwd?: string
  /** Optional directory path to load skills from. Skills found here will be available to the `skill` tool. */
  skillsDir?: string
  projectFiles?: Record<string, string>
  knowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  maxAgentSteps?: number
  env?: Record<string, string>

  /**
   * Default custom OpenAI-compatible provider base URL for runs that don't set
   * one per-agent. Used for local models (Ollama, LM Studio) or self-hosted
   * endpoints. Lower precedence than an agent's own providerOptions.baseUrl;
   * higher precedence than the CODEBUFF_BASE_URL env var.
   */
  providerBaseUrl?: string
  /** Default API key paired with providerBaseUrl. Ignored if providerBaseUrl is unset. */
  providerApiKey?: string

  handleEvent?: (event: PrintModeEvent) => void | Promise<void>
  handleStreamChunk?: (
    chunk:
      | string
      | {
          type: 'subagent_chunk'
          agentId: string
          agentType: string
          chunk: string
        }
      | {
          type: 'reasoning_chunk'
          agentId: string
          ancestorRunIds: string[]
          chunk: string
        },
  ) => void | Promise<void>

  /** Optional filter to classify files before reading (runs before gitignore check) */
  fileFilter?: FileFilter

  overrideTools?: Partial<
    {
      [K in ClientToolName & PublishedToolName]: (
        input: ClientToolCall<K>['input'],
      ) => Promise<CodebuffToolOutput<K>>
    } & {
      // Include read_files separately, since it has a different signature.
      read_files: (input: {
        filePaths: string[]
      }) => Promise<Record<string, string | null>>
    }
  >
  customToolDefinitions?: CustomToolDefinition[]

  fsSource?: Source<CodebuffFileSystem>
  spawnSource?: Source<CodebuffSpawn>
  logger?: Logger
}

export type ImageContent = {
  type: 'image'
  image: string // base64 encoded
  mediaType: string
}

export type TextContent = {
  type: 'text'
  text: string
}

export type MessageContent = TextContent | ImageContent

export type RunOptions = {
  agent: string | AgentDefinition
  prompt: string
  /** Content array for multimodal messages (text + images) */
  content?: MessageContent[]
  params?: Record<string, any>
  previousRun?: RunState
  extraToolResults?: ToolMessage[]
  signal?: AbortSignal
  costMode?: string
  /** Extra key/values merged into each LLM request's `codebuff_metadata`.
   *  Used by hosts (e.g. the CLI) to forward client-scoped identifiers like
   *  `freebuff_instance_id` that server-side gates read from the request body. */
  extraCodebuffMetadata?: Record<string, string>
}

const createAbortError = (signal?: AbortSignal) => {
  if (signal?.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

type RunExecutionOptions = RunOptions &
  CodebuffClientOptions & {
    apiKey: string
    fingerprintId: string
  }
type RunReturnType = RunState

export async function run(options: RunExecutionOptions): Promise<RunState> {
  const { signal } = options

  if (signal?.aborted) {
    const abortError = createAbortError(signal)
    return {
      sessionState: options.previousRun?.sessionState,
      traceSessionId:
        options.previousRun?.traceSessionId ?? crypto.randomUUID(),
      output: {
        type: 'error',
        message: abortError.message,
      },
    }
  }

  return runOnce(options)
}

async function runOnce({
  apiKey,
  fingerprintId,

  cwd,
  skillsDir,
  projectFiles,
  knowledgeFiles,
  agentDefinitions,
  maxAgentSteps = MAX_AGENT_STEPS_DEFAULT,
  env,
  providerBaseUrl,
  providerApiKey,

  handleEvent,
  handleStreamChunk,

  fileFilter,
  overrideTools,
  customToolDefinitions,

  fsSource = () => require('fs').promises,
  spawnSource,
  logger,

  agent,
  prompt,
  content,
  params,
  previousRun,
  extraToolResults,
  signal,
  costMode,
  extraCodebuffMetadata,
}: RunExecutionOptions): Promise<RunState> {
  const fsSourceValue = typeof fsSource === 'function' ? fsSource() : fsSource
  const fs = await fsSourceValue
  let spawn: CodebuffSpawn
  if (spawnSource) {
    const spawnSourceValue = await spawnSource
    spawn = spawnSourceValue as CodebuffSpawn
  } else {
    spawn = require('child_process').spawn as CodebuffSpawn
  }
  const preparedContent = wrapContentForUserMessage(content)

  // Init session state
  let agentId
  if (typeof agent !== 'string') {
    const clonedDefs = agentDefinitions ? cloneDeep(agentDefinitions) : []
    agentDefinitions = [...clonedDefs, agent]
    agentId = agent.id
  } else {
    agentId = agent
  }
  let sessionState: SessionState
  if (previousRun?.sessionState) {
    // applyOverridesToSessionState handles deep cloning and applying any provided overrides
    sessionState = await applyOverridesToSessionState(
      cwd,
      previousRun.sessionState,
      {
        knowledgeFiles,
        agentDefinitions,
        customToolDefinitions,
        projectFiles,
        maxAgentSteps,
      },
    )
  } else {
    // No previous run, so create a fresh session state
    sessionState = await initialSessionState({
      cwd,
      skillsDir,
      knowledgeFiles,
      agentDefinitions,
      customToolDefinitions,
      projectFiles,
      maxAgentSteps,
      fs,
      spawn,
      logger,
    })
  }
  const traceSessionId = previousRun?.traceSessionId ?? crypto.randomUUID()

  let resolve: (value: RunReturnType) => any = () => {}
  let _reject: (error: any) => any = () => {}
  const promise = new Promise<RunReturnType>((res, rej) => {
    resolve = res
    _reject = rej
  })

  async function onError(error: { message: string }) {
    if (handleEvent) {
      await handleEvent({ type: 'error', message: error.message })
    }
  }

  // The agent runtime mutates sessionState.mainAgentState as it progresses,
  // replacing messageHistory with a new array once it adds the user prompt.
  // Comparing array identity detects progress more robustly than length:
  // context pruning could shrink history below its starting length without
  // meaning the runtime never ran.
  const initialMessageHistory = sessionState.mainAgentState.messageHistory

  /** Calculates the current session state if cancelled.
   *
   * This is used when callMainPrompt throws an error. If the agent runtime made
   * any progress (replaced the shared messageHistory), those messages are
   * preserved. Otherwise the user's message is added so it isn't lost.
   */
  function getCancelledSessionState(message: string): SessionState {
    const runtimeMadeProgress =
      sessionState.mainAgentState.messageHistory !== initialMessageHistory

    const state = cloneDeep(sessionState)

    // Only add the user's message if the runtime didn't get a chance to add it.
    if (!runtimeMadeProgress && (prompt || preparedContent)) {
      state.mainAgentState.messageHistory.push({
        role: 'user' as const,
        content: buildUserMessageContent(prompt, params, preparedContent),
        tags: ['USER_PROMPT'] as string[],
      })
    }

    // Add error context message
    state.mainAgentState.messageHistory.push({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: withSystemTags(message) }],
    })
    return state
  }
  function getCancelledRunState(message?: string): RunState {
    message = message ?? 'Run cancelled by user.'
    return {
      sessionState: getCancelledSessionState(message),
      traceSessionId,
      output: {
        type: 'error',
        message,
      },
    }
  }

  const onResponseChunk = async (
    action: ServerAction<'response-chunk'>,
  ): Promise<void> => {
    if (signal?.aborted) {
      return
    }
    const { chunk } = action

    if (typeof chunk !== 'string') {
      if (chunk.type === 'reasoning_delta') {
        handleStreamChunk?.({
          type: 'reasoning_chunk',
          chunk: chunk.text,
          agentId: chunk.runId,
          ancestorRunIds: chunk.ancestorRunIds,
        })
      } else {
        await handleEvent?.(chunk)
      }
      return
    }

    if (handleStreamChunk) {
      await handleStreamChunk(chunk)
    }
  }
  const onSubagentResponseChunk = async (
    action: ServerAction<'subagent-response-chunk'>,
  ) => {
    if (signal?.aborted) {
      return
    }
    const { agentId, agentType, chunk } = action

    if (handleStreamChunk && chunk) {
      await handleStreamChunk({
        type: 'subagent_chunk',
        agentId,
        agentType,
        chunk,
      })
    }
  }

  const agentRuntimeImpl = getAgentRuntimeImpl({
    logger,
    apiKey,
    clientCustomProvider: providerBaseUrl
      ? { baseUrl: providerBaseUrl, apiKey: providerApiKey }
      : undefined,
    handleStepsLogChunk: () => {
      // Does nothing for now
    },
    requestToolCall: async ({ userInputId, toolName, input, mcpConfig }) => {
      return handleToolCall({
        action: {
          type: 'tool-call-request',
          requestId: crypto.randomUUID(),
          userInputId,
          toolName,
          input,
          timeout: undefined,
          mcpConfig,
        },
        overrides: overrideTools ?? {},
        customToolDefinitions: customToolDefinitions
          ? Object.fromEntries(
              customToolDefinitions.map((def) => [def.toolName, def]),
            )
          : {},
        cwd,
        fs,
        env,
      })
    },
    requestMcpToolData: async ({ mcpConfig, toolNames }) => {
      const mcpClientId = await getMCPClient(mcpConfig)
      const listToolsResult = await listMCPTools(mcpClientId)
      const tools = listToolsResult.tools
      const filteredTools: typeof tools = []
      for (const tool of tools) {
        if (!toolNames) {
          filteredTools.push(tool)
          continue
        }
        if (toolNames.includes(tool.name)) {
          filteredTools.push(tool)
          continue
        }
      }

      return filteredTools
    },
    requestFiles: ({ filePaths }) =>
      readFiles({
        filePaths,
        override: overrideTools?.read_files,
        fileFilter,
        cwd,
        fs,
      }),
    requestOptionalFile: async ({ filePath }) => {
      const files = await readFiles({
        filePaths: [filePath],
        override: overrideTools?.read_files,
        fileFilter,
        cwd,
        fs,
      })
      const lookupKeys = cwd
        ? getProjectPathLookupKeys(cwd, filePath)
        : [filePath]
      const fileKey = lookupKeys.find((key) => key in files)
      return toOptionalFile(fileKey === undefined ? null : files[fileKey]!)
    },
    sendAction: ({ action }) => {
      if (action.type === 'action-error') {
        onError({ message: action.message })
        return
      }
      if (action.type === 'response-chunk') {
        onResponseChunk(action)
        return
      }
      if (action.type === 'subagent-response-chunk') {
        onSubagentResponseChunk(action)
        return
      }
      if (action.type === 'prompt-response') {
        handlePromptResponse({
          action,
          resolve,
          onError,
          initialSessionState: sessionState,
          traceSessionId,
        })
        return
      }
      if (action.type === 'prompt-error') {
        handlePromptResponse({
          action,
          resolve,
          onError,
          initialSessionState: sessionState,
          traceSessionId,
        })
        return
      }
    },
    sendSubagentChunk: ({
      userInputId,
      agentId,
      agentType,
      chunk,
      prompt,
      forwardToPrompt = true,
    }) => {
      onSubagentResponseChunk({
        type: 'subagent-response-chunk',
        userInputId,
        agentId,
        agentType,
        chunk,
        prompt,
        forwardToPrompt,
      })
    },
  })

  const promptId = Math.random().toString(36).substring(2, 15)

  // Send input
  const userInfo = await getUserInfoFromApiKey({
    ...agentRuntimeImpl,
    apiKey,
    fields: ['id'],
  })
  if (!userInfo) {
    return getCancelledRunState('Invalid API key or user not found')
  }

  const userId = userInfo.id

  if (signal?.aborted) {
    return getCancelledRunState('Run cancelled by user.')
  }

  callMainPrompt({
    ...agentRuntimeImpl,
    promptId,
    action: {
      type: 'prompt',
      promptId,
      prompt,
      promptParams: params,
      content: preparedContent,
      fingerprintId: fingerprintId,
      costMode: costMode ?? 'normal',
      sessionState,
      toolResults: extraToolResults ?? [],
      agentId,
    },
    repoUrl: undefined,
    repoId: undefined,
    clientSessionId: promptId,
    userId,
    extraCodebuffMetadata: {
      ...(extraCodebuffMetadata ?? {}),
      trace_session_id: traceSessionId,
    },
    signal: signal ?? new AbortController().signal,
  }).catch((error) => {
    let errorMessage =
      error instanceof Error ? error.message : String(error ?? '')
    const apiErrorDetails = extractApiErrorDetails(error)
    const statusCode = apiErrorDetails.statusCode ?? getErrorStatusCode(error)
    const {
      countryBlockReason,
      countryCode,
      errorCode,
      ipPrivacySignals,
      message: parsedMessage,
    } = apiErrorDetails
    if (parsedMessage) {
      errorMessage = parsedMessage
    }

    resolve({
      sessionState: getCancelledSessionState(errorMessage),
      traceSessionId,
      output: {
        type: 'error',
        message: errorMessage,
        ...(statusCode !== undefined && { statusCode }),
        ...(errorCode !== undefined && { error: errorCode }),
        ...(countryCode !== undefined && { countryCode }),
        ...(countryBlockReason !== undefined && { countryBlockReason }),
        ...(ipPrivacySignals !== undefined && { ipPrivacySignals }),
      },
    })
  })

  return promise
}

function requireCwd(cwd: string | undefined, toolName: string): string {
  if (!cwd) {
    throw new Error(
      `cwd is required for the ${toolName} tool. Please provide cwd in CodebuffClientOptions or override the ${toolName} tool.`,
    )
  }
  return cwd
}

async function readFiles({
  filePaths,
  override,
  fileFilter,
  cwd,
  fs,
}: {
  filePaths: string[]
  override?: NonNullable<
    Required<CodebuffClientOptions>['overrideTools']['read_files']
  >
  fileFilter?: FileFilter
  cwd?: string
  fs: CodebuffFileSystem
}) {
  if (override) {
    return await override({ filePaths })
  }
  return getFiles({
    filePaths,
    cwd: requireCwd(cwd, 'read_files'),
    fs,
    fileFilter,
  })
}

async function handleToolCall({
  action,
  overrides,
  customToolDefinitions,
  cwd,
  fs,
  env,
}: {
  action: ServerAction<'tool-call-request'>
  overrides: NonNullable<CodebuffClientOptions['overrideTools']>
  customToolDefinitions: Record<string, CustomToolDefinition>
  cwd?: string
  fs: CodebuffFileSystem
  env?: Record<string, string>
}): Promise<{ output: ToolResultOutput[] }> {
  const toolName = action.toolName
  const input = action.input

  // Handle MCP tool calls when mcpConfig is present
  if (action.mcpConfig) {
    try {
      const mcpClientId = await getMCPClient(action.mcpConfig)
      const result = await callMCPTool(mcpClientId, {
        name: toolName,
        arguments: input,
      })
      return { output: result }
    } catch (error) {
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
          },
        ],
      }
    }
  }

  let result: ToolResultOutput[]
  if (toolNames.includes(toolName as ToolName)) {
    clientToolCallSchema.parse(action)
  } else {
    const customToolHandler = customToolDefinitions[toolName]

    if (!customToolHandler) {
      throw new Error(
        `Custom tool handler not found for user input ID ${action.userInputId}`,
      )
    }
    return {
      output: await customToolHandler.execute(action.input),
    }
  }

  try {
    let override = overrides[toolName as PublishedClientToolName]
    if (
      !override &&
      (toolName === 'str_replace' || toolName === 'apply_patch')
    ) {
      // Reuse the write_file override for file editing tools.
      override = overrides['write_file']
    }
    if (override) {
      // Note: This type assertion is necessary because TypeScript cannot narrow
      // the union type of all possible tool inputs based on the dynamic toolName.
      // The input has been validated by clientToolCallSchema.parse above.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await override(input as any)
    } else if (toolName === 'end_turn') {
      result = [{ type: 'json', value: { message: 'Turn ended.' } }]
    } else if (toolName === 'write_file' || toolName === 'str_replace') {
      result = await changeFile({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
      })
    } else if (toolName === 'apply_patch') {
      result = await applyPatchTool({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
      })
    } else if (toolName === 'run_terminal_command') {
      const resolvedCwd = requireCwd(cwd, 'run_terminal_command')
      result = await runTerminalCommand({
        ...input,
        cwd: path.resolve(resolvedCwd, input.cwd ?? '.'),
        env,
      } as Parameters<typeof runTerminalCommand>[0])
    } else if (toolName === 'read_url') {
      result = await readUrl(input as Parameters<typeof readUrl>[0])
    } else if (toolName === 'code_search') {
      result = await codeSearch({
        projectPath: requireCwd(cwd, 'code_search'),
        ...input,
      } as Parameters<typeof codeSearch>[0])
    } else if (toolName === 'list_directory') {
      result = await listDirectory({
        directoryPath: (input as { path: string }).path,
        projectPath: requireCwd(cwd, 'list_directory'),
        fs,
      })
    } else if (toolName === 'glob') {
      result = await glob({
        pattern: (input as { pattern: string; cwd?: string }).pattern,
        projectPath: requireCwd(cwd, 'glob'),
        cwd: (input as { pattern: string; cwd?: string }).cwd,
        fs,
      })
    } else if (toolName === 'run_file_change_hooks') {
      // No-op: SDK doesn't run file change hooks
      result = [
        {
          type: 'json',
          value: {
            message: 'File change hooks are not supported in SDK mode',
          },
        },
      ]
    } else {
      throw new Error(
        `Tool not implemented in SDK. Please provide an override or modify your agent to not use this tool: ${toolName}`,
      )
    }
  } catch (error) {
    result = [
      {
        type: 'json',
        value: {
          errorMessage:
            error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error',
        },
      },
    ]
  }
  return {
    output: result,
  }
}

/**
 * Extracts an HTTP status code from an error message string.
 * Parses common error patterns to identify the underlying status code.
 * Returns the status code if found, undefined otherwise.
 */
export const extractStatusCodeFromMessage = (
  errorMessage: string,
): number | undefined => {
  const lowerMessage = errorMessage.toLowerCase()

  // AI SDK's built-in retry error (e.g., "Failed after 4 attempts. Last error: Service Unavailable")
  // The AI SDK already retried 4 times, but we still want our SDK wrapper to retry 3 more times
  if (
    lowerMessage.includes('failed after') &&
    lowerMessage.includes('attempts')
  ) {
    // Extract the underlying error type from the message
    if (lowerMessage.includes('service unavailable')) {
      return 503
    }
    if (lowerMessage.includes('timeout')) {
      return 408
    }
    if (lowerMessage.includes('connection refused')) {
      return 503
    }
    // Default to 500 for other AI SDK retry failures
    return 500
  }

  if (
    errorMessage.includes('503') ||
    lowerMessage.includes('service unavailable')
  ) {
    return 503
  }
  if (errorMessage.includes('504')) {
    return 504
  }
  if (errorMessage.includes('502')) {
    return 502
  }
  if (lowerMessage.includes('timeout') || errorMessage.includes('408')) {
    return 408
  }
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('connection refused')
  ) {
    return 503
  }
  if (lowerMessage.includes('dns') || lowerMessage.includes('enotfound')) {
    return 503
  }
  if (lowerMessage.includes('server error') || errorMessage.includes('500')) {
    return 500
  }
  if (errorMessage.includes('429') || lowerMessage.includes('rate limit')) {
    return 429
  }
  if (
    lowerMessage.includes('network error') ||
    lowerMessage.includes('fetch failed')
  ) {
    return 503
  }

  return undefined
}

async function handlePromptResponse({
  action,
  resolve,
  onError,
  initialSessionState,
  traceSessionId,
}: {
  action: ServerAction<'prompt-response'> | ServerAction<'prompt-error'>
  resolve: (value: RunReturnType) => any
  onError: (error: { message: string }) => void
  initialSessionState: SessionState
  traceSessionId: string
}) {
  if (action.type === 'prompt-error') {
    onError({ message: action.message })

    const statusCode = extractStatusCodeFromMessage(action.message)
    resolve({
      sessionState: initialSessionState,
      traceSessionId,
      output: {
        type: 'error',
        message: action.message,
        ...(statusCode !== undefined && { statusCode }),
      },
    })
  } else if (action.type === 'prompt-response') {
    // Stop enforcing session state schema! It's a black box we will pass back to the server.
    // Only check the output schema.
    const parsedOutput = AgentOutputSchema.safeParse(action.output)
    if (!parsedOutput.success) {
      const message = [
        'Received invalid prompt response from server:',
        JSON.stringify(parsedOutput.error.issues),
        'If this issues persists, please contact support@codebuff.com',
      ].join('\n')
      onError({ message })
      resolve({
        sessionState: initialSessionState,
        traceSessionId,
        output: {
          type: 'error',
          message,
        },
      })
      return
    }
    const { sessionState, output } = action

    const state: RunState = {
      sessionState,
      traceSessionId,
      output: output ?? {
        type: 'error',
        message: 'No output from agent',
      },
    }
    resolve(state)
  } else {
    action satisfies never
    onError({
      message: 'Internal error: prompt response type not handled',
    })
    resolve({
      sessionState: initialSessionState,
      traceSessionId,
      output: {
        type: 'error',
        message: 'Internal error: prompt response type not handled',
      },
    })
  }
}
