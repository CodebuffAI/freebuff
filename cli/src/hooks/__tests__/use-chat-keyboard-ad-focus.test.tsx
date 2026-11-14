import { afterEach, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import {
  getAdTerminalFocus,
  noteAdTerminalFocus,
  resetAdSignalsForTests,
} from '../../ads/ad-signals'
import { useChatStore } from '../../state/chat-store'
import {
  reportActivity,
  resetActivityTracker,
  subscribeToActivity,
} from '../../utils/activity-tracker'
import { createDefaultChatKeyboardState } from '../../utils/keyboard-actions'
import { useChatKeyboard } from '../use-chat-keyboard'

import type { ChatKeyboardHandlers } from '../use-chat-keyboard'

let cleanupRenderer: (() => void) | undefined

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
  useChatStore.getState().reset()
  resetAdSignalsForTests()
  resetActivityTracker()
})

const noopHandlers = (): ChatKeyboardHandlers =>
  new Proxy({} as ChatKeyboardHandlers, {
    get: () => () => {},
  })

let mouseMoves = 0

/**
 * The wiring chat.tsx has: the global chat keyboard hook, mouse movement on the
 * root box reported as activity, and every input change reported as activity.
 */
const mount = async () => {
  mouseMoves = 0
  const Harness = () => {
    const inputValue = useChatStore((s) => s.inputValue)
    React.useEffect(() => {
      reportActivity()
    }, [inputValue])
    useChatKeyboard({
      state: { ...createDefaultChatKeyboardState(), inputValue },
      handlers: noopHandlers(),
    })
    return (
      <box
        style={{ width: '100%', height: '100%' }}
        onMouseMove={() => {
          mouseMoves++
          reportActivity()
        }}
      />
    )
  }

  const setup = await createTestRenderer({ width: 40, height: 10 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => root.render(<Harness />))
  const settle = async () => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await setup.renderOnce()
  }
  await settle()
  return Object.assign(setup, {
    async act(fn: () => void | Promise<void>) {
      await fn()
      await settle()
    },
  })
}

describe('terminal focus after a focus-out report', () => {
  test('mouse movement, input changes and focus reports keep it unfocused; a key restores it', async () => {
    const ui = await mount()
    let activity = 0
    subscribeToActivity(() => activity++)
    noteAdTerminalFocus(false)

    await ui.act(() => ui.mockMouse.moveTo(5, 5))
    await ui.act(() => ui.mockMouse.moveTo(10, 6))
    await ui.act(() =>
      useChatStore.getState().setInputValue({
        text: 'set by the program',
        cursorPosition: 0,
        lastEditDueToNav: false,
      }),
    )
    // Focus reports are consumed by the renderer and never reach the key
    // handler as key events.
    await ui.act(() => ui.mockInput.pressKeys(['\x1b[I', '\x1b[O']))

    // The pointer did cross the CLI, and activity was reported, so the
    // tracker's other users still see it.
    expect(mouseMoves).toBeGreaterThan(0)
    expect(activity).toBeGreaterThan(0)
    expect(getAdTerminalFocus()).toBe(false)

    await ui.act(() => ui.mockInput.pressKey('a'))
    expect(getAdTerminalFocus()).toBe(true)
  })
})
