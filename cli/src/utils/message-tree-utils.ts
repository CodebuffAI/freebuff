import type { ChatMessage } from '../types/chat'

export function buildMessageTree(messages: ChatMessage[]): {
  tree: Map<string, ChatMessage[]>
  topLevelMessages: ChatMessage[]
} {
  const messageTree = new Map<string, ChatMessage[]>()
  const topLevelMessages: ChatMessage[] = []

  for (const message of messages) {
    if (message.parentId) {
      const siblings = messageTree.get(message.parentId) ?? []
      siblings.push(message)
      messageTree.set(message.parentId, siblings)
    } else {
      topLevelMessages.push(message)
    }
  }

  return { tree: messageTree, topLevelMessages }
}
