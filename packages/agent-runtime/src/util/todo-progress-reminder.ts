import { writeTodosParams } from '@codebuff/common/tools/params/tool/write-todos'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * Reminds an agent working through its own to-do list to tick items off as it
 * goes.
 *
 * Every surface's to-do counter reads the newest write_todos call, so it only
 * moves when the model calls the tool again. The tool description asks for that
 * after each step, but models write the plan once and mark everything done at
 * the end: Desktop threads read on 2026-10-06 went 0/6 straight to 6/6 across
 * 9-19 tool calls, so the user saw no progress until the work was over.
 *
 * Bounded, because each reminder is a message the model has to read:
 * - Only the list written during the current user prompt, with an open item.
 * - Only after TODO_PROGRESS_REMINDER_AFTER other tool calls since that list.
 * - At most once per list: a reminder after the newest write_todos means it
 *   was already given, so a model that ignores it is not asked again until it
 *   writes the list again.
 */
export const TODO_PROGRESS_REMINDER_TAG = 'TODO_PROGRESS_REMINDER'
export const TODO_PROGRESS_REMINDER_AFTER = 5

export type TodoProgressReminder = {
  done: number
  total: number
  callsSinceUpdate: number
  message: string
}

/** Called after a step that does not end the turn. Returns undefined when the
 * list is absent, finished, recently updated, or was already reminded about. */
export function decideTodoProgressReminder(
  messages: Message[],
): TodoProgressReminder | undefined {
  const completedCalls = new Set<string>()
  let callsSinceUpdate = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') {
      if (message.tags?.includes('USER_PROMPT')) return undefined
      if (message.tags?.includes(TODO_PROGRESS_REMINDER_TAG)) return undefined
      continue
    }
    if (message.role === 'tool') {
      if (message.toolName === 'write_todos') {
        completedCalls.add(message.toolCallId)
      } else {
        callsSinceUpdate++
      }
      continue
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]!
      if (
        part.type !== 'tool-call' ||
        part.toolName !== 'write_todos' ||
        !completedCalls.has(part.toolCallId)
      ) {
        continue
      }
      const parsed = writeTodosParams.inputSchema.safeParse(part.input)
      if (!parsed.success) continue
      const { todos } = parsed.data
      const done = todos.filter((todo) => todo.completed).length
      if (todos.length === 0 || done === todos.length) return undefined
      if (callsSinceUpdate < TODO_PROGRESS_REMINDER_AFTER) return undefined
      return {
        done,
        total: todos.length,
        callsSinceUpdate,
        message: todoProgressReminderMessage(
          done,
          todos.length,
          callsSinceUpdate,
        ),
      }
    }
  }
  return undefined
}

export function todoProgressReminderMessage(
  done: number,
  total: number,
  callsSinceUpdate: number,
): string {
  return `Your to-do list still shows ${done} of ${total} done, and you have made ${callsSinceUpdate} tool calls since you last updated it. The user watches that list as your live progress. If you have finished any item since, call write_todos now with it marked completed, then continue with the next item. If you have not finished one yet, do not call write_todos; just continue.`
}
