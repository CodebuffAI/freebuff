import { writeTodosParams } from '@codebuff/common/tools/params/tool/write-todos'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const TODO_LOOP_RECOVERY_TAG = 'TODO_LOOP_RECOVERY'
export const TODO_LOOP_RECOVERY_THRESHOLD = 3
export const TODO_LOOP_STOP_THRESHOLD = 6

export const TODO_LOOP_RECOVERY_MESSAGE =
  'You have repeatedly called write_todos with the same unchanged list and no other tool use in between. The list is already recorded. Stop repeating it. Use an available tool to make progress on the task, or explain the blocker to the user and end your turn. Respect the current mode and tool permissions.'

export const TODO_LOOP_STOP_MESSAGE =
  'The model got stuck repeating the same to-do list without making progress. This turn was stopped to avoid wasting more of your session. Try a different model or reasoning level, then continue.'

/** The tool result for a write_todos call whose list matches the one already
 * recorded. The call is a no-op, and saying so right away is the point: the
 * generic "Todos written" reads as success, so a model stuck re-sending the
 * same list was rewarded for it on every step until the streak detector's
 * third call. */
export const WRITE_TODOS_UNCHANGED_MESSAGE =
  'To-do list unchanged: it is already recorded, so this call did nothing. Do not call write_todos again until a task changes status. Continue with the next incomplete task using an available tool, or tell the user what is blocking you and end your turn.'

const FILE_EDIT_TOOL_NAMES = ['write_file', 'str_replace', 'apply_patch']

/** Appended when the agent has no file-editing tool (Desktop plan mode, ask
 * modes, read-only agents). Seen 2026-09-22 on Desktop plan mode with GLM 5.3
 * Flash: the model's reasoning said "write it directly with write_file" on
 * every step while the call it emitted was write_todos, the only offered tool
 * whose name starts the same way. Telling it to use "an available tool" did
 * not help, because it believed write_file was one. */
export const FILE_EDIT_TOOLS_UNAVAILABLE_NOTE =
  'File-editing tools (write_file, str_replace, apply_patch) are not available to you right now, so do not call write_todos in their place. If the next task needs a file edit, tell the user and end your turn.'

export function hasFileEditTool(toolNames: readonly string[]): boolean {
  return FILE_EDIT_TOOL_NAMES.some((name) => toolNames.includes(name))
}

function withToolAvailability(
  message: string,
  toolNames: readonly string[],
): string {
  return hasFileEditTool(toolNames)
    ? message
    : `${message} ${FILE_EDIT_TOOLS_UNAVAILABLE_NOTE}`
}

export function todoLoopRecoveryMessage(toolNames: readonly string[]): string {
  return withToolAvailability(TODO_LOOP_RECOVERY_MESSAGE, toolNames)
}

export function writeTodosUnchangedMessage(
  toolNames: readonly string[],
): string {
  return withToolAvailability(WRITE_TODOS_UNCHANGED_MESSAGE, toolNames)
}

/** A comparable key for a write_todos input, or undefined when it does not
 * parse. Compares task/status rather than object key order or call IDs. */
export function todoListKey(input: unknown): string | undefined {
  const parsed = writeTodosParams.inputSchema.safeParse(input)
  if (!parsed.success) return undefined
  return JSON.stringify(
    parsed.data.todos.map((todo) => [todo.task, todo.completed]),
  )
}

/** The key of the most recent write_todos call that completed, anywhere in the
 * history. A new user message does not reset it: re-sending the same list at
 * the start of a turn records nothing new either. */
export function latestRecordedTodoListKey(
  messages: Message[],
): string | undefined {
  const completed = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'tool') {
      if (message.toolName === 'write_todos') completed.add(message.toolCallId)
      continue
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]!
      if (
        part.type === 'tool-call' &&
        part.toolName === 'write_todos' &&
        completed.has(part.toolCallId)
      ) {
        return todoListKey(part.input)
      }
    }
  }
  return undefined
}

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
      const list = todoListKey(part.input)
      if (list === undefined) return count
      if (latestList !== undefined && list !== latestList) return count
      latestList = list
      count++
    }
  }

  return count
}
