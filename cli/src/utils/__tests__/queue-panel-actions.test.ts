import { describe, test, expect } from 'bun:test'

import {
  resolveChatKeyboardAction,
  createDefaultChatKeyboardState,
} from '../keyboard-actions'
import { resolveQueuePanelAction } from '../queue-panel-actions'

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

const browsing = { editing: false }
const editing = { editing: true }

describe('resolveQueuePanelAction', () => {
  test('arrows move the selection, modified arrows move the message', () => {
    expect(resolveQueuePanelAction(createKey({ name: 'up' }), browsing)).toEqual({
      type: 'select',
      delta: -1,
    })
    expect(
      resolveQueuePanelAction(createKey({ name: 'down' }), browsing),
    ).toEqual({ type: 'select', delta: 1 })
    expect(
      resolveQueuePanelAction(createKey({ name: 'up', shift: true }), browsing),
    ).toEqual({ type: 'move', delta: -1 })
    expect(
      resolveQueuePanelAction(
        createKey({ name: 'down', ctrl: true }),
        browsing,
      ),
    ).toEqual({ type: 'move', delta: 1 })
  })

  test('shift+J/K reorder for terminals that swallow modified arrows', () => {
    expect(
      resolveQueuePanelAction(
        createKey({ name: 'k', shift: true, sequence: 'K' }),
        browsing,
      ),
    ).toEqual({ type: 'move', delta: -1 })
    expect(
      resolveQueuePanelAction(
        createKey({ name: 'j', shift: true, sequence: 'J' }),
        browsing,
      ),
    ).toEqual({ type: 'move', delta: 1 })
    // Their unshifted twins still only move the cursor.
    expect(
      resolveQueuePanelAction(createKey({ name: 'k', sequence: 'k' }), browsing),
    ).toEqual({ type: 'select', delta: -1 })
  })

  test('edit, delete, promote, and close', () => {
    expect(resolveQueuePanelAction(createKey({ name: 'e' }), browsing)).toEqual({
      type: 'edit',
    })
    expect(
      resolveQueuePanelAction(createKey({ name: 'return' }), browsing),
    ).toEqual({ type: 'edit' })
    expect(resolveQueuePanelAction(createKey({ name: 'd' }), browsing)).toEqual({
      type: 'delete',
    })
    expect(
      resolveQueuePanelAction(createKey({ name: 'backspace' }), browsing),
    ).toEqual({ type: 'delete' })
    expect(resolveQueuePanelAction(createKey({ name: 't' }), browsing)).toEqual({
      type: 'move-to-top',
    })
    expect(
      resolveQueuePanelAction(createKey({ name: 'escape' }), browsing),
    ).toEqual({ type: 'close' })
    expect(
      resolveQueuePanelAction(createKey({ name: 'c', ctrl: true }), browsing),
    ).toEqual({ type: 'close' })
  })

  test('while editing, only the exits are the panel’s — the rest is typing', () => {
    expect(resolveQueuePanelAction(createKey({ name: 'escape' }), editing)).toEqual(
      { type: 'cancel-edit' },
    )
    expect(
      resolveQueuePanelAction(createKey({ name: 'c', ctrl: true }), editing),
    ).toEqual({ type: 'cancel-edit' })

    // Every shortcut letter has to reach the text input instead.
    for (const name of ['d', 'e', 'q', 't', 'j', 'k']) {
      expect(resolveQueuePanelAction(createKey({ name }), editing)).toEqual({
        type: 'none',
      })
    }
    expect(
      resolveQueuePanelAction(createKey({ name: 'backspace' }), editing),
    ).toEqual({ type: 'none' })
    expect(resolveQueuePanelAction(createKey({ name: 'up' }), editing)).toEqual({
      type: 'none',
    })
  })
})

describe('ctrl+z is absorbed by the composer', () => {
  test('does not exit or change state', () => {
    expect(
      resolveChatKeyboardAction(
        createKey({ name: 'z', ctrl: true }),
        createDefaultChatKeyboardState(),
      ),
    ).toEqual({ type: 'none' })
  })
})

describe('ctrl+q opens the queue editor', () => {
  const ctrlQ = createKey({ name: 'q', ctrl: true })

  test('opens when something is queued', () => {
    expect(
      resolveChatKeyboardAction(ctrlQ, {
        ...createDefaultChatKeyboardState(),
        queuedCount: 2,
      }),
    ).toEqual({ type: 'open-queue-panel' })
  })

  test('does nothing on an empty queue', () => {
    expect(
      resolveChatKeyboardAction(ctrlQ, createDefaultChatKeyboardState()),
    ).toEqual({ type: 'none' })
  })

  test('still opens with a half-typed message in the composer', () => {
    expect(
      resolveChatKeyboardAction(ctrlQ, {
        ...createDefaultChatKeyboardState(),
        inputValue: 'and another thing',
        cursorPosition: 17,
        queuedCount: 1,
      }),
    ).toEqual({ type: 'open-queue-panel' })
  })

  test('a bare q is not a shortcut', () => {
    expect(
      resolveChatKeyboardAction(createKey({ name: 'q', sequence: 'q' }), {
        ...createDefaultChatKeyboardState(),
        queuedCount: 2,
      }),
    ).toEqual({ type: 'none' })
  })
})
