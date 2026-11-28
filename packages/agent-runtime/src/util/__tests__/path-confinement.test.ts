import { expect, test } from 'bun:test'

import { isPathConfined } from '../path-confinement'

test('confined relative paths', () => {
  expect(isPathConfined('a.ts')).toBe(true)
  expect(isPathConfined('src/index.ts')).toBe(true)
  expect(isPathConfined('a/b/c.ts')).toBe(true)
})

test('rejects traversal', () => {
  expect(isPathConfined('../secret.txt')).toBe(false)
  expect(isPathConfined('src/../..//etc/passwd')).toBe(false)
  expect(isPathConfined('a/../../b')).toBe(false)
})

test('rejects absolute and drive paths', () => {
  expect(isPathConfined('/etc/passwd')).toBe(false)
  expect(isPathConfined('C:\\Windows\\system32')).toBe(false)
  expect(isPathConfined('\\Windows')).toBe(false)
})

test('rejects null bytes and empty', () => {
  expect(isPathConfined('a\u0000b')).toBe(false)
  expect(isPathConfined('')).toBe(false)
  expect(isPathConfined(123 as any)).toBe(false)
})
