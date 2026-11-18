import { describe, expect, it } from 'bun:test'

import {
  responseAdSlotCount,
  responseAdNodePositions,
  RESPONSE_AD_FIRST_NODE_COUNT,
  RESPONSE_AD_NODE_STEP,
} from '../response-ad-positions'

describe('responseAdSlotCount', () => {
  it('returns 0 when nodeCount is less than firstAdAfterNodes', () => {
    expect(responseAdSlotCount({ nodeCount: 1 })).toBe(0)
    expect(responseAdSlotCount({ nodeCount: 0 })).toBe(0)
  })

  it('returns correct count for valid nodeCount', () => {
    expect(responseAdSlotCount({ nodeCount: 10 })).toBe(3)
    expect(responseAdSlotCount({ nodeCount: 20 })).toBe(6)
  })

  it('handles NaN nodeCount gracefully', () => {
    expect(responseAdSlotCount({ nodeCount: NaN })).toBe(0)
  })

  it('handles Infinity nodeCount gracefully', () => {
    expect(responseAdSlotCount({ nodeCount: Infinity })).toBe(0)
  })

  it('handles negative nodeCount gracefully', () => {
    expect(responseAdSlotCount({ nodeCount: -5 })).toBe(0)
  })

  it('uses custom step when provided', () => {
    expect(responseAdSlotCount({ nodeCount: 20, step: 5 })).toBe(4)
  })

  it('uses custom firstAdAfterNodes when provided', () => {
    expect(responseAdSlotCount({ nodeCount: 20, firstAdAfterNodes: 5 })).toBe(5)
  })
})

describe('responseAdNodePositions', () => {
  it('returns empty array when adCount is 0', () => {
    expect(responseAdNodePositions({ nodeCount: 10, adCount: 0 })).toEqual([])
  })

  it('returns correct positions for valid inputs', () => {
    const result = responseAdNodePositions({ nodeCount: 20, adCount: 2 })
    expect(result).toEqual([1, 4])
  })

  it('handles NaN nodeCount gracefully', () => {
    expect(responseAdNodePositions({ nodeCount: NaN, adCount: 2 })).toEqual([])
  })

  it('handles Infinity nodeCount gracefully', () => {
    expect(responseAdNodePositions({ nodeCount: Infinity, adCount: 2 })).toEqual([])
  })
})

