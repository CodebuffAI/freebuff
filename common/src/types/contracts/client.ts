import type { ServerAction } from '../../actions'
import type { MCPConfig } from '../mcp'
import type { ToolResultOutput } from '../messages/content-part'

export type RequestToolCallFn = (params: {
  userInputId: string
  toolName: string
  input: Record<string, any> & { timeout_seconds?: number }
  mcpConfig?: MCPConfig
}) => Promise<{
  output: ToolResultOutput[]
}>

export type RequestMcpToolDataFn = (params: {
  mcpConfig: MCPConfig
  toolNames: string[] | null
}) => Promise<
  {
    name: string
    description?: string
    inputSchema: unknown
  }[]
>

export type FileReadWindow = { offset?: number; limit?: number }

export type RequestFilesFn = (params: {
  filePaths: string[]
  fileWindows?: Record<string, FileReadWindow[]>
}) => Promise<Record<string, string | null>>

export type RequestOptionalFileFn = (params: {
  filePath: string
}) => Promise<string | null>

/**
 * Read an image file as base64, so read_files can hand the model the picture
 * instead of its bytes decoded as text. `error` is a read_files status line
 * (missing, blocked, too large) in the slot the image would have occupied.
 */
export type RequestImageFileFn = (params: {
  filePath: string
}) => Promise<
  | { path: string; data: string; mediaType: string; bytes: number }
  | { path: string; error: string }
>

export type SendSubagentChunkFn = (params: {
  userInputId: string
  agentId: string
  agentType: string
  chunk: string
  prompt?: string | undefined
  forwardToPrompt?: boolean
}) => void

export type HandleStepsLogChunkFn = (params: {
  userInputId: string
  runId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  data: unknown
  message?: string
}) => void

export type SendActionFn = (params: { action: ServerAction }) => void
