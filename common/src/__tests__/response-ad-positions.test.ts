import { describe, expect, test } from 'bun:test'

import {
  responseAdEndSlotCount,
  RESPONSE_AD_END_MIN_NODE_COUNT,
  responseAdNodePositions,
  RESPONSE_AD_END_SLOT_COUNT,
  responseAdSlotCount,
  RESPONSE_AD_FIRST_NODE_COUNT,
  RESPONSE_AD_NODE_STEP,
} from '../util/response-ad-positions'

describe('responseAdNodePositions', () => {
  test('places nothing in a response too short to intersperse', () => {
    expect(responseAdNodePositions({ nodeCount: 0, adCount: 3 })).toEqual([])
    expect(responseAdNodePositions({ nodeCount: 1, adCount: 3 })).toEqual([])
    expect(responseAdNodePositions({ nodeCount: 2, adCount: 3 })).toEqual([])
  })

  test('keeps the first ad after two nodes, then spaces ads every three nodes', () => {
    expect(RESPONSE_AD_FIRST_NODE_COUNT).toBe(2)
    expect(RESPONSE_AD_NODE_STEP).toBe(3)
    expect(responseAdNodePositions({ nodeCount: 2, adCount: 4 })).toEqual([])
    expect(responseAdNodePositions({ nodeCount: 3, adCount: 4 })).toEqual([1])
    expect(responseAdNodePositions({ nodeCount: 4, adCount: 4 })).toEqual([1])
    expect(responseAdNodePositions({ nodeCount: 6, adCount: 4 })).toEqual([1, 4])
    expect(responseAdNodePositions({ nodeCount: 9, adCount: 4 })).toEqual([1, 4, 7])
  })

  test('eligible display slots are not capped at eight', () => {
    expect(responseAdSlotCount({ nodeCount: 2 })).toBe(0)
    expect(responseAdSlotCount({ nodeCount: 3 })).toBe(1)
    expect(responseAdSlotCount({ nodeCount: 24 })).toBe(8)
    expect(responseAdSlotCount({ nodeCount: 27 })).toBe(9)
    expect(responseAdNodePositions({ nodeCount: 27, adCount: 9 })).toEqual([
      1, 4, 7, 10, 13, 16, 19, 22, 25,
    ])
  })

  test('never places more ads than provided', () => {
    expect(responseAdNodePositions({ nodeCount: 20, adCount: 2 })).toEqual([1, 4])
    expect(responseAdNodePositions({ nodeCount: 20, adCount: 0 })).toEqual([])
  })

  test('positions are stable as the streaming response appends nodes', () => {
    let previous: number[] = []
    for (let nodeCount = 0; nodeCount <= 12; nodeCount++) {
      const next = responseAdNodePositions({ nodeCount, adCount: 3 })
      expect(next.slice(0, previous.length)).toEqual(previous)
      previous = next
    }
  })

  test('allows the first-ad offset to differ from recurring spacing', () => {
    expect(
      responseAdNodePositions({
        nodeCount: 8,
        adCount: 3,
        firstAdAfterNodes: 3,
        step: 2,
      }),
    ).toEqual([2, 4, 6])
  })

  test('clamps non-positive placement settings to one', () => {
    expect(
      responseAdNodePositions({
        nodeCount: 4,
        adCount: 3,
        firstAdAfterNodes: 0,
        step: 0,
      }),
    ).toEqual([0, 1, 2])
  })
})

describe('responseAdEndSlotCount', () => {
  test('one slot, and only once the answer has completed', () => {
    expect(RESPONSE_AD_END_SLOT_COUNT).toBe(1)
    expect(responseAdEndSlotCount({ nodeCount: 12, isComplete: false })).toBe(0)
    expect(responseAdEndSlotCount({ nodeCount: 12, isComplete: true })).toBe(1)
  })

  test('a long answer still gets exactly one slot', () => {
    expect(responseAdEndSlotCount({ nodeCount: 400, isComplete: true })).toBe(1)
  })

  test('an empty completed answer gets none', () => {
    expect(responseAdEndSlotCount({ nodeCount: 0, isComplete: true })).toBe(0)
  })

  test('a short answer gets none: the floor is the old first-slot minimum', () => {
    expect(RESPONSE_AD_END_MIN_NODE_COUNT).toBe(3)
    // The interspersed rule's first slot opened at this node count too.
    expect(responseAdSlotCount({ nodeCount: 2 })).toBe(0)
    expect(responseAdSlotCount({ nodeCount: 3 })).toBe(1)
    expect(responseAdEndSlotCount({ nodeCount: 1, isComplete: true })).toBe(0)
    expect(responseAdEndSlotCount({ nodeCount: 2, isComplete: true })).toBe(0)
    expect(responseAdEndSlotCount({ nodeCount: 3, isComplete: true })).toBe(1)
  })
})
