import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { ChatInputBar } from '../chat-input-bar'
import { useChatKeyboard } from '../../hooks/use-chat-keyboard'
import { initializeThemeStore, useTheme } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { createDefaultChatKeyboardState } from '../../utils/keyboard-actions'

import type { SuggestionItem } from '../suggestion-menu'
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

const COMMANDS: SuggestionItem[] = Array.from({ length: 8 }, (_, i) => ({
  id: `cmd${i + 1}`,
  label: `cmd${i + 1}`,
  description: `command number ${i + 1}`,
}))

const noopHandlers = (): ChatKeyboardHandlers =>
  new Proxy({} as ChatKeyboardHandlers, {
    get: () => () => {},
  })

/**
 * The chain chat.tsx wires up for the slash menu: the real composer
 * (MultilineInput + its key intercept) and the global chat keyboard hook, both
 * reading the draft from the chat store, with the menu open whenever the draft
 * starts with "/". Both listeners see every key, so a regression in either
 * one's arrow handling shows up here.
 */
const mountComposerWithSlashMenu = async () => {
  const selected = { index: 0 }

  const Harness = () => {
    const theme = useTheme()
    const inputRef = React.useRef(null)
    const inputValue = useChatStore((s) => s.inputValue)
    const cursorPosition = useChatStore((s) => s.cursorPosition)
    const lastEditDueToNav = useChatStore((s) => s.lastEditDueToNav)
    const setInputValue = useChatStore((s) => s.setInputValue)
    const slashSelectedIndex = useChatStore((s) => s.slashSelectedIndex)
    const setSlashSelectedIndex = useChatStore((s) => s.setSlashSelectedIndex)
    const menuOpen = inputValue.startsWith('/')
    selected.index = slashSelectedIndex

    useChatKeyboard({
      state: {
        ...createDefaultChatKeyboardState(),
        inputValue,
        cursorPosition,
        slashMenuActive: menuOpen,
        slashMatchesLength: menuOpen ? COMMANDS.length : 0,
        slashSelectedIndex,
      },
      handlers: {
        ...noopHandlers(),
        onSlashMenuDown: () => setSlashSelectedIndex((prev) => prev + 1),
        onSlashMenuUp: () => setSlashSelectedIndex((prev) => prev - 1),
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
        hasSlashSuggestions={menuOpen}
        hasMentionSuggestions={false}
        hasSuggestionMenu={menuOpen}
        slashSuggestionItems={menuOpen ? COMMANDS : []}
        agentSuggestionItems={[]}
        fileSuggestionItems={[]}
        slashSelectedIndex={slashSelectedIndex}
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
    selectedIndex: () => selected.index,
    async press(act: () => void | Promise<void>) {
      await act()
      await settle()
    },
  })
}

describe('slash menu arrow keys', () => {
  test('Down/Up after typing "/" move the highlight and scroll the menu', async () => {
    const ui = await mountComposerWithSlashMenu()

    await ui.press(() => ui.mockInput.pressKey('/'))
    expect(useChatStore.getState().inputValue).toBe('/')
    let frame = ui.captureCharFrame()
    expect(frame).toContain('/cmd1')
    // Compact mode shows five rows, so the tail of the list starts hidden.
    expect(frame).not.toContain('/cmd8')

    for (let i = 0; i < 7; i++) {
      await ui.press(() => ui.mockInput.pressArrow('down'))
    }
    expect(ui.selectedIndex()).toBe(7)
    frame = ui.captureCharFrame()
    expect(frame).toContain('/cmd8')
    expect(frame).not.toContain('/cmd1 ')

    await ui.press(() => ui.mockInput.pressArrow('up'))
    await ui.press(() => ui.mockInput.pressArrow('up'))
    expect(ui.selectedIndex()).toBe(5)

    // The arrows drove the menu, not the draft.
    expect(useChatStore.getState().inputValue).toBe('/')
    expect(useChatStore.getState().cursorPosition).toBe(1)
  })
})
