import { isSponsoredProposalBlock } from '../types/chat'
import type { ChatMessage, SponsoredProposalContentBlock } from '../types/chat'

/** A delayed control may update only the proposal it originally addressed. */
export function patchSponsoredProposalBlock(
  messages: ChatMessage[],
  target: string,
  patch: Partial<SponsoredProposalContentBlock>,
  proposalId?: string,
): ChatMessage[] {
  const matches = (
    block: NonNullable<ChatMessage['blocks']>[number],
  ): block is SponsoredProposalContentBlock =>
    isSponsoredProposalBlock(block) &&
    block.target === target &&
    (proposalId === undefined || block.proposal._id === proposalId)
  return messages.map((message) =>
    message.blocks?.some(matches)
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            matches(block) ? { ...block, ...patch } : block,
          ),
        }
      : message,
  )
}
