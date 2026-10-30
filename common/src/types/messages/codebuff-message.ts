import type {
  FilePart,
  ImagePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultOutput,
} from './content-part'
import type { AgentExpiresAt } from '../../../../packages/agent-runtime/src/cache-expiry'
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

  /**
   * Declarative expiry boundary. Unlike `timeToLive`, a message carrying this
   * still informs its own next step: `expiresAt` is only applied on the step
   * after the one that observed the message. `timeToLive: 'agentStep'`, by
   * contrast, is removed by every step boundary — including the one right
   * after the message was pushed mid-turn — which is why the step prompt must
   * be re-pushed (rather than merely re-stamped) each step.
   */
  expiresAt?: AgentExpiresAt

  // James: All the below is overly prescriptive for the framework.
  // Instead, let's tag what the message is, and let the user decide time to live, keep during truncation, etc.
  /** @deprecated Use tags instead. */
  timeToLive?: 'agentStep' | 'userPrompt'
  /** @deprecated Use tags instead. */
  keepDuringTruncation?: boolean
  /**
   * When a message with `keepLastTags` arrives, the latest declaration wins:
   * earlier messages that share any of the listed tags (a declaration's own
   * `tags` overlap counts too) are dropped from the assembled history.
   * Implemented in the agent runtime's per-step/expiry pass (expireMessages).
   *
   * @deprecated Use tags instead.
   */
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
