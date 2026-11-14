import { describe, expect, test } from 'bun:test'

import { MAX_PROJECT_NAME_LENGTH, normalizeProjectName } from '../project-name'

describe('normalizeProjectName', () => {
  test('keeps an ordinary name, collapsing whitespace', () => {
    expect(normalizeProjectName('  My   app\n')).toBe('My app')
  })

  test('cuts a long name to the cap without splitting a character', () => {
    const long = `${'a'.repeat(MAX_PROJECT_NAME_LENGTH - 1)}😀😀😀`
    const out = normalizeProjectName(long)
    expect(Array.from(out)).toHaveLength(MAX_PROJECT_NAME_LENGTH)
    expect(out.endsWith('😀')).toBe(true)
    expect(normalizeProjectName('x'.repeat(10_000))).toHaveLength(MAX_PROJECT_NAME_LENGTH)
  })
})
