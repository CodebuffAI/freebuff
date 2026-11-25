import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_SESSION_PAUSE_COST_MS,
  FREEBUFF_SESSION_PAUSE_MIN_KEEP_MS,
  freebuffSessionPauseKeepsMs,
} from '../freebuff-session-pause'

const minute = 60_000
const now = Date.parse('2026-11-24T12:00:00Z')

describe('what a pause keeps', () => {
  test('the time left, less 15 minutes', () => {
    expect(FREEBUFF_SESSION_PAUSE_COST_MS).toBe(15 * minute)
    expect(freebuffSessionPauseKeepsMs(now + 42 * minute, now)).toBe(
      27 * minute,
    )
    expect(freebuffSessionPauseKeepsMs(now + 60 * minute, now)).toBe(
      45 * minute,
    )
  })

  test('nothing when the cost would leave less than a minute', () => {
    expect(
      freebuffSessionPauseKeepsMs(
        now +
          FREEBUFF_SESSION_PAUSE_COST_MS +
          FREEBUFF_SESSION_PAUSE_MIN_KEEP_MS,
        now,
      ),
    ).toBe(FREEBUFF_SESSION_PAUSE_MIN_KEEP_MS)
    expect(
      freebuffSessionPauseKeepsMs(
        now +
          FREEBUFF_SESSION_PAUSE_COST_MS +
          FREEBUFF_SESSION_PAUSE_MIN_KEEP_MS -
          1,
        now,
      ),
    ).toBe(0)
    expect(freebuffSessionPauseKeepsMs(now + 10 * minute, now)).toBe(0)
    expect(freebuffSessionPauseKeepsMs(now - minute, now)).toBe(0)
  })

  test('nothing for an unreadable expiry', () => {
    expect(freebuffSessionPauseKeepsMs(Number.NaN, now)).toBe(0)
  })
})
