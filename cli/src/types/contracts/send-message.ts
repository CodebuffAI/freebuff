import type { PendingAttachment } from '../store'
import type { AgentMode } from '../../utils/constants'
import type { ChatMessage } from '../chat'
import type {
  SponsoredTurnPlan,
  SponsoredTurnResult,
} from '../../utils/sponsored-run'

export type PostUserMessageFn = (prev: ChatMessage[]) => ChatMessage[]

/**
 * A sponsored turn, run IN the conversation (#3989) rather than beside it.
 *
 * It rides the ordinary send path so it streams into the transcript and holds
 * the chain -- which is what queues the user's next message behind it -- but it
 * is NOT the user's turn: no user bubble, fresh agent memory, nothing written
 * back to the conversation's run state, no steering, and no Freebuff session
 * or credits, because the sponsor's grant pays for it.
 */
export type SponsoredSend = {
  plan: SponsoredTurnPlan
  /** The row that marks where the sponsored stretch begins. */
  anchor: ChatMessage
  onSettled: (result: SponsoredTurnResult) => void
}

export type SendMessageFn = (params: {
  content: string
  agentMode: AgentMode
  postUserMessage?: PostUserMessageFn
  attachments?: PendingAttachment[]
  sponsored?: SponsoredSend
}) => Promise<void>
