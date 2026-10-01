import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import React, { useState } from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { TodoPanel } from '../todo-panel'

import type { ChatMessage } from '../../types/chat'
import type { TodoItem } from '../../utils/todos'

let cleanup: (() => void) | undefined
beforeAll(() => initializeThemeStore())
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function todoMessage(todos: TodoItem[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    variant: 'ai',
    content: '',
    timestamp: new Date().toISOString(),
    blocks: [
      {
        type: 'tool',
        toolName: 'write_todos',
        toolCallId: crypto.randomUUID(),
        input: { todos },
      },
    ],
  }
}

async function mountPanel(initial: ChatMessage[], width = 80) {
  let setMessages!: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  let closes = 0
  function Host() {
    const [messages, updateMessages] = useState(initial)
    const [open, setOpen] = useState(true)
    setMessages = updateMessages
    return open ? (
      <TodoPanel
        messages={messages}
        maxVisibleRows={4}
        onClose={() => {
          closes++
          setOpen(false)
        }}
      />
    ) : (
      <text>Composer restored</text>
    )
  }
  const setup = await createTestRenderer({
    width,
    height: 12,
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  cleanup = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => root.render(<Host />))
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }
  await settle()
  return {
    ...setup,
    settle,
    get closes() {
      return closes
    },
    async update(todos: TodoItem[]) {
      flushSync(() => setMessages((prev) => [...prev, todoMessage(todos)]))
      await settle()
    },
  }
}

describe('TodoPanel', () => {
  test('shows completion counts and updates in place as the agent progresses', async () => {
    const todos = [
      { task: 'Investigate', completed: true },
      { task: 'Implement', completed: false },
    ]
    const panel = await mountPanel([todoMessage(todos)])
    expect(panel.captureCharFrame()).toContain('1/2 completed')
    expect(panel.captureCharFrame()).toContain('✓  Investigate')
    expect(panel.captureCharFrame()).toContain('☐  Implement')
    await panel.update(todos.map((todo) => ({ ...todo, completed: true })))
    expect(panel.captureCharFrame()).toContain('2/2 completed')
    expect(panel.captureCharFrame()).toContain('✓  Implement')
  })

  test('an empty panel stays open for the first checklist, and a cleared list stays empty', async () => {
    const panel = await mountPanel([])
    expect(panel.captureCharFrame()).toContain('No todos yet.')
    await panel.update([{ task: 'New task', completed: false }])
    expect(panel.captureCharFrame()).toContain('0/1 completed')
    expect(panel.captureCharFrame()).toContain('New task')
    await panel.update([])
    expect(panel.captureCharFrame()).toContain('No todos yet.')
    expect(panel.captureCharFrame()).not.toContain('New task')
    expect(panel.closes).toBe(0)
  })

  test('long checklists scroll independently and preserve position on live updates', async () => {
    const todos = Array.from({ length: 15 }, (_, i) => ({
      task: `Task ${String(i + 1).padStart(2, '0')}`,
      completed: false,
    }))
    const panel = await mountPanel([todoMessage(todos)])
    expect(panel.captureCharFrame()).toContain('Task 01')
    expect(panel.captureCharFrame()).not.toContain('Task 15')
    panel.mockInput.pressKey('END')
    await panel.settle()
    expect(panel.captureCharFrame()).toContain('Task 15')
    expect(panel.captureCharFrame()).not.toContain('Task 01')
    await panel.update(todos.map((todo) => ({ ...todo, completed: true })))
    expect(panel.captureCharFrame()).toContain('15/15 completed')
    expect(panel.captureCharFrame()).toContain('Task 15')
    panel.mockInput.pressKey('HOME')
    await panel.settle()
    expect(panel.captureCharFrame()).toContain('Task 01')
  })

  test('wrapped task text remains reachable in a narrow terminal', async () => {
    const panel = await mountPanel(
      [
        todoMessage([
          {
            task: 'A long task with enough words to wrap across several rows in a narrow terminal and a recognizable ending: FINISHED',
            completed: false,
          },
        ]),
      ],
      35,
    )
    panel.mockInput.pressKey('END')
    await panel.settle()
    expect(panel.captureCharFrame()).toContain('FINISHED')
  })

  test('Escape closes the panel and returns the composer', async () => {
    const panel = await mountPanel([])
    panel.mockInput.pressEscape()
    await panel.settle()
    expect(panel.closes).toBe(1)
    expect(panel.captureCharFrame()).toContain('Composer restored')
  })
})
