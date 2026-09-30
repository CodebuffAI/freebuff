import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { ChatInputBar } from '../chat-input-bar'
import { useChatKeyboard } from '../../hooks/use-chat-keyboard'
import { initializeThemeStore, useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { createDefaultChatKeyboardState } from '../../utils/keyboard-actions'

import type { ChatKeyboardHandlers } from '../../hooks/use-chat-keyboard'

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
  useChatStore.getState().reset()
})

const HISTORY = ['oldest prompt', 'middle prompt', 'newest prompt']

const noopHandlers = (): ChatKeyboardHandlers =>
  new Proxy({} as ChatKeyboardHandlers, {
    get: () => () => {},
  })

/**
 * The chain chat.tsx wires up for prompt history: the real composer
 * (MultilineInput + its key intercept) and the global chat keyboard hook, both
 * reading the draft from the chat store. History itself is a stand-in with the
 * same contract as `useInputHistory`: a recalled entry is written with
 * `lastEditDueToNav: true`, and Down past the newest entry restores the draft.
 */
const mountComposerWithHistory = async () => {
  const Harness = () => {
    const theme = useTheme()
    const inputRef = React.useRef(null)
    const inputValue = useChatStore((s) => s.inputValue)
    const cursorPosition = useChatStore((s) => s.cursorPosition)
    const lastEditDueToNav = useChatStore((s) => s.lastEditDueToNav)
    const setInputValue = useChatStore((s) => s.setInputValue)
    const index = React.useRef(-1)

    const show = (text: string) =>
      setInputValue({ text, cursorPosition: text.length, lastEditDueToNav: true })

    useChatKeyboard({
      state: {
        ...createDefaultChatKeyboardState(),
        inputValue,
        cursorPosition,
        // As computed in chat.tsx with no menu open.
        historyNavUpEnabled: lastEditDueToNav || cursorPosition === 0,
        historyNavDownEnabled:
          lastEditDueToNav || cursorPosition === inputValue.length,
      },
      handlers: {
        ...noopHandlers(),
        onHistoryUp: () => {
          index.current =
            index.current === -1 ? HISTORY.length - 1 : Math.max(0, index.current - 1)
          show(HISTORY[index.current]!)
        },
        onHistoryDown: () => {
          if (index.current === -1) return
          if (index.current < HISTORY.length - 1) {
            index.current += 1
            show(HISTORY[index.current]!)
          } else {
            index.current = -1
            show('')
          }
        },
      },
    })

    return (
      <ChatInputBar
        inputValue={inputValue}
        cursorPosition={cursorPosition}
        setInputValue={setInputValue}
        inputFocused
        inputRef={inputRef}
        inputPlaceholder="Enter a coding task or / for commands"
        lastEditDueToNav={lastEditDueToNav}
        agentMode="DEFAULT"
        toggleAgentMode={() => {}}
        setAgentMode={() => {}}
        hasSlashSuggestions={false}
        hasMentionSuggestions={false}
        hasSuggestionMenu={false}
        slashSuggestionItems={[]}
        agentSuggestionItems={[]}
        fileSuggestionItems={[]}
        slashSelectedIndex={0}
        agentSelectedIndex={0}
        theme={theme}
        terminalHeight={16}
        separatorWidth={70}
        shouldCenterInputVertically={false}
        inputBoxTitle={undefined}
        isCompactHeight
        isNarrowWidth={false}
        feedbackMode={false}
        handleExitFeedback={() => {}}
        publishMode={false}
        handleExitPublish={() => {}}
        handlePublish={async () => {}}
        handleSubmit={async () => {}}
        onPaste={() => {}}
        onInterruptStream={() => {}}
      />
    )
  }

  const setup = await createTestRenderer({
    width: 70,
    height: 16,
    kittyKeyboard: true,
  })
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
    async press(act: () => void | Promise<void>) {
      await act()
      await settle()
    },
  })
}

const draft = () => useChatStore.getState().inputValue

describe('prompt history arrow keys', () => {
  test('repeated Up walks back through history, Down walks forward to the empty draft', async () => {
    const ui = await mountComposerWithHistory()

    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('newest prompt')
    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('middle prompt')
    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('oldest prompt')
    // At the oldest entry Up stays put.
    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('oldest prompt')

    await ui.press(() => ui.mockInput.pressArrow('down'))
    expect(draft()).toBe('middle prompt')
    await ui.press(() => ui.mockInput.pressArrow('down'))
    expect(draft()).toBe('newest prompt')
    await ui.press(() => ui.mockInput.pressArrow('down'))
    expect(draft()).toBe('')
  })

  test('once a recalled prompt is edited, arrows move the cursor instead', async () => {
    const ui = await mountComposerWithHistory()

    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('newest prompt')
    await ui.press(() => ui.mockInput.pressKey('!'))
    expect(draft()).toBe('newest prompt!')

    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('newest prompt!')
    expect(useChatStore.getState().cursorPosition).toBe(0)
  })

  test('a typed draft keeps Up for the cursor (#4170)', async () => {
    const ui = await mountComposerWithHistory()

    await ui.press(() => ui.mockInput.pressKey('h'))
    await ui.press(() => ui.mockInput.pressKey('i'))
    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('hi')
    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(draft()).toBe('hi')
  })
})
