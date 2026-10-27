import { z } from 'zod/v4'

import type { GrantType } from './types/grant'
import type { MCPConfig } from './types/mcp'
import type { ToolMessage } from './types/messages/codebuff-message'
import type {
  TextPart,
  ImagePart,
  ToolResultOutput,
} from './types/messages/content-part'
import type { PrintModeEvent } from './types/print-mode'
import type { AgentOutput, SessionState, ToolCall } from './types/session-state'
import type { ProjectFileContext } from './util/file'

export const FileChangeSchema = z.object({
  type: z.enum(['patch', 'file']),
  path: z.string(),
  content: z.string(),
})
export type FileChange = z.infer<typeof FileChangeSchema>
export const CHANGES = z.array(FileChangeSchema)
export type FileChanges = z.infer<typeof CHANGES>

type ClientActionPrompt = {
  type: 'prompt'
  promptId: string
  prompt: string | undefined
  content?: (TextPart | ImagePart)[]
  promptParams?: Record<string, any> // Additional json params.
  fingerprintId: string
  authToken?: string
  costMode?: string
  sessionState: SessionState
  toolResults: ToolMessage[]
  model?: string
  repoUrl?: string
  agentId?: string
}

type ClientActionReadFilesResponse = {
  type: 'read-files-response'
  files: Record<string, string | null>
  requestId?: string
}

type ClientActionInit = {
  type: 'init'
  fingerprintId: string
  authToken?: string
  fileContext: ProjectFileContext
  repoUrl?: string
}

type ClientActionToolCallResponse = {
  type: 'tool-call-response'
  requestId: string
  output: ToolResultOutput[]
}

type ClientActionCancelUserInput = {
  type: 'cancel-user-input'
  authToken: string
  promptId: string
}

type ClientActionMcpToolData = {
  type: 'mcp-tool-data'
  requestId: string
  tools: {
    name: string
    description?: string
    inputSchema: { type: 'object'; [k: string]: unknown }
  }[]
}

type ClientActionAny =
  | ClientActionPrompt
  | ClientActionReadFilesResponse
  | ClientActionInit
  | ClientActionToolCallResponse
  | ClientActionCancelUserInput
  | ClientActionMcpToolData
type ClientActionType = ClientActionAny['type']
export type ClientAction<T extends ClientActionType = ClientActionType> = {
  [K in ClientActionType]: Extract<
    ClientActionAny,
    {
      type: K
    }
  >
}[T]

type ServerActionResponseChunk = {
  type: 'response-chunk'
  userInputId: string
  chunk: string | PrintModeEvent
}

type ServerActionSubagentResponseChunk = {
  type: 'subagent-response-chunk'
  userInputId: string
  agentId: string
  agentType: string
  chunk: string
  prompt?: string
  forwardToPrompt?: boolean
}

type ServerActionHandleStepsLogChunk = {
  type: 'handlesteps-log-chunk'
  userInputId: string
  agentId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  data: any
  message?: string
}

export type PromptResponse = {
  type: 'prompt-response'
  promptId: string
  sessionState: SessionState
  toolCalls?: ToolCall[]
  toolResults?: ToolMessage[]
  output?: AgentOutput
}

type ServerActionReadFiles = {
  type: 'read-files'
  filePaths: string[]
  requestId: string
}

type ServerActionToolCallRequest = {
  toolCallId?: string
  type: 'tool-call-request'
  userInputId: string
  requestId: string
  toolName: string
  input: Record<string, any>
  timeout?: number
  mcpConfig?: MCPConfig
}

export type InitResponse = {
  type: 'init-response'
  message?: string
  agentNames?: Record<string, string>
} & Omit<UsageResponse, 'type'>

export type UsageResponse = {
  type: 'usage-response'
  usage: number
  remainingBalance: number
  balanceBreakdown?: Record<GrantType, number>
  next_quota_reset: Date | null
  autoTopupAdded?: number
  autoTopupEnabled?: boolean
}

export type MessageCostResponse = {
  type: 'message-cost-response'
  promptId: string
  credits: number
  agentId?: string
}

type ServerActionActionError = {
  type: 'action-error'
  message: string
  error?: string
  remainingBalance?: number
}

type ServerActionPromptError = {
  type: 'prompt-error'
  userInputId: string
  message: string
  error?: string
  remainingBalance?: number
}

type ServerActionRequestReconnect = {
  // The server is imminently going to shutdown, and the client should reconnect
  type: 'request-reconnect'
}

type ServerActionRequestMcpToolData = {
  type: 'request-mcp-tool-data'
  requestId: string
  mcpConfig: MCPConfig
  toolNames?: string[]
}

type ServerActionAny =
  | ServerActionResponseChunk
  | ServerActionSubagentResponseChunk
  | ServerActionHandleStepsLogChunk
  | PromptResponse
  | ServerActionReadFiles
  | ServerActionToolCallRequest
  | InitResponse
  | UsageResponse
  | MessageCostResponse
  | ServerActionActionError
  | ServerActionPromptError
  | ServerActionRequestReconnect
  | ServerActionRequestMcpToolData
type ServerActionType = ServerActionAny['type']
export type ServerAction<T extends ServerActionType = ServerActionType> = {
  [K in ServerActionType]: Extract<
    ServerActionAny,
    {
      type: K
    }
  >
}[T]
