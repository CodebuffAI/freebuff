import { describe, expect, test } from 'bun:test'

import { visibleWaitingRoomPlacementIds } from './waiting-room-placements'

describe('visibleWaitingRoomPlacementIds', () => {
  test.each([
    [61, 1],
    [121, 1],
    [122, 2],
    [181, 2],
    [182, 3],
    [241, 3],
    [242, 4],
    [600, 4],
  ])('uses the canonical prefix at width %i', (width, count) => {
    const placements = visibleWaitingRoomPlacementIds(width)
    expect(placements).toHaveLength(count)
    expect(placements).toEqual(
      [
        'Waiting-Room-1-CLI',
        'Waiting-Room-2-CLI',
        'Waiting-Room-3-CLI',
        'Waiting-Room-4-CLI',
      ].slice(0, count),
    )
  })
})
