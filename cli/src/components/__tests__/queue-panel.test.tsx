import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React, { useState } from 'react'

import { QueuePanel } from '../queue-panel'
import { initializeThemeStore } from '../../hooks/use-theme'

import type { QueuedMessage } from '../../hooks/use-message-queue'

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
})

const message = (id: string, content: string): QueuedMessage => ({
  id,
  content,
  attachments: [],
})

/**
 * Mounts the panel over a queue the harness owns, so the assertions are about
 * what the panel asked for rather than the queue hook's internals. The queue
 * lives inside React: re-rendering the root from the outside remounts the
 * component under this renderer, which would leave a stale panel subscribed to
 * the keyboard alongside the live one.
 */
const mountPanel = async (
  initial: QueuedMessage[],
  /** Answer every action the way the real queue does once a message has left
   *  it: refuse, so the panel has to tell the user. */
  options: { refuseActions?: boolean } = {},
) => {
  const state = {
    queue: initial,
    closes: 0,
    write: (_next: QueuedMessage[]) => {},
  }

  const Harness = () => {
    const [queue, setQueue] = useState(initial)
    // Mirror the real hook: writes land synchronously so an action taken in
    // the same keypress sees them, and React repaints from the same value.
    const write = (next: QueuedMessage[]) => {
      state.queue = next
      setQueue(next)
    }
    state.write = write

    if (options.refuseActions) {
      return (
        <QueuePanel
          queuedMessages={queue}
          onEdit={() => false}
          onDelete={() => false}
          onMove={() => false}
          onClose={() => {
            state.closes++
          }}
          width={70}
        />
      )
    }

    return (
      <QueuePanel
        queuedMessages={queue}
        onEdit={(id, content) => {
          if (!state.queue.some((item) => item.id === id)) return false
          write(
            state.queue.map((item) =>
              item.id === id ? { ...item, content } : item,
            ),
          )
          return true
        }}
        onDelete={(id) => {
          const next = state.queue.filter((item) => item.id !== id)
          if (next.length === state.queue.length) return false
          write(next)
          return true
        }}
        onMove={(id, toIndex) => {
          const from = state.queue.findIndex((item) => item.id === id)
          if (from === -1) return false
          const to = Math.max(0, Math.min(state.queue.length - 1, toIndex))
          if (to === from) return false
          const next = [...state.queue]
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved!)
          write(next)
          return true
        }}
        onClose={() => {
          state.closes++
        }}
        width={70}
      />
    )
  }

  const setup = await createTestRenderer({
    width: 70,
    height: 14,
    // Unambiguous encoding: a bare Escape is otherwise indistinguishable from
    // the start of the next key's sequence, and shift+arrow is unencodable.
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  flushSync(() => root.render(<Harness />))
  await setup.renderOnce()

  /** Mock input reaches the handlers synchronously, so dispatching it inside
   *  flushSync commits what it sets, effects included, before the next event.
   *  Waiting a fixed 20ms for React's scheduler instead let a late commit on a
   *  busy CI runner hand the next key to the previous render's handler. */
  const dispatch = async (act: () => void) => {
    flushSync(act)
    await setup.renderOnce()
  }

  return Object.assign(setup, {
    contents: () => state.queue.map((item) => item.content),
    closes: () => state.closes,
    press: dispatch,
    async click(x: number, y: number, button: 0 | 1 | 2 = 0) {
      await dispatch(() => void setup.mockMouse.pressDown(x, y, button))
      await dispatch(() => void setup.mockMouse.release(x, y, button))
    },
    /** The agent finished a turn and took the head of the queue. */
    dequeueHead: () => dispatch(() => state.write(state.queue.slice(1))),
  })
}

const THREE = [
  message('a', 'fix the login bug'),
  message('b', 'add parser tests'),
  message('c', 'update the docs'),
]

describe('QueuePanel', () => {
  test('lists the queue in send order with the first row selected', async () => {
    const panel = await mountPanel(THREE)
    const frame = panel.captureCharFrame()

    expect(frame).toContain('Queue — 3 messages')
    expect(frame).toContain('❯ 1. fix the login bug')
    expect(frame).toContain('2. add parser tests')
    expect(frame).toContain('3. update the docs')
    expect(frame).toContain('reorder')
  })

  test('a modified arrow reorders the message the cursor is on', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressArrow('down'))
    await panel.press(() => panel.mockInput.pressArrow('up', { shift: true }))

    expect(panel.contents()).toEqual([
      'add parser tests',
      'fix the login bug',
      'update the docs',
    ])
    // Selection follows the message it moved, not the row it left.
    expect(panel.captureCharFrame()).toContain('❯ 1. add parser tests')
  })

  test('t sends the selected message next', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressArrow('down'))
    await panel.press(() => panel.mockInput.pressArrow('down'))
    await panel.press(() => panel.mockInput.pressKey('t'))

    expect(panel.contents()).toEqual([
      'update the docs',
      'fix the login bug',
      'add parser tests',
    ])
  })

  test('d deletes the selected message and the cursor holds its place', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressArrow('down'))
    await panel.press(() => panel.mockInput.pressKey('d'))

    expect(panel.contents()).toEqual(['fix the login bug', 'update the docs'])
    expect(panel.captureCharFrame()).toContain('❯ 2. update the docs')
  })

  test('e opens the prompt for editing and Enter saves it', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressKey('e'))
    const editing = panel.captureCharFrame()
    expect(editing).toContain('Esc cancel')
    // The editor takes the whole panel; a five-line composer stacked under the
    // full list can outgrow a short terminal.
    expect(editing).toContain('❯ 1. editing')
    expect(editing).not.toContain('add parser tests')

    await panel.press(() => void panel.mockInput.typeText(' now'))
    await panel.press(() => panel.mockInput.pressEnter())

    expect(panel.contents()).toEqual([
      'fix the login bug now',
      'add parser tests',
      'update the docs',
    ])
  })

  test('clicking a message opens that message for editing', async () => {
    const panel = await mountPanel(THREE)

    // The border is row 0, so the second queued message is row 2.
    await panel.click(10, 2)

    const editing = panel.captureCharFrame()
    expect(editing).toContain('❯ 2. editing')
    expect(editing).toContain('add parser tests')
    expect(editing).not.toContain('fix the login bug')
  })

  test('right-clicking a message does not edit it', async () => {
    const panel = await mountPanel(THREE)

    await panel.click(10, 2, 2)

    const frame = panel.captureCharFrame()
    expect(frame).toContain('2. add parser tests')
    expect(frame).not.toContain('2. editing')
  })

  test('the mouse hint stays on one row at the standard width', async () => {
    const panel = await mountPanel(THREE)
    const lines = panel.captureCharFrame().split('\n')
    const footer = lines.findIndex((line) =>
      line.includes('click a row to edit'),
    )

    expect(footer).toBeGreaterThan(-1)
    expect(lines[footer + 1]).toContain('╰')
  })

  test('Esc while editing abandons the change', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressKey('e'))
    await panel.press(() => void panel.mockInput.typeText(' scrapped'))
    await panel.press(() => panel.mockInput.pressEscape())

    expect(panel.contents()).toEqual([
      'fix the login bug',
      'add parser tests',
      'update the docs',
    ])
    expect(panel.closes()).toBe(0)
  })

  test('Esc while browsing closes the panel', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressEscape())

    expect(panel.closes()).toBeGreaterThan(0)
  })

  test('clicking the expanded queue title collapses the panel', async () => {
    const panel = await mountPanel(THREE)

    await panel.click(35, 0)

    expect(panel.closes()).toBeGreaterThan(0)
  })

  test('deleting the last message closes the panel', async () => {
    const panel = await mountPanel([message('a', 'only one')])

    await panel.press(() => panel.mockInput.pressKey('d'))

    expect(panel.contents()).toEqual([])
    expect(panel.closes()).toBeGreaterThan(0)
  })

  test('a message that starts running leaves the list without stranding the cursor', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressArrow('down'))
    expect(panel.captureCharFrame()).toContain('❯ 2. add parser tests')

    await panel.dequeueHead()

    const frame = panel.captureCharFrame()
    expect(frame).toContain('Queue — 2 messages')
    // The selected message survived the drain, so the cursor rides along.
    expect(frame).toContain('❯ 1. add parser tests')

    // ...and it still acts on the right message afterwards.
    await panel.press(() => panel.mockInput.pressKey('d'))
    expect(panel.contents()).toEqual(['update the docs'])
  })

  test('an action on a message that already started says so', async () => {
    const panel = await mountPanel(THREE, { refuseActions: true })

    await panel.press(() => panel.mockInput.pressKey('d'))

    expect(panel.captureCharFrame()).toContain('started running')
    expect(panel.closes()).toBe(0)
  })

  test('emptying a prompt in the editor deletes it', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressKey('e'))
    // Ctrl+U clears the line the composer is editing.
    await panel.press(() => panel.mockInput.pressKey('u', { ctrl: true }))
    await panel.press(() => panel.mockInput.pressEnter())

    expect(panel.contents()).toEqual(['add parser tests', 'update the docs'])
  })

  test('a message queued for its attachments alone survives being opened', async () => {
    // The composer allows an empty prompt when something is attached, so this
    // message starts out with no text — opening it must not read as "emptied".
    const panel = await mountPanel([
      { id: 'a', content: '', attachments: [{} as never] },
      message('b', 'add parser tests'),
    ])

    await panel.press(() => panel.mockInput.pressKey('e'))
    await panel.press(() => panel.mockInput.pressEnter())

    expect(panel.contents()).toEqual(['', 'add parser tests'])
  })

  test('emptying a text-only prompt still deletes it', async () => {
    const panel = await mountPanel(THREE)

    await panel.press(() => panel.mockInput.pressKey('e'))
    await panel.press(() => panel.mockInput.pressKey('u', { ctrl: true }))
    await panel.press(() => panel.mockInput.pressEnter())

    expect(panel.contents()).toEqual(['add parser tests', 'update the docs'])
  })

  test('a long prompt truncates to one row instead of wrapping', async () => {
    const panel = await mountPanel([
      message(
        'a',
        'fix the login bug so expired tokens refresh instead of 401ing the whole session',
      ),
      message('b', 'add parser tests'),
    ])

    const lines = panel.captureCharFrame().split('\n')
    const first = lines.findIndex((line) => line.includes('1. fix the login'))
    expect(first).toBeGreaterThan(-1)
    // The row after the truncated one is the next message, not its overflow.
    expect(lines[first + 1]).toContain('2. add parser tests')
  })

  test('a long queue windows around the selection', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      message(`m${index}`, `task number ${index + 1}`),
    )
    const panel = await mountPanel(many)

    expect(panel.captureCharFrame()).toContain('↓ 4 more')

    for (let press = 0; press < 11; press++) {
      await panel.press(() => panel.mockInput.pressArrow('down'))
    }

    const frame = panel.captureCharFrame()
    expect(frame).toContain('❯ 12. task number 12')
    expect(frame).toContain('↑ 4 more')
  })
})
