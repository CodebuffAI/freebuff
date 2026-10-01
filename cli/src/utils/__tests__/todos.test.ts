import { describe, expect, test } from 'bun:test'

import { getLatestTodos } from '../todos'

import type { ChatMessage, ContentBlock } from '../../types/chat'

const todoBlock = (input: unknown): ContentBlock => ({
  type: 'tool',
  toolName: 'write_todos',
  toolCallId: crypto.randomUUID(),
  agentId: 'root-agent',
  input,
})
const message = (blocks: ContentBlock[]): ChatMessage => ({
  id: crypto.randomUUID(),
  variant: 'ai',
  content: '',
  timestamp: new Date().toISOString(),
  blocks,
})
const plan = [{ task: 'Implement the change', completed: false }]
const completed = [{ task: 'Implement the change', completed: true }]

describe('latest main-agent todos', () => {
  test('uses the latest replacement list, including in a restored chat', () => {
    const messages = [
      message([todoBlock({ todos: plan })]),
      message([todoBlock({ todos: plan }), todoBlock({ todos: completed })]),
      message([{ type: 'text', content: 'All done.' }]),
    ]
    expect(getLatestTodos(messages)).toEqual(completed)
    expect(getLatestTodos(JSON.parse(JSON.stringify(messages)))).toEqual(
      completed,
    )
  })

  test('subagent checklists never replace the main list', () => {
    const childList = [
      todoBlock({ todos: [{ task: 'Subtask', completed: false }] }),
    ]
    const messages = [
      message([todoBlock({ todos: plan })]),
      message([
        {
          type: 'agent',
          agentId: 'child',
          agentName: 'Reviewer',
          agentType: 'reviewer',
          status: 'running',
          content: '',
          blocks: childList,
        },
      ]),
      { ...message(childList), variant: 'agent' as const, parentId: 'parent' },
      { ...message(childList), parentId: 'parent' },
    ]
    expect(getLatestTodos(messages)).toEqual(plan)
    expect(getLatestTodos(messages.slice(1))).toEqual([])
  })

  test('an empty replacement clears a previous checklist', () => {
    expect(
      getLatestTodos([
        message([todoBlock({ todos: plan }), todoBlock({ todos: [] })]),
      ]),
    ).toEqual([])
    expect(getLatestTodos([])).toEqual([])
  })

  test('malformed or incomplete calls do not hide the last valid checklist', () => {
    for (const input of [
      null,
      {},
      { todos: null },
      { todos: [null] },
      { todos: [{ task: 'Still streaming' }] },
      { todos: [{ task: 'Task', completed: 'yes' }] },
    ]) {
      expect(
        getLatestTodos([
          message([todoBlock({ todos: plan }), todoBlock(input)]),
        ]),
      ).toEqual(plan)
    }
  })
})
