import { describe, expect, test } from 'bun:test'

import {
  sanitizeThreadTitle,
  THREAD_TITLE_MAX_CHARS,
} from '../thread-title'

// titles come straight from a model, so this has to cope with every way it ignores the prompt

describe('sanitizeThreadTitle', () => {
  test('strips the label the model prepends despite being told not to', () => {
    expect(sanitizeThreadTitle('Title: Fix The Login Bug')).toBe(
      'Fix The Login Bug',
    )
    expect(sanitizeThreadTitle('TITLE:Fix The Login Bug')).toBe(
      'Fix The Login Bug',
    )
  })

  test('strips wrapping quotes, straight and smart', () => {
    expect(sanitizeThreadTitle('"Fix The Login Bug"')).toBe('Fix The Login Bug')
    expect(sanitizeThreadTitle('“Fix The Login Bug”')).toBe('Fix The Login Bug')
    expect(sanitizeThreadTitle("'Fix The Login Bug'")).toBe('Fix The Login Bug')
  })

  test('keeps quotes that are part of the title', () => {
    expect(sanitizeThreadTitle('Rename The "main" Branch')).toBe(
      'Rename The "main" Branch',
    )
  })

  test('drops trailing sentence punctuation but not internal punctuation', () => {
    expect(sanitizeThreadTitle('Fix the login bug.')).toBe('Fix the login bug')
    expect(sanitizeThreadTitle('Fix login, logout, and reset!!')).toBe(
      'Fix login, logout, and reset',
    )
  })

  test('a quoted sentence loses both the quotes and the period', () => {
    // order matters: quotes come off first, otherwise the period stays hidden behind the quote
    expect(sanitizeThreadTitle('"Fix the login bug."')).toBe('Fix the login bug')
  })

  test('collapses the multi-line preamble case into a single line', () => {
    // the title lands in a one-line tab label; an embedded newline would break the layout
    expect(sanitizeThreadTitle('  Fix   The\nLogin\tBug  ')).toBe(
      'Fix The Login Bug',
    )
  })

  test('never exceeds the width the label is drawn at', () => {
    expect(sanitizeThreadTitle('A '.repeat(200))).toHaveLength(
      THREAD_TITLE_MAX_CHARS,
    )
  })

  test('never cuts an astral character in half', () => {
    // the label is drawn in a tab; half a surrogate pair renders as a
    // replacement glyph instead of the emoji the model wrote
    const title = sanitizeThreadTitle('a'.repeat(59) + '🚀 deploy pipeline')!
    expect(title).toHaveLength(59)
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        title,
      ),
    ).toBe(false)
  })

  test('returns null when nothing usable is left', () => {
    // null keeps the placeholder the caller already showed instead of blanking the label
    for (const raw of ['', '   ', '"..."', 'Title:', '!!!', '“”']) {
      expect(sanitizeThreadTitle(raw)).toBeNull()
    }
  })

  test('a non-latin title survives intact', () => {
    // the agent is told to answer in the user's language; stripping it would be worse than no title
    expect(sanitizeThreadTitle('«Исправить вход в систему».')).toBe(
      '«Исправить вход в систему»',
    )
  })
})
