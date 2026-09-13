import type { SponsoredProposalRow } from '@codebuff/common/ads/sponsored-proposal-view'
import type { ChatTheme } from './theme-system'
import type { ToolName } from '@codebuff/sdk'
import type { ReactNode } from 'react'

/**
 * isCollapsed/userOpened are duplicated across block types intentionally - each UI
 * element tracks collapse state independently for different defaults and to persist
 * user intent vs programmatic state.
 */

export type ChatVariant = 'ai' | 'user' | 'agent' | 'error'

export type ThinkingCollapseState = 'expanded' | 'preview' | 'hidden'

export type TextContentBlock = {
  type: 'text'
  content: string
  color?: string
  marginTop?: number
  marginBottom?: number
  status?: 'running' | 'complete'
  textType?: 'reasoning' | 'text'
  isCollapsed?: boolean
  thinkingId?: string
  userOpened?: boolean
  /** True if this is a reasoning block from a <think> tag that hasn't been closed yet */
  thinkingOpen?: boolean
  thinkingCollapseState?: ThinkingCollapseState
}
/** Renders dynamic React content. NOT serializable - don't use for persistent data. */
export type HtmlContentBlock = {
  type: 'html'
  marginTop?: number
  marginBottom?: number
  render: (context: { textColor: string; theme: ChatTheme }) => ReactNode
}
export type ToolContentBlock = {
  type: 'tool'
  toolCallId: string
  toolName: ToolName
  input: any
  output?: string
  outputRaw?: unknown
  agentId?: string
  includeToolCall?: boolean
  isCollapsed?: boolean
  userOpened?: boolean
}
export type AgentContentBlock = {
  type: 'agent'
  agentId: string
  agentName: string
  agentType: string
  content: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  blocks?: ContentBlock[]
  initialPrompt?: string
  params?: Record<string, any>
  isCollapsed?: boolean
  userOpened?: boolean
  /** The spawn_agents tool call ID that created this block, used to match results */
  spawnToolCallId?: string
  /** The index within the spawn_agents call, used to match the correct result */
  spawnIndex?: number
}
export type AgentListContentBlock = {
  type: 'agent-list'
  id: string
  agents: Array<{ id: string; displayName: string }>
  agentsDir: string
  isCollapsed?: boolean
  userOpened?: boolean
}
export type ModeDividerContentBlock = {
  type: 'mode-divider'
  mode: string
}

export type PlanContentBlock = {
  type: 'plan'
  content: string
}

export type AskUserContentBlock = {
  type: 'ask-user'
  toolCallId: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{
      label: string
      description?: string
    }>
    multiSelect?: boolean
    validation?: {
      maxLength?: number
      minLength?: number
      pattern?: string
      patternError?: string
    }
  }>
  answers?: Array<{
    questionIndex: number
    selectedOption?: string
    selectedOptions?: string[]
    otherText?: string
  }>
  skipped?: boolean
}

export type ImageContentBlock = {
  type: 'image'
  image: string // base64 encoded
  mediaType: string
  filename?: string
  size?: number
  width?: number
  height?: number
  isCollapsed?: boolean
  userOpened?: boolean
}

export type ImageAttachment = {
  filename: string
  path: string
  size?: number
}

export type TextAttachment = {
  id: string
  content: string
  preview: string
  charCount: number
}

export type FileAttachment = {
  path: string
  filename: string
  isDirectory: boolean
  note?: string
}

/**
 * A sponsored proposal, in the transcript (COD-376).
 *
 * A BLOCK rather than an `HtmlContentBlock`: html blocks are not serializable
 * and this one has to survive being written to and read back from history like
 * every other block. It carries the ROW and nothing derived -- every label,
 * every action and both destination gates come from
 * `@codebuff/common/ads/sponsored-proposal-view`, so the terminal card and the
 * web card cannot drift.
 *
 * ACCEPT ARRIVED IN PHASE 2 (COD-339) and runs LOCALLY, in a git worktree on
 * this machine, under the COD-336 boundary. It is reached by
 * `/ads:accept-proposal`, which opens the consent below rather than starting
 * anything.
 */
