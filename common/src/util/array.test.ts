import { describe, test, expect } from 'bun:test'

import { filterDefined, buildArray, groupConsecutive } from './array'

describe('filterDefined', () => {
  test('removes null and undefined values from array', () => {
    const input = [1, null, 2, undefined, 3]
    const result = filterDefined(input)
    expect(result).toEqual([1, 2, 3])
  })

  test('preserves falsy values that are not null or undefined', () => {
    const input = [0, false, '', null, undefined, 'hello']
    const result = filterDefined(input)
    expect(result).toEqual([0, false, '', 'hello'])
  })

  test('returns empty array when all values are null or undefined', () => {
    const input = [null, undefined, null]
    const result = filterDefined(input)
    expect(result).toEqual([])
  })

  test('returns empty array for empty input', () => {
    const input: number[] = []
    const result = filterDefined(input)
    expect(result).toEqual([])
  })

  test('preserves array for values with no null or undefined', () => {
    const input = [1, 2, 3, 4, 5]
    const result = filterDefined(input)
    expect(result).toEqual([1, 2, 3, 4, 5])
  })

  test('works with object arrays', () => {
    const input: (string | null | undefined)[] = ['a', null, 'b', undefined]
    const result = filterDefined(input)
    expect(result).toEqual(['a', 'b'])
  })
})

describe('buildArray', () => {
  test('flattens nested arrays', () => {
    const result = buildArray(1, [2, 3], [[4, 5]])
    expect(result).toEqual([1, 2, 3, 4, 5])
  })

  test('removes falsy values', () => {
    const result = buildArray(1, null, 2, undefined, 3, false, 0, '')
    expect(result).toEqual([1, 2, 3])
  })

  test('handles deeply nested arrays', () => {
    const result = buildArray([[[1, 2], [3, 4]], [[5, 6]]])
    expect(result).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('returns empty array when all values are falsy', () => {
    const result = buildArray(null, undefined, false, 0, '')
    expect(result).toEqual([])
  })

  test('returns empty array with no arguments', () => {
    const result = buildArray()
    expect(result).toEqual([])
  })

  test('works with single value', () => {
    const result = buildArray(42)
    expect(result).toEqual([42])
  })

  test('handles mixed nested and flat values', () => {
    const result = buildArray(1, [2, 3], 4, [5, [6, 7]], 8)
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('preserves string values', () => {
    const result = buildArray('a', ['b', 'c'], [['d']])
    expect(result).toEqual(['a', 'b', 'c', 'd'])
  })

  test('removes only falsy values and preserves other values', () => {
    const result = buildArray([1, null, 2], undefined, [false, 3, 0])
    expect(result).toEqual([1, 2, 3])
  })

  test('preserves objects that are truthy', () => {
    const obj1 = { a: 1 }
    const obj2 = { b: 2 }
    const result = buildArray(obj1, [obj2])
    expect(result).toEqual([obj1, obj2])
  })
})

describe('groupConsecutive', () => {
  test('groups consecutive items with same key', () => {
    const input = [1, 1, 2, 2, 2, 3, 1]
    const result = groupConsecutive(input, (x) => x)
    expect(result).toEqual([
      { key: 1, items: [1, 1] },
      { key: 2, items: [2, 2, 2] },
      { key: 3, items: [3] },
      { key: 1, items: [1] },
    ])
  })

  test('handles empty array', () => {
    const result = groupConsecutive([], (x) => x)
    expect(result).toEqual([])
  })

  test('handles single item', () => {
    const result = groupConsecutive([42], (x) => x)
    expect(result).toEqual([{ key: 42, items: [42] }])
  })

  test('handles all items with different keys', () => {
    const input = [1, 2, 3, 4, 5]
    const result = groupConsecutive(input, (x) => x)
    expect(result).toEqual([
      { key: 1, items: [1] },
      { key: 2, items: [2] },
      { key: 3, items: [3] },
      { key: 4, items: [4] },
      { key: 5, items: [5] },
    ])
  })

  test('handles all items with same key', () => {
    const input = [1, 1, 1, 1]
    const result = groupConsecutive(input, (x) => x)
    expect(result).toEqual([{ key: 1, items: [1, 1, 1, 1] }])
  })

  test('works with object keys', () => {
    const input = [
      { type: 'a', value: 1 },
      { type: 'a', value: 2 },
      { type: 'b', value: 3 },
    ]
    const result = groupConsecutive(input, (x) => x.type)
    expect(result).toEqual([
      {
        key: 'a',
        items: [
          { type: 'a', value: 1 },
          { type: 'a', value: 2 },
        ],
      },
      {
        key: 'b',
        items: [{ type: 'b', value: 3 }],
      },
    ])
  })

  test('groups by complex key function', () => {
    const input = ['apple', 'apricot', 'banana', 'blueberry']
    const result = groupConsecutive(input, (s) => s[0]) // Group by first letter
    expect(result).toEqual([
      { key: 'a', items: ['apple', 'apricot'] },
      { key: 'b', items: ['banana', 'blueberry'] },
    ])
  })

  test('works with numeric keys', () => {
    const input = [1, 2, 1, 3, 3, 2]
    const result = groupConsecutive(input, (x) => x % 2) // Group by odd/even
    expect(result).toEqual([
      { key: 1, items: [1] },
      { key: 0, items: [2] },
      { key: 1, items: [1, 3, 3] },
      { key: 0, items: [2] },
    ])
  })

  test('groups objects with complex keys', () => {
    const input = [
      { id: 1, status: 'active' },
      { id: 2, status: 'active' },
      { id: 3, status: 'inactive' },
      { id: 4, status: 'active' },
    ]
    const result = groupConsecutive(input, (x) => x.status)
    expect(result).toEqual([
      {
        key: 'active',
        items: [
          { id: 1, status: 'active' },
          { id: 2, status: 'active' },
        ],
      },
      {
        key: 'inactive',
        items: [{ id: 3, status: 'inactive' }],
      },
      {
        key: 'active',
        items: [{ id: 4, status: 'active' }],
      },
    ])
  })

  test('handles string comparison correctly', () => {
    const input = ['a', 'a', 'b', 'b', 'a']
    const result = groupConsecutive(input, (x) => x)
    expect(result).toEqual([
      { key: 'a', items: ['a', 'a'] },
      { key: 'b', items: ['b', 'b'] },
      { key: 'a', items: ['a'] },
    ])
  })

  test('works with null and undefined values', () => {
    const input = [null, null, 'a', 'a', undefined]
    const result = groupConsecutive(input, (x) => x)
    expect(result).toEqual([
      { key: null, items: [null, null] },
      { key: 'a', items: ['a', 'a'] },
      { key: undefined, items: [undefined] },
    ])
  })

  test('handles objects with deep equality', () => {
    const input = [
      { nested: { value: 1 } },
      { nested: { value: 1 } },
      { nested: { value: 2 } },
    ]
    const result = groupConsecutive(input, (x) => x.nested)
    // Since isEqual does deep comparison, same nested object structure should group
    expect(result.length).toBe(2)
    expect(result[0].items.length).toBe(2)
    expect(result[1].items.length).toBe(1)
  })
})
