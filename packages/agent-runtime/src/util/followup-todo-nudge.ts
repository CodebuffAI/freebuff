import { writeTodosParams } from '@codebuff/common/tools/params/tool/write-todos'

import { todoListKey } from './todo-loop'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * A turn that ends on suggest_followups while the agent's own to-do list is
 * half done gets sent back to work.
 *
 * suggest_followups does not force another step, so a step whose only tool
 * call is suggest_followups ends the turn. Models use that to stop mid-plan
 * with a "Continue with the next step" card, and the user, often on a timed
 * free session, has to come back and type "continue" (CodebuffAI/freebuff#1434).
 * The agent's to-do list is the one model-agnostic signal of whether the work
 * it took on is finished, so the runtime checks it rather than a prompt line
 * every model reads differently.
 *
 * Deliberately narrow, because a wrong nudge spends a step and overrides a
 * legitimate hand-back:
 * - Only the list written during the current user prompt counts. A question
 *   asked after an earlier, abandoned plan never resumes that plan.
 * - The list must have at least one completed item. A list with none is a plan
 *   being proposed ("here is how I'd do it, shall I start?"), not execution
 *   interrupted part-way.
 * - A repeat nudge needs progress: if the list is unchanged since the last
 *   nudge, the model has already declined once (blocked, waiting on the user),
 *   so the turn ends. At most MAX_FOLLOWUP_TODO_NUDGES per user prompt either
 *   way.
 */
export const FOLLOWUP_TODO_NUDGE_TAG = 'FOLLOWUP_TODO_NUDGE'
export const MAX_FOLLOWUP_TODO_NUDGES = 3

const MAX_LISTED_TODOS = 3
const MAX_TODO_CHARS = 100

export type FollowupTodoNudgeDecision =
  | {
      action: 'nudge'
      openTodos: string[]
      nudgesSoFar: number
      message: string
    }
  | {
      action: 'end'
      reason: 'cap' | 'no_progress'
      openTodos: string[]
      nudgesSoFar: number
    }

type Todo = { task: string; completed: boolean }

/** Called when a step is about to end the turn on suggest_followups. Returns
 * undefined when the to-do list gives no reason to keep going. */
export function decideFollowupTodoNudge(
  messages: Message[],
): FollowupTodoNudgeDecision | undefined {
  const completedCalls = new Set<string>()
  let latest: Todo[] | undefined
  let latestKey: string | undefined
  let nudges = 0
  let keyAtLastNudge: string | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') {
      if (message.tags?.includes('USER_PROMPT')) break
      if (message.tags?.includes(FOLLOWUP_TODO_NUDGE_TAG)) nudges++
      continue
    }
    if (message.role === 'tool') {
      if (message.toolName === 'write_todos') {
        completedCalls.add(message.toolCallId)
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
      const key = todoListKey(part.input)
      if (latest === undefined) {
        latest = parsed.data.todos
        latestKey = key
      }
      // The newest list older than the most recent nudge: what the model had
      // when it was last told to continue.
      if (nudges > 0 && keyAtLastNudge === undefined) keyAtLastNudge = key
    }
  }

  if (!latest) return undefined
  const openTodos = latest.filter((todo) => !todo.completed).map((t) => t.task)
  if (openTodos.length === 0) return undefined
  if (!latest.some((todo) => todo.completed)) return undefined

  if (nudges >= MAX_FOLLOWUP_TODO_NUDGES) {
    return { action: 'end', reason: 'cap', openTodos, nudgesSoFar: nudges }
  }
  if (nudges > 0 && keyAtLastNudge === latestKey) {
    return {
      action: 'end',
      reason: 'no_progress',
      openTodos,
      nudgesSoFar: nudges,
    }
  }
  return {
    action: 'nudge',
    openTodos,
    nudgesSoFar: nudges,
    message: followupTodoNudgeMessage(openTodos),
  }
}

export function followupTodoNudgeMessage(openTodos: string[]): string {
  const listed = openTodos
    .slice(0, MAX_LISTED_TODOS)
    .map((task) =>
      task.length > MAX_TODO_CHARS
        ? `"${task.slice(0, MAX_TODO_CHARS - 1)}…"`
        : `"${task}"`,
    )
  const more =
    openTodos.length > MAX_LISTED_TODOS
      ? ` and ${openTodos.length - MAX_LISTED_TODOS} more`
      : ''
  const count = `${openTodos.length} unfinished item${openTodos.length === 1 ? '' : 's'}`
  return `You suggested followups and were about to end your turn, but your to-do list still has ${count}: ${listed.join(', ')}${more}. The task is not finished, so do not stop to wait for the user: continue now with the next unfinished item. Only end your turn before the list is done if you are blocked on something only the user can provide (a decision, credentials, an action on their machine) or they asked you to stop after this step, and then say plainly what you need. If an item is no longer needed, update the list with write_todos.`
}
