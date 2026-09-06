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

const browsing = { confirmingDelete: false }
const confirming = { confirmingDelete: true }

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

  test('unbound keys do nothing', () => {
    expect(resolveSkillsPanelAction(createKey({ name: 'x' }), browsing)).toEqual(
      { type: 'none' },
    )
    expect(
      resolveSkillsPanelAction(createKey({ name: 'tab' }), browsing),
    ).toEqual({ type: 'none' })
  })
})