export type SponsoredProposalContentBlock = {
  type: 'sponsored-proposal'
  /** The proposal row, as `activeProposal` projects it. */
  proposal: SponsoredProposalRow & { _id: string; advertiser_id: string }
  /** `owner/name` -- what the offer is about, and what a decline is keyed to. */
  target: string
  /**
   * The consent screen, open, with everything it names.
   *
   * The whole of it is known BEFORE the accept, which is what lets a refusal
   * write nothing at all: the advertiser, the headline and the body are already
   * on the card, and the folder and the branch come from this checkout. It
   * cannot show the reviewed procedure TEXT, because the accept response is the
   * only place that exists -- the same trade Desktop's dialog makes, for the
   * same ordering reason (`utils/sponsored-run.ts`).
   */
  consent?: {
    advertiserName: string
    headline: string
    body: string
    folder: string
    branch: string
    /** The id the branch above was minted with. Carried into the accept. */
    runId: string
  }
  /** Which consent choice the caret is on. Reset every time it opens. */
  consentIndex?: number
  /**
   * A local run was started from THIS card.
   *
   * Distinct from `proposal.state`: an accept leaves the row readable as
   * `offered` until the first poll, and `sponsoredProposalAwaitsVerdict` has to
   * know a run exists before the row admits it -- otherwise the poll drops to
   * the offer cadence at exactly the moment watching starts to matter.
   */
  runStarted?: boolean
  /** The four-item channel menu is open. */
  menuOpen?: boolean
  /** "Why this?" is expanded. */
  whyOpen?: boolean
  /** A control is in flight; every control reads it, so a second press is inert. */
  busy?: boolean
  /**
   * The latest poll could not establish whether this row is still current.
   * The card remains visible as context, but proposal-specific controls pause
   * until a successful refresh clears this marker.
   */
  refreshUnavailable?: boolean
  /** Answered, and standing down. Kept in place so history stays honest. */
  answered?: boolean
}

export type ContentBlock =
  | AgentContentBlock
  | AgentListContentBlock
  | AskUserContentBlock
  | HtmlContentBlock
  | ImageContentBlock
  | ModeDividerContentBlock
  | SponsoredProposalContentBlock
  | TextContentBlock
  | ToolContentBlock
  | PlanContentBlock

export type AgentMessage = {
  agentName: string
  agentType: string
  responseCount: number
  subAgentCount?: number
}

export type ChatMessageMetadata = {
  /** Working directory where a bash command was executed */
  bashCwd?: string
  /** UI-only marker for /undo or /redo confirmation messages so they render
   * with a distinct color instead of looking like plain agent output. */
  commandResult?: 'undo' | 'redo'
  /** UI-only marker for a response created in this process. Restored messages
   * strip it so ads are never fetched retroactively into settled history. */
  allowInlineAds?: boolean
  /** Whether this message/agent is collapsed in the UI */
  isCollapsed?: boolean
  /** Whether the user manually opened this collapsed item */
  userOpened?: boolean
  /** RunState stored after completion */
  runState?: unknown
}

export type ChatMessage = {
  id: string
  variant: ChatVariant
  content: string
  blocks?: ContentBlock[]
  timestamp: string
  parentId?: string
  agent?: AgentMessage
  isCompletion?: boolean
  credits?: number
  completionTime?: string
  isComplete?: boolean
  metadata?: ChatMessageMetadata
  validationErrors?: Array<{ id: string; message: string }>
  /**
   * UI-only runtime error displayed in UserErrorBanner (not sent to LLM).
   * Set by setError() when an error occurs during message streaming.
   * Can be cleared by clearUserError() when starting a new successful interaction.
   */
  userError?: string
  attachments?: ImageAttachment[]
  textAttachments?: TextAttachment[]
  fileAttachments?: FileAttachment[]
}

// Type guard functions for safe type narrowing
export function isTextBlock(block: ContentBlock): block is TextContentBlock {
  return block.type === 'text'
}

export function isToolBlock(block: ContentBlock): block is ToolContentBlock {
  return block.type === 'tool'
}

export function isAgentBlock(block: ContentBlock): block is AgentContentBlock {
  return block.type === 'agent'
}

export function isHtmlBlock(block: ContentBlock): block is HtmlContentBlock {
  return block.type === 'html'
}

export function isAgentListBlock(
  block: ContentBlock,
): block is AgentListContentBlock {
  return block.type === 'agent-list'
}

export function isPlanBlock(block: ContentBlock): block is PlanContentBlock {
  return block.type === 'plan'
}

export function isModeDividerBlock(
  block: ContentBlock,
): block is ModeDividerContentBlock {
  return block.type === 'mode-divider'
}

export function isAskUserBlock(
  block: ContentBlock,
): block is AskUserContentBlock {
  return block.type === 'ask-user'
}

export function isImageBlock(block: ContentBlock): block is ImageContentBlock {
  return block.type === 'image'
}

export function isSponsoredProposalBlock(
  block: ContentBlock,
): block is SponsoredProposalContentBlock {
  return block.type === 'sponsored-proposal'
}
