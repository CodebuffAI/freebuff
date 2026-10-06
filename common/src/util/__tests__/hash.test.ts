import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { sha256Hex, sha256HexAsync } from '../hash'

const native = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/** A string from raw UTF-16 code units, so lone surrogates survive the source file. */
const units = (...codes: number[]) => String.fromCharCode(...codes)

// Lengths on each side of the padding boundaries (55 bytes is the most that
// fits the length in one block, 56 spills into a second), then multi-block.
const LENGTHS = [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 100_000]

const UNICODE: Array<[string, string]> = [
  ['two-byte UTF-8', `caf${units(0xe9)}`],
  ['three-byte UTF-8', `${units(0x20ac)} and ${units(0x4e2d, 0x6587)}`],
  ['a surrogate pair', `grin ${units(0xd83d, 0xde00)}`],
  ['a lone high surrogate', `x${units(0xd800)}y`],
  ['a lone low surrogate', `x${units(0xdc00)}`],
  ['a trailing high surrogate', `x${units(0xdbff)}`],
]

describe('sha256Hex', () => {
  test('matches the FIPS 180-2 vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  test.each(LENGTHS)('matches node:crypto for a %i-byte message', (length) => {
    const text = 'a'.repeat(length)
    expect(sha256Hex(text)).toBe(native(text))
  })

  test.each(UNICODE)('matches node:crypto for %s', (_name, text) => {
    expect(sha256Hex(text)).toBe(native(text))
  })
})

describe('sha256HexAsync', () => {
  test.each(LENGTHS)('matches node:crypto for a %i-byte message', async (length) => {
    const text = 'a'.repeat(length)
    expect(await sha256HexAsync(text)).toBe(native(text))
  })

  test.each(UNICODE)('matches node:crypto for %s', async (_name, text) => {
    expect(await sha256HexAsync(text)).toBe(native(text))
  })
})
