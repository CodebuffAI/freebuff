import { describe, expect, test } from 'bun:test'

import { profileSurveyQuestion } from '@codebuff/common/constants/freebuff-profile-survey'

import { shouldInterceptChatInputKey } from '../chat-input-key-intercept'
import {
  createDefaultChatKeyboardState,
  resolveChatKeyboardAction,
  type ChatKeyboardState,
} from '../keyboard-actions'

import type { KeyEvent } from '@opentui/core'

const key = (overrides: Partial<KeyEvent>): KeyEvent =>
  ({
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    ...overrides,
  }) as KeyEvent

const one = key({ name: '1', sequence: '1' })
const letter = key({ name: 'a', sequence: 'a' })
const esc = key({ name: 'escape' })
const left = key({ name: 'left' })
const enter = key({ name: 'return' })
const ctrlC = key({ name: 'c', ctrl: true })

const single = { question: profileSurveyQuestion('who_pays')! }
const multi = { question: profileSurveyQuestion('shopping')! }

const busy: ChatKeyboardState = {
  ...createDefaultChatKeyboardState(),
  isStreaming: true,
}

describe('chat keyboard resolver with the survey on screen', () => {
  test('without the box, Esc interrupts and ← opens history as before', () => {
    expect(resolveChatKeyboardAction(esc, busy)).toEqual({
      type: 'interrupt-stream',
    })
    expect(resolveChatKeyboardAction(left, busy)).toEqual({
      type: 'open-chat-history',
    })
  })

  test('claims digits, ←, Esc while the draft is empty', () => {
    const state = { ...busy, profileSurvey: single }
    expect(resolveChatKeyboardAction(one, state)).toMatchObject({
      type: 'profile-survey',
      input: { type: 'digit', digit: 1 },
    })
    expect(resolveChatKeyboardAction(left, state)).toMatchObject({
      type: 'profile-survey',
      input: { type: 'back' },
    })
    expect(resolveChatKeyboardAction(esc, state)).toEqual({
      type: 'profile-survey',
      input: { type: 'escape' },
    })
  })

  test('Enter is claimed only on a multi-select', () => {
    expect(
      resolveChatKeyboardAction(enter, { ...busy, profileSurvey: multi }),
    ).toMatchObject({ type: 'profile-survey', input: { type: 'enter' } })
    expect(
      resolveChatKeyboardAction(enter, { ...busy, profileSurvey: single }).type,
    ).not.toBe('profile-survey')
  })

  test('claims nothing once the user has typed', () => {
    const state = { ...busy, profileSurvey: single, inputValue: 'fix' }
    expect(resolveChatKeyboardAction(esc, state)).toEqual({
      type: 'interrupt-stream',
    })
    expect(resolveChatKeyboardAction(one, state).type).not.toBe('profile-survey')
  })

  test('Ctrl+C still interrupts the run', () => {
    expect(
      resolveChatKeyboardAction(ctrlC, { ...busy, profileSurvey: single }),
    ).toEqual({ type: 'interrupt-stream' })
  })

  test('outside default mode the survey claims nothing', () => {
    const state = { ...busy, profileSurvey: single, inputMode: 'bash' as const }
    expect(resolveChatKeyboardAction(one, state).type).not.toBe('profile-survey')
  })
})

describe('composer intercept with the survey on screen', () => {
  const empty = {
    hasSlashSuggestions: false,
    hasMentionSuggestions: false,
    lastEditDueToNav: false,
    cursorPosition: 0,
    inputLength: 0,
  }

  test('a claimed digit is not typed into the composer', () => {
    expect(shouldInterceptChatInputKey(one, { ...empty, profileSurvey: single })).toBe(true)
    expect(shouldInterceptChatInputKey(one, empty)).toBe(false)
  })

  test('a letter or an unclaimed digit is typed, which closes the box', () => {
    const state = { ...empty, profileSurvey: single }
    expect(shouldInterceptChatInputKey(letter, state)).toBe(false)
    expect(
      shouldInterceptChatInputKey(key({ name: '8', sequence: '8' }), state),
    ).toBe(false)
  })

  test('Enter on a multi-select is held back from the composer', () => {
    expect(shouldInterceptChatInputKey(enter, { ...empty, profileSurvey: multi })).toBe(true)
    expect(shouldInterceptChatInputKey(enter, { ...empty, profileSurvey: single })).toBe(false)
  })

  test('a non-empty draft owns every key', () => {
    expect(
      shouldInterceptChatInputKey(one, {
        ...empty,
        inputLength: 2,
        cursorPosition: 2,
        profileSurvey: single,
      }),
    ).toBe(false)
  })
})
