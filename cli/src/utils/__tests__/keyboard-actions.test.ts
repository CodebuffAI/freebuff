import { describe, test, expect } from 'bun:test'

import {
  resolveChatKeyboardAction,
  createDefaultChatKeyboardState,
  type ChatKeyboardState,
} from '../keyboard-actions'

import type { KeyEvent } from '@opentui/core'

const createKey = (overrides: Partial<KeyEvent> = {}): KeyEvent =>
  ({
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    ...overrides,
  }) as KeyEvent

const escapeKey = createKey({ name: 'escape' })
const ctrlC = createKey({ name: 'c', ctrl: true })
const upKey = createKey({ name: 'up' })
const downKey = createKey({ name: 'down' })
const tabKey = createKey({ name: 'tab' })
const shiftTabKey = createKey({ name: 'tab', shift: true })
const enterKey = createKey({ name: 'return' })
const keypadEnterKey = createKey({ name: 'kpenter', sequence: '\x1b[57414u' })
const rawApplicationKeypadEnterKey = createKey({ sequence: '\x1bOM' })
const backspaceKey = createKey({ name: 'backspace' })

const defaultState = createDefaultChatKeyboardState()

describe('resolveChatKeyboardAction', () => {
  describe('escape key priority - THE BUG FIX', () => {
    test('escape in bash mode exits mode BEFORE interrupting stream', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'bash',
        isStreaming: true,
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'exit-input-mode',
      })
    })

    test('escape in default mode with streaming interrupts stream', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'default',
        isStreaming: true,
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'interrupt-stream',
      })
    })

    test('escape in usage mode exits mode', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'usage',
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'exit-input-mode',
      })
    })
  })

  describe('feedback mode', () => {
    test('escape in feedback mode exits feedback', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        feedbackMode: true,
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'exit-feedback-mode',
      })
    })

    test('ctrl-c in feedback mode with empty input exits feedback', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        feedbackMode: true,
        inputValue: '',
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'exit-feedback-mode',
      })
    })

    test('ctrl-c in feedback mode with text clears input', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        feedbackMode: true,
        inputValue: 'some feedback',
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'clear-feedback-input',
      })
    })
  })

  describe('escape with input text', () => {
    test('escape with text does NOT clear input (better UX)', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputValue: 'hello world',
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'none',
      })
    })

    test('ctrl-c with text clears input', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputValue: 'hello world',
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'clear-input',
      })
    })
  })

  describe('backspace at position 0', () => {
    test('backspace at position 0 in bash mode exits mode', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'bash',
        cursorPosition: 0,
        inputValue: '',
      }
      expect(resolveChatKeyboardAction(backspaceKey, state)).toEqual({
        type: 'backspace-exit-mode',
      })
    })

    test('backspace at position 0 in default mode does nothing', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'default',
        cursorPosition: 0,
        inputValue: '',
      }
      expect(resolveChatKeyboardAction(backspaceKey, state)).toEqual({
        type: 'none',
      })
    })
  })

  describe('ctrl-c behavior', () => {
    test('ctrl-c while streaming interrupts', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        isStreaming: true,
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'interrupt-stream',
      })
    })

    test('ctrl-c with paused queue clears queue', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        queuePaused: true,
        queuedCount: 5,
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'clear-queue',
      })
    })

    test('ctrl-c when nextCtrlCWillExit exits app', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        nextCtrlCWillExit: true,
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'exit-app',
      })
    })

    test('ctrl-c normally shows exit warning', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'exit-app-warning',
      })
    })
  })

  describe('slash menu navigation', () => {
    const slashMenuState: ChatKeyboardState = {
      ...defaultState,
      slashMenuActive: true,
      slashMatchesLength: 5,
      slashSelectedIndex: 2,
    }

    test('down arrow moves selection down', () => {
      expect(resolveChatKeyboardAction(downKey, slashMenuState)).toEqual({
        type: 'slash-menu-down',
      })
    })

    test('down arrow at bottom does nothing', () => {
      const state = { ...slashMenuState, slashSelectedIndex: 4 }
      expect(resolveChatKeyboardAction(downKey, state)).toEqual({
        type: 'none',
      })
    })

    test('up arrow moves selection up', () => {
      expect(resolveChatKeyboardAction(upKey, slashMenuState)).toEqual({
        type: 'slash-menu-up',
      })
    })

    test('up arrow at top does nothing', () => {
      const state = { ...slashMenuState, slashSelectedIndex: 0 }
      expect(resolveChatKeyboardAction(upKey, state)).toEqual({
        type: 'none',
      })
    })

    test('tab completes without executing (does not navigate)', () => {
      expect(resolveChatKeyboardAction(tabKey, slashMenuState)).toEqual({
        type: 'slash-menu-complete',
      })
    })

    test('tab with single match completes without executing', () => {
      const state = { ...slashMenuState, slashMatchesLength: 1 }
      expect(resolveChatKeyboardAction(tabKey, state)).toEqual({
        type: 'slash-menu-complete',
      })
    })

    test('enter selects', () => {
      expect(resolveChatKeyboardAction(enterKey, slashMenuState)).toEqual({
        type: 'slash-menu-select',
      })
    })

    test('shift-tab completes without executing (does not navigate)', () => {
      expect(resolveChatKeyboardAction(shiftTabKey, slashMenuState)).toEqual({
        type: 'slash-menu-complete',
      })
    })

    test('menu disabled when disableSlashSuggestions is true', () => {
      const state = { ...slashMenuState, disableSlashSuggestions: true }
      expect(resolveChatKeyboardAction(downKey, state)).toEqual({
        type: 'none',
      })
    })
  })

  describe('mention menu navigation', () => {
    const mentionMenuState: ChatKeyboardState = {
      ...defaultState,
      mentionMenuActive: true,
      totalMentionMatches: 5,
      agentSelectedIndex: 2,
    }

    test('down arrow moves selection down', () => {
      expect(resolveChatKeyboardAction(downKey, mentionMenuState)).toEqual({
        type: 'mention-menu-down',
      })
    })

    test('enter selects', () => {
      expect(resolveChatKeyboardAction(enterKey, mentionMenuState)).toEqual({
        type: 'mention-menu-select',
      })
    })
  })

  describe('history navigation', () => {
    test('up arrow navigates history when enabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        historyNavUpEnabled: true,
      }
      expect(resolveChatKeyboardAction(upKey, state)).toEqual({
        type: 'history-up',
      })
    })

    test('down arrow navigates history when enabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        historyNavDownEnabled: true,
      }
      expect(resolveChatKeyboardAction(downKey, state)).toEqual({
        type: 'history-down',
      })
    })

    test('up arrow disabled when not enabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        historyNavUpEnabled: false,
      }
      expect(resolveChatKeyboardAction(upKey, state)).toEqual({
        type: 'none',
      })
    })
  })

  describe('agent mode toggle', () => {
    test('shift-tab toggles agent mode when not in menus', () => {
      expect(resolveChatKeyboardAction(shiftTabKey, defaultState)).toEqual({
        type: 'toggle-agent-mode',
      })
    })

    test('shift-tab in slash menu completes, not agent mode toggle', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 3,
      }
      expect(resolveChatKeyboardAction(shiftTabKey, state)).toEqual({
        type: 'slash-menu-complete',
      })
    })
  })

  describe('unfocus agent', () => {
    test('escape unfocuses agent when focused', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        focusedAgentId: 'agent-123',
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'unfocus-agent',
      })
    })
  })

  describe('tab opens file menu', () => {
    test('tab opens file menu when no menus active', () => {
      expect(resolveChatKeyboardAction(tabKey, defaultState)).toEqual({
        type: 'open-file-menu-with-tab',
      })
    })

    test('tab toggles agent mode when disableSlashSuggestions is true', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        disableSlashSuggestions: true,
      }
      expect(resolveChatKeyboardAction(tabKey, state)).toEqual({
        type: 'toggle-agent-mode',
      })
    })
  })

  describe('history navigation overrides menu navigation', () => {
    test('up arrow in slash menu falls through to history when historyNavUpEnabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 5,
        slashSelectedIndex: 2,
        historyNavUpEnabled: true,
      }
      expect(resolveChatKeyboardAction(upKey, state)).toEqual({
        type: 'history-up',
      })
    })

    test('down arrow in slash menu falls through to history when historyNavDownEnabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 5,
        slashSelectedIndex: 2,
        historyNavDownEnabled: true,
      }
      expect(resolveChatKeyboardAction(downKey, state)).toEqual({
        type: 'history-down',
      })
    })

    test('up arrow in mention menu falls through to history when historyNavUpEnabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        mentionMenuActive: true,
        totalMentionMatches: 5,
        agentSelectedIndex: 2,
        historyNavUpEnabled: true,
      }
      expect(resolveChatKeyboardAction(upKey, state)).toEqual({
        type: 'history-up',
      })
    })

    test('down arrow in mention menu falls through to history when historyNavDownEnabled', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        mentionMenuActive: true,
        totalMentionMatches: 5,
        agentSelectedIndex: 2,
        historyNavDownEnabled: true,
      }
      expect(resolveChatKeyboardAction(downKey, state)).toEqual({
        type: 'history-down',
      })
    })
  })

  describe('isWaitingForResponse', () => {
    test('escape while waiting for response interrupts', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        isWaitingForResponse: true,
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'interrupt-stream',
      })
    })

    test('ctrl-c while waiting for response interrupts', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        isWaitingForResponse: true,
      }
      expect(resolveChatKeyboardAction(ctrlC, state)).toEqual({
        type: 'interrupt-stream',
      })
    })
  })

  describe('mention menu edge cases', () => {
    const mentionMenuState: ChatKeyboardState = {
      ...defaultState,
      mentionMenuActive: true,
      totalMentionMatches: 5,
      agentSelectedIndex: 2,
    }

    test('up arrow moves selection up', () => {
      expect(resolveChatKeyboardAction(upKey, mentionMenuState)).toEqual({
        type: 'mention-menu-up',
      })
    })

    test('up arrow at top does nothing', () => {
      const state = { ...mentionMenuState, agentSelectedIndex: 0 }
      expect(resolveChatKeyboardAction(upKey, state)).toEqual({
        type: 'none',
      })
    })

    test('down arrow at bottom does nothing', () => {
      const state = { ...mentionMenuState, agentSelectedIndex: 4 }
      expect(resolveChatKeyboardAction(downKey, state)).toEqual({
        type: 'none',
      })
    })

    test('tab with multiple matches cycles', () => {
      expect(resolveChatKeyboardAction(tabKey, mentionMenuState)).toEqual({
        type: 'mention-menu-tab',
      })
    })

    test('tab with single match completes without executing', () => {
      const state = { ...mentionMenuState, totalMentionMatches: 1 }
      expect(resolveChatKeyboardAction(tabKey, state)).toEqual({
        type: 'mention-menu-complete',
      })
    })

    test('shift-tab cycles backwards', () => {
      expect(resolveChatKeyboardAction(shiftTabKey, mentionMenuState)).toEqual({
        type: 'mention-menu-shift-tab',
      })
    })
  })

  describe('keys with modifiers are ignored for navigation', () => {
    test('ctrl+up does not navigate', () => {
      const ctrlUp = createKey({ name: 'up', ctrl: true })
      const state: ChatKeyboardState = {
        ...defaultState,
        historyNavUpEnabled: true,
      }
      expect(resolveChatKeyboardAction(ctrlUp, state)).toEqual({
        type: 'none',
      })
    })

    test('meta+down does not navigate', () => {
      const metaDown = createKey({ name: 'down', meta: true })
      const state: ChatKeyboardState = {
        ...defaultState,
        historyNavDownEnabled: true,
      }
      expect(resolveChatKeyboardAction(metaDown, state)).toEqual({
        type: 'none',
      })
    })

    test('option+up does not navigate slash menu', () => {
      const optionUp = createKey({ name: 'up', option: true })
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 5,
        slashSelectedIndex: 2,
      }
      expect(resolveChatKeyboardAction(optionUp, state)).toEqual({
        type: 'none',
      })
    })

    test('ctrl+tab does not open file menu', () => {
      const ctrlTab = createKey({ name: 'tab', ctrl: true })
      expect(resolveChatKeyboardAction(ctrlTab, defaultState)).toEqual({
        type: 'none',
      })
    })
  })

  describe('enter key behavior', () => {
    test('enter without active menu does nothing', () => {
      expect(resolveChatKeyboardAction(enterKey, defaultState)).toEqual({
        type: 'none',
      })
    })

    test('keypad enter without active menu does nothing', () => {
      expect(resolveChatKeyboardAction(keypadEnterKey, defaultState)).toEqual({
        type: 'none',
      })
    })

    test('raw application keypad enter without active menu does nothing', () => {
      expect(
        resolveChatKeyboardAction(rawApplicationKeypadEnterKey, defaultState),
      ).toEqual({
        type: 'none',
      })
    })

    test('keypad enter selects an active slash menu item', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 3,
      }
      expect(resolveChatKeyboardAction(keypadEnterKey, state)).toEqual({
        type: 'slash-menu-select',
      })
    })

    test('raw application keypad enter selects an active slash menu item', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 3,
      }
      expect(
        resolveChatKeyboardAction(rawApplicationKeypadEnterKey, state),
      ).toEqual({
        type: 'slash-menu-select',
      })
    })

    test('shift+enter does nothing even in menu', () => {
      const shiftEnter = createKey({ name: 'return', shift: true })
      const state: ChatKeyboardState = {
        ...defaultState,
        slashMenuActive: true,
        slashMatchesLength: 3,
      }
      expect(resolveChatKeyboardAction(shiftEnter, state)).toEqual({
        type: 'none',
      })
    })
  })

  describe('whitespace-only input', () => {
    test('escape with whitespace-only input does not clear', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputValue: '   ',
      }
      expect(resolveChatKeyboardAction(escapeKey, state)).toEqual({
        type: 'none',
      })
    })
  })

  describe('toggle all (Ctrl+T)', () => {
    const ctrlT = createKey({ name: 't', ctrl: true })

    test('Ctrl+T triggers toggle-all', () => {
      expect(resolveChatKeyboardAction(ctrlT, defaultState)).toEqual({
        type: 'toggle-all',
      })
    })

    test('Ctrl+T works while streaming', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        isStreaming: true,
      }
      expect(resolveChatKeyboardAction(ctrlT, state)).toEqual({
        type: 'toggle-all',
      })
    })

    test('Ctrl+T works with text in input', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputValue: 'some text',
      }
      expect(resolveChatKeyboardAction(ctrlT, state)).toEqual({
        type: 'toggle-all',
      })
    })

    test('Ctrl+T works in bash mode', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'bash',
      }
      expect(resolveChatKeyboardAction(ctrlT, state)).toEqual({
        type: 'toggle-all',
      })
    })

    test('Ctrl+T blocked in feedback mode', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        feedbackMode: true,
      }
      expect(resolveChatKeyboardAction(ctrlT, state)).toEqual({
        type: 'none',
      })
    })

    test('Ctrl+T blocked in outOfCredits mode', () => {
      const state: ChatKeyboardState = {
        ...defaultState,
        inputMode: 'outOfCredits',
      }
      expect(resolveChatKeyboardAction(ctrlT, state)).toEqual({
        type: 'none',
      })
    })
  })
})

