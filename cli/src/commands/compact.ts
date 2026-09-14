import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'
import { capturePendingAttachments } from '../utils/pending-attachments'

import type { RouterParams } from './command-registry'

/**
 * Handle the `/compact` (and `/summarize`) command.
 *
 * Bails out early with a system message when the conversation is empty,
 * queues the command if a stream or chain is actively running,
 * or dispatches `/compact` to the agent runtime to summarize and compact history.
 */
export async function handleCompactCommand(
  params: RouterParams,
): Promise<void> {
  const trimmed = params.inputValue.trim()
  params.saveToHistory(trimmed)
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })

  const messages = useChatStore.getState().messages
  if (messages.length === 0) {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage('Nothing to compact — the conversation is empty.'),
    ])
    return
  }

  // Check streaming/queue state
  if (
    params.isStreaming ||
    params.streamMessageIdRef.current ||
    params.isChainInProgressRef.current
  ) {
    const pendingAttachments = capturePendingAttachments()
    params.addToQueue('/compact', pendingAttachments)
    params.setInputFocused(true)
    params.inputRef.current?.focus()
    return
  }

  params.sendMessage({
    content: '/compact',
    agentMode: params.agentMode,
  })
  setTimeout(() => {
    params.scrollToLatest()
  }, 0)
}
