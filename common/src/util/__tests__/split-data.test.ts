import { describe, expect, it } from 'bun:test'

import { splitData } from '../split-data'

describe('splitData - base cases', () => {
  it('returns primitive as-is in an array', () => {
    expect(splitData({ data: 42 })).toEqual([42])
    expect(splitData({ data: 'hello' })).toEqual(['hello'])
    expect(splitData({ data: null })).toEqual([null])
    expect(splitData({ data: undefined })).toEqual([undefined])
  })

  it('returns non-plain objects as-is', () => {
    const date = new Date()
    const regex = /abc/

    expect(splitData({ data: date })).toEqual([date])
    expect(splitData({ data: regex })).toEqual([regex])
  })

  it('splits short strings when maxChunkSize is small', () => {
    const input = { msg: 'abcdef'.repeat(10) } // 60 chars

    const chunks = splitData({ data: input, maxChunkSize: 30 })

    expect(chunks.length).toBeGreaterThan(1)
    const combined = chunks.map((c) => c.msg).join('')
    expect(combined).toBe(input.msg)
    expect(chunks.every((c) => JSON.stringify(c).length <= 30)).toBe(true)
  })

  it('splits deeply nested strings with small maxChunkSize', () => {
    const input = { a: { b: { c: 'xyz123'.repeat(10) } } }

    const chunks = splitData({ data: input, maxChunkSize: 50 })

    expect(chunks.length).toBeGreaterThan(1)
    const reconstructed = chunks.map((c) => c.a?.b?.c ?? '').join('')
    expect(reconstructed).toBe('xyz123'.repeat(10))
  })

  it('handles arrays with long values', () => {
    const input = ['abcde'.repeat(5), '12345'.repeat(5)]
    const chunks = splitData({ data: input, maxChunkSize: 40 })

    const combined = chunks
      .flat()
      .filter((v) => typeof v === 'string')
      .join('')
    expect(combined.startsWith(input.join('').slice(0, combined.length))).toBe(
      true,
    )
    expect(chunks.every((c) => JSON.stringify(c).length <= 40)).toBe(true)
  })

  it('preserves numbers and booleans', () => {
    const input = {
      flag: true,
      num: 123,
      str: 'hello world'.repeat(5),
    }

    const chunks = splitData({ data: input, maxChunkSize: 50 })

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => JSON.stringify(c).length <= 50)).toBe(true)
    expect(chunks.some((c) => c.flag === true)).toBe(true)
    expect(chunks.some((c) => c.num === 123)).toBe(true)
    expect(chunks.map((c) => c.str).join('')).toBe(input.str)
  })

  it('splits multiple string fields independently', () => {
    const input = {
      a: 'A'.repeat(20),
      b: 'B'.repeat(20),
    }
    const chunks = splitData({ data: input, maxChunkSize: 30 })

    expect(chunks.length).toBeGreaterThan(1)

    const aCombined = chunks.map((c) => c.a ?? '').join('')
    const bCombined = chunks.map((c) => c.b ?? '').join('')

    expect(aCombined).toBe(input.a)
    expect(bCombined).toBe(input.b)
  })
})