describe('empty composer shortcuts', () => {
  test('question mark opens help and left arrow opens chat history', () => {
    expect(resolveChatKeyboardAction(createKey({ name: '?', sequence: '?', shift: true }), defaultState)).toEqual({ type: 'show-help' })
    expect(resolveChatKeyboardAction(createKey({ name: 'left' }), defaultState)).toEqual({ type: 'open-chat-history' })
  })
  test.each(['?', 'left', 'right', 'up', 'down'])('%s stays in a nonempty composer, including at its edges', (name) => {
    for (const inputValue of ['draft', ' ']) {
      expect(resolveChatKeyboardAction(createKey({ name, sequence: name === '?' ? '?' : '' }), {
        ...defaultState, inputValue, cursorPosition: 0, historyNavUpEnabled: true, historyNavDownEnabled: true,
      })).toEqual({ type: 'none' })
    }
  })
  test.each(['a', '!', 'h', '/'])('%s is ordinary input in an empty composer', (name) => {
    expect(resolveChatKeyboardAction(createKey({ name, sequence: name }), defaultState)).toEqual({ type: 'none' })
  })
  test('does not steal keys from another input mode or modified arrows', () => {
    expect(resolveChatKeyboardAction(createKey({ name: '?' }), { ...defaultState, inputMode: 'bash' })).toEqual({ type: 'none' })
    expect(resolveChatKeyboardAction(createKey({ name: 'left', shift: true }), defaultState)).toEqual({ type: 'none' })
  })
})
