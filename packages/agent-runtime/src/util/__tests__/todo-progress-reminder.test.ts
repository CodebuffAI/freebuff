import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  decideTodoProgressReminder,
  TODO_PROGRESS_REMINDER_AFTER,
  TODO_PROGRESS_REMINDER_TAG,
} from '../todo-progress-reminder'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

type Todo = { task: string; completed: boolean }

let ids = 0
function call(
  toolName: string,
  input: Record<string, unknown>,
  answered = true,
): Message[] {
  const toolCallId = `call-${++ids}`
  const message = assistantMessage({
    type: 'tool-call',
    toolCallId,
    toolName,
    input,
  })
  return answered
    ? [message, { role: 'tool', toolCallId, toolName, content: [] }]
    : [message]
}

const todos = (list: Todo[], answered = true) =>
  call('write_todos', { todos: list }, answered)
const reads = (n: number) =>
  Array.from({ length: n }, () =>
    call('read_files', { paths: ['a.ts'] }),
  ).flat()
const prompt = (text = 'Build the feature') =>
  userMessage({ content: text, tags: ['USER_PROMPT'] })
const reminder = () =>
  userMessage({ content: 'tick', tags: [TODO_PROGRESS_REMINDER_TAG] })

const list = (done: number, total = 7): Todo[] =>
  Array.from({ length: total }, (_, i) => ({
    task: `Step ${i + 1}`,
    completed: i < done,
  }))

describe('decideTodoProgressReminder', () => {
  it('reminds once the list has gone untouched for enough tool calls', () => {
    const decision = decideTodoProgressReminder([
      prompt(),
      ...todos(list(0)),
      ...reads(TODO_PROGRESS_REMINDER_AFTER),
    ])
    expect(decision).toMatchObject({
      done: 0,
      total: 7,
      callsSinceUpdate: TODO_PROGRESS_REMINDER_AFTER,
    })
    expect(decision?.message).toContain('0 of 7 done')
  })

  it('counts from the newest list, so a model that ticks items off is never reminded', () => {
    const messages: Message[] = [prompt(), ...todos(list(0))]
    for (let done = 1; done < 7; done++) {
      messages.push(
        ...reads(TODO_PROGRESS_REMINDER_AFTER - 1),
        ...todos(list(done)),
      )
      expect(decideTodoProgressReminder(messages)).toBeUndefined()
    }
  })

  it.each([
    ['no list was written', [prompt(), ...reads(10)]],
    [
      'too few calls since the list',
      [prompt(), ...todos(list(2)), ...reads(TODO_PROGRESS_REMINDER_AFTER - 1)],
    ],
    ['every item is done', [prompt(), ...todos(list(7)), ...reads(10)]],
    ['the list is empty', [prompt(), ...todos([]), ...reads(10)]],
    [
      'the list belongs to an earlier prompt',
      [prompt(), ...todos(list(1)), prompt('Now explain it'), ...reads(10)],
    ],
    [
      'the write never completed',
      [prompt(), ...todos(list(1), false), ...reads(10)],
    ],
    [
      'this list was already reminded about',
      [prompt(), ...todos(list(1)), ...reads(5), reminder(), ...reads(10)],
    ],
  ])('does not remind when %s', (_label, messages) => {
    expect(decideTodoProgressReminder(messages as Message[])).toBeUndefined()
  })

  it('reminds again about a newer list after the model updated it', () => {
    expect(
      decideTodoProgressReminder([
        prompt(),
        ...todos(list(0)),
        ...reads(5),
        reminder(),
        ...todos(list(2)),
        ...reads(TODO_PROGRESS_REMINDER_AFTER),
      ]),
    ).toMatchObject({ done: 2, total: 7 })
  })
})