describe('splitData - array and string-specific splitting', () => {
  it('splits long strings into smaller string chunks', () => {
    const input = '12345678901234567890'
    const chunks = splitData({ data: input, maxChunkSize: 5 })

    expect(Array.isArray(chunks)).toBe(true)
    chunks.forEach((chunk) => {
      expect(typeof chunk).toBe('string')
      expect(chunk.length).toBeLessThanOrEqual(5)
    })

    expect(chunks.join('')).toBe(input)
  })

  it('splits arrays into smaller arrays with sliced strings', () => {
    const input = ['1', '2', '3333333333', '4', '5']
    const maxSize = 15
    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(Array.isArray(chunks)).toBe(true)
    chunks.forEach((chunk) => {
      expect(Array.isArray(chunk)).toBe(true)
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })

    const joined = chunks.flat().join('')
    expect(joined.startsWith(input.join('').slice(0, joined.length))).toBe(true)
  })

  it('splits plain objects with long strings into smaller objects', () => {
    const input = {
      a: 'aaa'.repeat(10),
      b: 'bbb'.repeat(10),
    }
    const maxSize = 40
    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(Array.isArray(chunks)).toBe(true)
    chunks.forEach((chunk) => {
      expect(typeof chunk).toBe('object')
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })

    const aJoined = chunks.map((c) => c.a ?? '').join('')
    const bJoined = chunks.map((c) => c.b ?? '').join('')
    expect(aJoined.startsWith(input.a.slice(0, aJoined.length))).toBe(true)
    expect(bJoined.startsWith(input.b.slice(0, bJoined.length))).toBe(true)
  })

  it('preserves numbers and booleans in split arrays', () => {
    const input = ['x'.repeat(20), 123, false, 'y'.repeat(10)]
    const maxSize = 20

    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(Array.isArray(chunks)).toBe(true)
    chunks.forEach((chunk) => {
      expect(Array.isArray(chunk)).toBe(true)
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })

    const flattened = chunks.flat()
    expect(flattened.includes(123)).toBe(true)
    expect(flattened.includes(false)).toBe(true)
    const strCombined = flattened.filter((v) => typeof v === 'string').join('')
    expect(strCombined.startsWith('x'.repeat(20) + 'y'.repeat(10))).toBe(true)
  })

  it('splits hybrid nested array/object structures within size limits', () => {
    const input = [
      { msg: 'x'.repeat(25) },
      { val: 42 },
      { msg: 'y'.repeat(25) },
    ]
    const maxSize = 30

    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(Array.isArray(chunks)).toBe(true)
    chunks.forEach((chunk) => {
      expect(Array.isArray(chunk)).toBe(true)
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })

    const joinedMsg = chunks
      .flat()
      .map((c) => c.msg ?? '')
      .join('')
    expect(joinedMsg.startsWith('x'.repeat(25) + 'y'.repeat(25))).toBe(true)
  })

  it('efficiently combines array elements while respecting maxSize', () => {
    const input = [
      'short',
      'strings',
      'that',
      'can',
      'fit',
      'together',
      'verylongstringthatwontfit.............................overflowing',
      'more',
      'short',
      'ones',
    ]
    const maxSize = 50

    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(chunks).toEqual([
      ['short', 'strings', 'that', 'can', 'fit', 'together'],
      ['verylongstringthatwontfit.....................'], // exactly 50 chars
      ['........overflowing', 'more', 'short', 'ones'],
    ])

    chunks.forEach((chunk) => {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })
  })

  it('efficiently combines object properties while respecting maxSize', () => {
    const input = {
      a: 'short',
      b: 'strings',
      c: 'that',
      d: 'can',
      e: 'fit',
      f: 'together',
      long: 'abcde'.repeat(15),
      g: 'more',
      h: 'short',
      i: 'ones',
    }
    const maxSize = 75

    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(chunks).toEqual([
      {
        a: 'short',
        b: 'strings',
        c: 'that',
        d: 'can',
        e: 'fit',
        f: 'together',
      },
      { long: 'abcde'.repeat(12) + 'abcd' }, // exactly 75 chars
      { long: 'e' + 'abcde'.repeat(2), g: 'more', h: 'short', i: 'ones' },
    ])

    chunks.forEach((chunk) => {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })
  })

  it('handles escaped characters at split points', () => {
    const input = 'testing"testing'
    const maxSize = 10

    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(chunks).toEqual([
      'testing', // only length 9, but testing" would be 11
      '"testin', // length 10
      'g', // length 3
    ])
    chunks.forEach((chunk) => {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(maxSize)
    })
  })
})

describe('splitData - nested object splitting', () => {
  it('maintains object structure when splitting nested long strings', () => {
    const input = {
      a: 'short',
      b: {
        c: 'strings',
        long: 'verylongstringthatwontfit...................overflowing',
      },
      d: 'more',
    }
    const maxSize = 50

    const chunks = splitData({ data: input, maxChunkSize: maxSize })

    expect(chunks).toEqual([
      {
        a: 'short',
        b: {
          c: 'strings',
        },
      },
      {
        b: {
          long: 'verylongstringthatwontfit........', // exactly 50 chars
        },
      },
      { b: { long: '...........overflowing' }, d: 'more' }, // 50 chars
    ])
  })
})

describe('splitData - object size boundaries', () => {
  it('counts commas when combining object properties', () => {
    const chunks = splitData({
      data: { a: 1, b: 2, c: 3 },
      maxChunkSize: 12,
    })

    expect(chunks).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    expect(chunks.every((chunk) => JSON.stringify(chunk).length <= 12)).toBe(true)
  })

  it('keeps properties together when the object exactly fits', () => {
    const data = { a: 1, b: 2 }

    expect(splitData({ data, maxChunkSize: 13 })).toEqual([data])
  })

  it('counts commas when combining a recursively split property', () => {
    const chunks = splitData({
      data: { a: 1, b: { x: 1, long: 2 } },
      maxChunkSize: 18,
    })

    expect(chunks).toEqual([{ a: 1 }, { b: { x: 1 } }, { b: { long: 2 } }])
    expect(chunks.every((chunk) => JSON.stringify(chunk).length <= 18)).toBe(true)
  })
})
