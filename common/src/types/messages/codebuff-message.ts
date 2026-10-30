import type {
  FilePart,
  ImagePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultOutput,
} from './content-part'
import type { ProviderMetadata } from './provider-metadata'

export type AuxiliaryMessageData = {
  providerOptions?: ProviderMetadata
  tags?: string[]

  /**
   * Unix timestamp (ms) when the message was added to history.
   * Used to detect prompt cache expiry (>5 min gap = cache miss).
   * This field is stripped before sending to the LLM.
   */
  sentAt?: number

  // James: All the below is overly prescriptive for the framework.
  // Instead, let's tag what the message is, and let the user decide time to live, keep during truncation, etc.
  /** @deprecated Use tags instead. */
  timeToLive?: 'agentStep' | 'userPrompt'
  /** @deprecated Use tags instead. */
  keepDuringTruncation?: boolean
  /** @deprecated Use tags instead. */
  keepLastTags?: string[]
}

export type SystemMessage = {
  role: 'system'
  content: TextPart[]
} & AuxiliaryMessageData

export type UserMessage = {
  role: 'user'
  content: (TextPart | ImagePart | FilePart)[]
} & AuxiliaryMessageData

export type AssistantMessage = {
  role: 'assistant'
  content: (TextPart | ReasoningPart | ToolCallPart)[]
} & AuxiliaryMessageData

export type ToolMessage = {
  role: 'tool'
  toolCallId: string
  toolName: string
  content: ToolResultOutput[]
} & AuxiliaryMessageData

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage
