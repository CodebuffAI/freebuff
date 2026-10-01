import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  decideFollowupTodoNudge,
  FOLLOWUP_TODO_NUDGE_TAG,
  followupTodoNudgeMessage,
  MAX_FOLLOWUP_TODO_NUDGES,
} from '../followup-todo-nudge'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

type Todo = { task: string; completed: boolean }

function todos(id: string, list: Todo[], answered = true): Message[] {
  const call = assistantMessage({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'write_todos',
    input: { todos: list },
  })
  return answered
    ? [
        call,
        { role: 'tool', toolCallId: id, toolName: 'write_todos', content: [] },
      ]
    : [call]
}

const prompt = (text = 'Build the feature') =>
  userMessage({ content: text, tags: ['USER_PROMPT'] })
const nudge = () =>
  userMessage({ content: 'continue', tags: [FOLLOWUP_TODO_NUDGE_TAG] })

const partDone: Todo[] = [
  { task: 'Write the model', completed: true },
  { task: 'Wire the route', completed: false },
  { task: 'Add tests', completed: false },
]

describe('decideFollowupTodoNudge', () => {
  it('nudges when the list written this prompt is part done', () => {
    const decision = decideFollowupTodoNudge([
      prompt(),
      ...todos('a', partDone),
    ])
    expect(decision).toMatchObject({
      action: 'nudge',
      openTodos: ['Wire the route', 'Add tests'],
      nudgesSoFar: 0,
    })
  })

  it.each([
    ['no list was written', [prompt()]],
    [
      'every item is done',
      [
        prompt(),
        ...todos(
          'a',
          partDone.map((t) => ({ ...t, completed: true })),
        ),
      ],
    ],
    [
      'nothing is done yet (a proposed plan)',
      [
        prompt(),
        ...todos(
          'a',
          partDone.map((t) => ({ ...t, completed: false })),
        ),
      ],
    ],
    [
      'the list belongs to an earlier prompt',
      [prompt(), ...todos('a', partDone), prompt('What does this file do?')],
    ],
    ['the call never completed', [prompt(), ...todos('a', partDone, false)]],
  ] satisfies [string, Message[]][])('does nothing when %s', (_, messages) => {
    expect(decideFollowupTodoNudge(messages)).toBeUndefined()
  })

  it('uses the newest list in the prompt', () => {
    const done = partDone.map((t) => ({ ...t, completed: true }))
    expect(
      decideFollowupTodoNudge([
        prompt(),
        ...todos('a', partDone),
        ...todos('b', done),
      ]),
    ).toBeUndefined()
  })

  it('nudges again only after the list changed', () => {
    const progressed = partDone.map((t, i) => ({ ...t, completed: i < 2 }))
    expect(
      decideFollowupTodoNudge([prompt(), ...todos('a', partDone), nudge()]),
    ).toMatchObject({ action: 'end', reason: 'no_progress', nudgesSoFar: 1 })
    expect(
      decideFollowupTodoNudge([
        prompt(),
        ...todos('a', partDone),
        nudge(),
        ...todos('b', progressed),
      ]),
    ).toMatchObject({
      action: 'nudge',
      openTodos: ['Add tests'],
      nudgesSoFar: 1,
    })
  })

  it(`stops after ${MAX_FOLLOWUP_TODO_NUDGES} nudges in one prompt`, () => {
    const messages: Message[] = [prompt()]
    for (let i = 0; i < MAX_FOLLOWUP_TODO_NUDGES; i++) {
      messages.push(
        ...todos(`t${i}`, [
          ...partDone,
          { task: `extra ${i}`, completed: false },
        ]),
        nudge(),
      )
    }
    messages.push(...todos('last', partDone))
    expect(decideFollowupTodoNudge(messages)).toMatchObject({
      action: 'end',
      reason: 'cap',
      nudgesSoFar: MAX_FOLLOWUP_TODO_NUDGES,
    })
    // A new prompt starts a fresh budget.
    expect(
      decideFollowupTodoNudge([
        ...messages,
        prompt('Keep going'),
        ...todos('n', partDone),
      ]),
    ).toMatchObject({ action: 'nudge', nudgesSoFar: 0 })
  })
})

describe('followupTodoNudgeMessage', () => {
  it('names up to three open items, truncated', () => {
    const long = 'x'.repeat(150)
    const message = followupTodoNudgeMessage([long, 'b', 'c', 'd', 'e'])
    expect(message).toContain('5 unfinished items')
    expect(message).toContain(`"${'x'.repeat(99)}…"`)
    expect(message).toContain('"c" and 2 more')
    expect(message).not.toContain('"d"')
  })
})
