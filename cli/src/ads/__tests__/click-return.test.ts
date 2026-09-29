import { describe, expect, test } from 'bun:test'

import { CLICK_RETURN_WATCH_MS } from '@codebuff/common/ads/click-return'

import { createCliClickReturn } from '../click-return'

import type { ClickReturnBody } from '@codebuff/common/ads/click-return'

function harness() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const sent: Array<[string, ClickReturnBody]> = []
  const watcher = createCliClickReturn({
    send: (impUrl, body) => sent.push([impUrl, body]),
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
  })
  return {
    watcher,
    sent,
    timers,
    advance(ms: number) {
      now += ms
      for (const [key, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(key)
          timer.fn()
        }
      }
    },
  }
}

describe('createCliClickReturn', () => {
  test('the next submitted prompt is the return', () => {
    const h = harness()
    h.watcher.click('https://first-party.invalid/i/abc')
    h.advance(95_000)
    h.watcher.back('next_turn')
    expect(h.sent).toEqual([
      [
        'https://first-party.invalid/i/abc',
        {
          client: 'cli',
          outcome: 'returned',
          signal: 'next_turn',
          awayMs: 95_000,
        },
      ],
    ])
    expect(h.timers.size).toBe(0)
  })

  test('no leave grace: a slow return is never never_left', () => {
    const h = harness()
    h.watcher.click('imp')
    h.advance(60_000)
    expect(h.sent).toEqual([])
  })

  test('no prompt inside the watch is not_returned', () => {
    const h = harness()
    h.watcher.click('imp')
    h.advance(CLICK_RETURN_WATCH_MS)
    expect(h.sent.map(([, body]) => body.outcome)).toEqual(['not_returned'])
  })
})
