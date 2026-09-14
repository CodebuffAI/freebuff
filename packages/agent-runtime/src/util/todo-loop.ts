import { writeTodosParams } from '@codebuff/common/tools/params/tool/write-todos'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const TODO_LOOP_RECOVERY_TAG = 'TODO_LOOP_RECOVERY'
export const TODO_LOOP_RECOVERY_THRESHOLD = 3
export const TODO_LOOP_STOP_THRESHOLD = 6

export const TODO_LOOP_RECOVERY_MESSAGE =
  'You have repeatedly called write_todos with the same unchanged list and no other tool use in between. The list is already recorded. Stop repeating it. Use an available tool to make progress on the task, or explain the blocker to the user and end your turn. Respect the current mode and tool permissions.'

export const TODO_LOOP_STOP_MESSAGE =
  'The model got stuck repeating the same to-do list without making progress. This turn was stopped to avoid wasting more of your session. Try a different model or reasoning level, then continue.'

export class TodoLoopError extends Error {
  constructor() {
    super(TODO_LOOP_STOP_MESSAGE)
    this.name = 'TodoLoopError'
  }
}

/** Count identical completed to-do calls at the tail of this user turn.
 * Prose/reasoning and per-step scaffolding are not progress. A different list,
 * another tool, or a user message is. Only matched, completed calls count, so
 * interrupted/failed tool execution cannot masquerade as this model loop.
 */
export function trailingIdenticalTodoCalls(messages: Message[]): number {
  let count = 0
  let latestList: string | undefined
  const completed = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') {
      if (
        message.tags?.includes('STEP_PROMPT') ||
        message.tags?.includes(TODO_LOOP_RECOVERY_TAG)
      ) {
        continue
      }
      break
    }
    if (message.role === 'tool') {
      if (message.toolName !== 'write_todos') break
      completed.add(message.toolCallId)
      continue
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      continue

    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]!
      if (part.type !== 'tool-call') continue
      if (
        part.toolName !== 'write_todos' ||
        !completed.delete(part.toolCallId)
      ) {
        return count
      }
      const parsed = writeTodosParams.inputSchema.safeParse(part.input)
      if (!parsed.success) return count
      // Compare task/status rather than object key order or provider call IDs.
      const list = JSON.stringify(
        parsed.data.todos.map((todo) => [todo.task, todo.completed]),
      )
      if (latestList !== undefined && list !== latestList) return count
      latestList = list
      count++
    }
  }

  return count
}
