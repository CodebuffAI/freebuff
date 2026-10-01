import type { ChatMessage } from '../types/chat'

export type TodoItem = { task: string; completed: boolean }

export function parseTodos(input: unknown): TodoItem[] | null {
  if (!input || typeof input !== 'object' || !('todos' in input)) return null
  const { todos } = input
  if (!Array.isArray(todos)) return null
  return todos.every(
    (todo): todo is TodoItem =>
      todo !== null &&
      typeof todo === 'object' &&
      typeof todo.task === 'string' &&
      typeof todo.completed === 'boolean',
  )
    ? todos
    : null
}

/** Each write replaces the whole list. Only inspect root tool blocks: a
 * subagent's own checklist must not replace the main agent's progress. */
export function getLatestTodos(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.variant !== 'ai' || message.parentId) continue
    const blocks = message.blocks ?? []
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]
      if (block.type !== 'tool' || block.toolName !== 'write_todos') continue
      const todos = parseTodos(block.input)
      // An explicit empty list clears the old one; a malformed/partial input
      // does not. Restored chats use the same serialized blocks as live chats.
      if (todos !== null) return todos
    }
  }
  return []
}
