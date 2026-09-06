import { describe, test, expect } from 'bun:test'

import { resolveSkillsPanelAction } from '../skills-panel-actions'

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

const browsing = { confirmingDelete: false, searching: false }
const confirming = { confirmingDelete: true, searching: false }
const searching = { confirmingDelete: false, searching: true }

describe('resolveSkillsPanelAction', () => {
  test('arrows and j/k move the selection', () => {
    expect(
      resolveSkillsPanelAction(createKey({ name: 'up' }), browsing),
    ).toEqual({ type: 'select', delta: -1 })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'down' }), browsing),
    ).toEqual({ type: 'select', delta: 1 })
    expect(resolveSkillsPanelAction(createKey({ name: 'k' }), browsing)).toEqual(
      { type: 'select', delta: -1 },
    )
    expect(resolveSkillsPanelAction(createKey({ name: 'j' }), browsing)).toEqual(
      { type: 'select', delta: 1 },
    )
  })

  test('enter invokes, o opens, d deletes', () => {
    expect(
      resolveSkillsPanelAction(createKey({ name: 'return' }), browsing),
    ).toEqual({ type: 'invoke' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'enter' }), browsing),
    ).toEqual({ type: 'invoke' })
    expect(resolveSkillsPanelAction(createKey({ name: 'o' }), browsing)).toEqual(
      { type: 'open' },
    )
    expect(resolveSkillsPanelAction(createKey({ name: 'd' }), browsing)).toEqual(
      { type: 'delete' },
    )
    expect(
      resolveSkillsPanelAction(createKey({ name: 'delete' }), browsing),
    ).toEqual({ type: 'delete' })
  })

  test('escape, ctrl+c, and q close while browsing', () => {
    expect(
      resolveSkillsPanelAction(createKey({ name: 'escape' }), browsing),
    ).toEqual({ type: 'close' })
    expect(
      resolveSkillsPanelAction(
        createKey({ name: 'c', ctrl: true }),
        browsing,
      ),
    ).toEqual({ type: 'close' })
    expect(resolveSkillsPanelAction(createKey({ name: 'q' }), browsing)).toEqual(
      { type: 'close' },
    )
  })

  test('a pending delete swallows stray keys so held keys cannot chain-delete', () => {
    // The next row's `d`, a printable key, even enter-adjacent modifiers:
    // nothing but confirm/cancel may act while the prompt is up.
    expect(
      resolveSkillsPanelAction(createKey({ name: 'd' }), confirming),
    ).toEqual({ type: 'none' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'j' }), confirming),
    ).toEqual({ type: 'none' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'o' }), confirming),
    ).toEqual({ type: 'none' })
  })

  test('a pending delete confirms on enter and cancels on escape/n/q', () => {
    expect(
      resolveSkillsPanelAction(createKey({ name: 'return' }), confirming),
    ).toEqual({ type: 'confirm' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'enter' }), confirming),
    ).toEqual({ type: 'confirm' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'escape' }), confirming),
    ).toEqual({ type: 'cancel' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'n' }), confirming),
    ).toEqual({ type: 'cancel' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'q' }), confirming),
    ).toEqual({ type: 'cancel' })
  })

  test('/ enters search mode', () => {
    expect(
      resolveSkillsPanelAction(createKey({ name: '/', sequence: '/' }), browsing),
    ).toEqual({ type: 'search-start' })
    // Only a bare `/` — ctrl/meta variants stay unbound so a chord can never
    // drop the user into a typing mode they did not ask for.
    expect(
      resolveSkillsPanelAction(createKey({ name: '/', sequence: '/', ctrl: true }), browsing),
    ).toEqual({ type: 'none' })
  })

  test('search mode: printable keys become query edits, not shortcuts', () => {
    // `d` and `o` would delete/open while browsing; while searching they are
    // just letters in the query.
    expect(
      resolveSkillsPanelAction(createKey({ name: 'd', sequence: 'd' }), searching),
    ).toEqual({ type: 'search-input', char: 'd' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'o', sequence: 'o' }), searching),
    ).toEqual({ type: 'search-input', char: 'o' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'q', sequence: 'q' }), searching),
    ).toEqual({ type: 'search-input', char: 'q' })
    expect(
      resolveSkillsPanelAction(
        createKey({ name: 'space', sequence: ' ' }),
        searching,
      ),
    ).toEqual({ type: 'search-input', char: ' ' })
  })

  test('search mode: backspace deletes, escape exits, ctrl+c still closes', () => {
    expect(
      resolveSkillsPanelAction(createKey({ name: 'backspace' }), searching),
    ).toEqual({ type: 'search-backspace' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'escape' }), searching),
    ).toEqual({ type: 'search-exit' })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'c', ctrl: true }), searching),
    ).toEqual({ type: 'close' })
  })

  test('search mode: navigation and invoke still work', () => {
    // Named keys (arrows, enter) still navigate/invoke while typing.
    expect(
      resolveSkillsPanelAction(createKey({ name: 'up' }), searching),
    ).toEqual({ type: 'select', delta: -1 })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'down' }), searching),
    ).toEqual({ type: 'select', delta: 1 })
    expect(
      resolveSkillsPanelAction(createKey({ name: 'return' }), searching),
    ).toEqual({ type: 'invoke' })
    // But the letter forms of those shortcuts are query edits here — `j`
    // types a j, it does not move the cursor.
    expect(
      resolveSkillsPanelAction(createKey({ name: 'j', sequence: 'j' }), searching),
    ).toEqual({ type: 'search-input', char: 'j' })
  })

  test('search mode: delete confirmation still outranks typing', () => {
    // A stray `d` while a delete is pending must never edit a query — the
    // confirm prompt only answers to enter/confirm or cancel.
    expect(
      resolveSkillsPanelAction(
        createKey({ name: 'd', sequence: 'd' }),
        { confirmingDelete: true, searching: true },
      ),
    ).toEqual({ type: 'none' })
    expect(
      resolveSkillsPanelAction(
        createKey({ name: 'return' }),
        { confirmingDelete: true, searching: true },
      ),
    ).toEqual({ type: 'confirm' })
  })

  test('unbound keys do nothing', () => {
    expect(resolveSkillsPanelAction(createKey({ name: 'x' }), browsing)).toEqual(
      { type: 'none' },
    )
    expect(
      resolveSkillsPanelAction(createKey({ name: 'tab' }), browsing),
    ).toEqual({ type: 'none' })
  })
})
