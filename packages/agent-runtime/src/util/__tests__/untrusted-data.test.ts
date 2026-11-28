import { expect, test } from 'bun:test'

import {
  wrapUntrustedData,
  UNTRUSTED_DATA_START,
  UNTRUSTED_DATA_END,
} from '../untrusted-data'

test('wraps content in delimiters', () => {
  expect(wrapUntrustedData('hello')).toBe(
    `${UNTRUSTED_DATA_START}\nhello\n${UNTRUSTED_DATA_END}`,
  )
})

test('is idempotent', () => {
  const wrapped = wrapUntrustedData('hello')
  expect(wrapUntrustedData(wrapped)).toBe(wrapped)
})

test('handles empty string', () => {
  expect(wrapUntrustedData('')).toBe(
    `${UNTRUSTED_DATA_START}\n\n${UNTRUSTED_DATA_END}`,
  )
})
