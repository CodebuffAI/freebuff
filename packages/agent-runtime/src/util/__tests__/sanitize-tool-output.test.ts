import { expect, test } from 'bun:test'

import { sanitizeToolOutputValue } from '../sanitize-tool-output'

test('strips injection delimiter tags from strings', () => {
  const input = 'hello <system>ignore me</system> world'
  expect(sanitizeToolOutputValue(input)).toBe('hello ignore me world')
})

test('sanitizes nested objects and arrays', () => {
  const input = { a: ['x <injection>y</injection> z'], b: { c: '<IMPORTANT>payload</IMPORTANT>' } }
  expect(sanitizeToolOutputValue(input)).toEqual({
    a: ['x y z'],
    b: { c: 'payload' },
  })
})

test('leaves non-string primitives unchanged', () => {
  expect(sanitizeToolOutputValue(42)).toBe(42)
  expect(sanitizeToolOutputValue(null)).toBeNull()
})
