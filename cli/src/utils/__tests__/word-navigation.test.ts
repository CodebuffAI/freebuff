import { describe, expect, test } from 'bun:test'

import { getWordNavigationPosition } from '../word-navigation'

describe('word navigation', () => {
  const text = 'one two three'

  test('moves to the previous word with Ctrl+Left', () => {
    expect(
      getWordNavigationPosition(
        { name: 'left', ctrl: true },
        text,
        text.length,
        false,
      ),
    ).toBe(8)
  })

  test('moves to the next word with Ctrl+Right', () => {
    expect(
      getWordNavigationPosition({ name: 'right', ctrl: true }, text, 0, false),
    ).toBe(4)
  })

  test('keeps Alt word navigation working', () => {
    expect(
      getWordNavigationPosition(
        { name: 'left', option: true },
        text,
        text.length,
        true,
      ),
    ).toBe(8)
    expect(
      getWordNavigationPosition({ name: 'f', option: true }, text, 0, true),
    ).toBe(4)
  })

  test('does not reclassify mixed Ctrl+Alt arrow chords as plain Ctrl navigation', () => {
    expect(
      getWordNavigationPosition(
        { name: 'left', ctrl: true, option: true },
        text,
        text.length,
        false,
      ),
    ).toBeNull()
    expect(
      getWordNavigationPosition(
        { name: 'right', ctrl: true, option: true },
        text,
        0,
        false,
      ),
    ).toBeNull()
  })

  test('routes mixed Ctrl+Alt chords only through the caller-detected Alt path', () => {
    expect(
      getWordNavigationPosition(
        { name: 'left', ctrl: true, option: true },
        text,
        text.length,
        true,
      ),
    ).toBe(8)
  })

  test('does not treat modified arrows as word navigation', () => {
    expect(
      getWordNavigationPosition(
        { name: 'left', ctrl: true, meta: true },
        text,
        text.length,
        false,
      ),
    ).toBeNull()
    expect(
      getWordNavigationPosition({ name: 'right' }, text, 0, false),
    ).toBeNull()
  })

  test('leaves Ctrl+B and Ctrl+F for single-character Emacs movement', () => {
    expect(
      getWordNavigationPosition(
        { name: 'b', ctrl: true },
        text,
        text.length,
        false,
      ),
    ).toBeNull()
    expect(
      getWordNavigationPosition({ name: 'f', ctrl: true }, text, 0, false),
    ).toBeNull()
  })
})
