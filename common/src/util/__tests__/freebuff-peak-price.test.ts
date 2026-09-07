import { describe, expect, it } from 'bun:test'

import { deepSeekExpensiveWindowEndsAt } from '../../constants/freebuff-peak-hours'
import { freebucksPeakCopy, isFreebucksPeakModel } from '../freebuff-peak-price'

import type { FreebuffFreebucksPeak } from '../../types/freebuff-session'

// Mon 19:00 PDT, inside DeepSeek's expensive window.
const PEAK = Date.UTC(2026, 8, 7, 2, 0, 0)
const FLASH = 'deepseek/deepseek-v4-flash'

// The block is built by hand rather than read off `freebucksPricing`: this
// file is PUBLIC and the price table's module is export-excluded, which is
// the whole reason these helpers live in `util/`. The builder's own half is
// tested beside the table, where the prices already are.
const peak = (over: Partial<FreebuffFreebucksPeak> = {}): FreebuffFreebucksPeak => ({
  modelIds: [FLASH],
  surcharge: 10,
  endsAt: deepSeekExpensiveWindowEndsAt(new Date(PEAK)).toISOString(),
  ...over,
})

describe('peak price copy', () => {
  it('knows which rows the surcharge is on', () => {
    expect(isFreebucksPeakModel({ peak: peak() }, FLASH)).toBe(true)
    expect(isFreebucksPeakModel({ peak: peak() }, 'z-ai/glm-5.3-flash')).toBe(false)
    // No block at all is the off-peak case, and the common one: a client that
    // has never seen a peak must not badge anything.
    expect(isFreebucksPeakModel({}, FLASH)).toBe(false)
    expect(isFreebucksPeakModel(undefined, FLASH)).toBe(false)
    expect(isFreebucksPeakModel(null, FLASH)).toBe(false)
  })

  it("explains the badge in the reader's zone and names the price it returns to", () => {
    const copy = freebucksPeakCopy({
      peak: peak(),
      basePrice: 15,
      now: PEAK,
      timeZone: 'Asia/Seoul',
    })
    expect(copy.badge).toBe('Peak pricing')
    expect(copy.tooltip).toContain('+10 Freebucks a session')
    // 00:00–10:00 UTC is 9:00 AM – 7:00 PM in Seoul, and the window closes at
    // 7:00 PM there. Nothing in it says "PT" — that was the whole complaint
    // about the sentence this replaced.
    expect(copy.tooltip).toContain('9:00 AM – 7:00 PM')
    expect(copy.tooltip).toContain('Back to 15 Freebucks at 7:00 PM')
    expect(copy.tooltip).not.toContain('PT')
  })

  it('gives a Pacific reader the hours the old sentence hard-coded', () => {
    expect(
      freebucksPeakCopy({
        peak: peak(),
        basePrice: 15,
        now: PEAK,
        timeZone: 'America/Los_Angeles',
      }).tooltip,
    ).toContain('5:00 PM – 3:00 AM')
  })
})
