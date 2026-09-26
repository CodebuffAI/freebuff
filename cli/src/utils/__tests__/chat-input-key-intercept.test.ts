import { describe, expect, test } from 'bun:test'

import { shouldInterceptChatInputKey } from '../chat-input-key-intercept'

const baseState = {
  hasSlashSuggestions: false,
  hasMentionSuggestions: false,
  lastEditDueToNav: false,
  cursorPosition: 1,
  inputLength: 3,
}

describe('shouldInterceptChatInputKey', () => {
  test('intercepts keypad Enter while slash suggestions are visible', () => {
    expect(
      shouldInterceptChatInputKey(
        { name: 'kpenter', sequence: '\x1b[57414u' },
        { ...baseState, hasSlashSuggestions: true },
      ),
    ).toBe(true)
  })

  test('intercepts raw application keypad Enter while mention suggestions are visible', () => {
    expect(
      shouldInterceptChatInputKey(
        { sequence: '\x1bOM' },
        { ...baseState, hasMentionSuggestions: true },
      ),
    ).toBe(true)
  })

  test('does not intercept keypad Enter without visible suggestions', () => {
    expect(
      shouldInterceptChatInputKey(
        { name: 'kpenter', sequence: '\x1b[57414u' },
        baseState,
      ),
    ).toBe(false)
  })
})

test('reserves empty composer shortcuts but leaves text editing alone', () => {
  for (const key of [{ name: '?', sequence: '?' }, { name: 'left' }]) {
    expect(shouldInterceptChatInputKey(key, { ...baseState, inputLength: 0 })).toBe(true)
    expect(shouldInterceptChatInputKey(key, baseState)).toBe(false)
    expect(shouldInterceptChatInputKey(key, { ...baseState, inputLength: 0, inputMode: 'bash' })).toBe(false)
  }
  for (const name of ['up', 'down']) {
    expect(shouldInterceptChatInputKey({ name }, { ...baseState, cursorPosition: 0, lastEditDueToNav: true })).toBe(false)
  }
})
