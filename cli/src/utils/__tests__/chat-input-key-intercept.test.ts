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
    expect(shouldInterceptChatInputKey({ name }, { ...baseState, cursorPosition: 0 })).toBe(false)
  }
})

// Regression (#4170 → 2026-09-30 report): Up recalled the newest prompt and
// then stopped, because the recalled text made the draft non-empty.
test('Up/Down keep paging history from an unedited recalled entry', () => {
  for (const name of ['up', 'down']) {
    expect(shouldInterceptChatInputKey({ name }, { ...baseState, lastEditDueToNav: true })).toBe(true)
  }
  for (const name of ['left', 'right']) {
    expect(shouldInterceptChatInputKey({ name }, { ...baseState, lastEditDueToNav: true })).toBe(false)
  }
})

test('an open menu owns Up/Down in the draft that opened it', () => {
  for (const name of ['up', 'down']) {
    for (const menu of [
      { hasSlashSuggestions: true },
      { hasMentionSuggestions: true },
    ]) {
      expect(
        shouldInterceptChatInputKey(
          { name },
          { ...baseState, ...menu, inputLength: 1, cursorPosition: 1 },
        ),
      ).toBe(true)
    }
  }
  for (const name of ['left', 'right']) {
    expect(
      shouldInterceptChatInputKey(
        { name },
        { ...baseState, hasSlashSuggestions: true },
      ),
    ).toBe(false)
  }
})
