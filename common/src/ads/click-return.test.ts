import { describe, expect, test } from 'bun:test'

import {
  CLICK_RETURN_LEAVE_GRACE_MS,
  CLICK_RETURN_WATCH_MS,
  bindClickReturnToDom,
  createClickAckGate,
  createClickReturnWatcher,
  parseClickReturnBody,
} from './click-return'

import type { ClickReturnBody, ClickReturnClient } from './click-return'

function fakeClock() {
  let now = 1_000
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
    pendingTimers: () => timers.size,
  }
}

function setup(client: ClickReturnClient) {
  const clock = fakeClock()
  const reports: Array<[string, ClickReturnBody]> = []
  const watcher = createClickReturnWatcher<string>({
    client,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    report: (key, body) => reports.push([key, body]),
  })
  return { clock, reports, watcher }
}

describe('parseClickReturnBody', () => {
  test('accepts each consistent shape', () => {
    expect(
      parseClickReturnBody({
        client: 'cli',
        outcome: 'returned',
        signal: 'next_turn',
        awayMs: 42_000,
      }),
    ).toEqual({
      client: 'cli',
      outcome: 'returned',
      signal: 'next_turn',
      awayMs: 42_000,
    })
    expect(
      parseClickReturnBody({
        client: 'web',
        outcome: 'returned',
        signal: 'visibility',
        awayMs: 0,
      }),
    ).not.toBeNull()
    expect(
      parseClickReturnBody({
        client: 'desktop',
        outcome: 'not_returned',
        signal: 'watch_expired',
        awayMs: null,
      }),
    ).not.toBeNull()
    expect(
      parseClickReturnBody({
        client: 'desktop',
        outcome: 'never_left',
        signal: 'leave_grace_expired',
      }),
    ).toEqual({
      client: 'desktop',
      outcome: 'never_left',
      signal: 'leave_grace_expired',
      awayMs: null,
    })
  })

  test('rejects a signal the client cannot observe', () => {
    const base = { outcome: 'returned', awayMs: 5 }
    expect(
      parseClickReturnBody({ ...base, client: 'web', signal: 'next_turn' }),
    ).toBeNull()
    expect(
      parseClickReturnBody({ ...base, client: 'cli', signal: 'focus' }),
    ).toBeNull()
    expect(
      parseClickReturnBody({
        client: 'cli',
        outcome: 'never_left',
        signal: 'leave_grace_expired',
        awayMs: null,
      }),
    ).toBeNull()
  })

  test('rejects rather than clamps a bad duration', () => {
    const base = { client: 'cli', outcome: 'returned', signal: 'next_turn' }
    for (const awayMs of [
      -1,
      1.5,
      CLICK_RETURN_WATCH_MS + 1,
      '10',
      null,
      undefined,
      Number.NaN,
    ]) {
      expect(parseClickReturnBody({ ...base, awayMs })).toBeNull()
    }
    expect(
      parseClickReturnBody({
        client: 'web',
        outcome: 'not_returned',
        signal: 'watch_expired',
        awayMs: 10,
      }),
    ).toBeNull()
  })

  test('rejects unknown values and mismatched outcome/signal', () => {
    expect(parseClickReturnBody(null)).toBeNull()
    expect(parseClickReturnBody('x')).toBeNull()
    expect(
      parseClickReturnBody({
        client: 'ios',
        outcome: 'returned',
        signal: 'focus',
        awayMs: 1,
      }),
    ).toBeNull()
    expect(
      parseClickReturnBody({
        client: 'web',
        outcome: 'returned',
        signal: 'watch_expired',
        awayMs: 1,
      }),
    ).toBeNull()
    expect(
      parseClickReturnBody({
        client: 'web',
        outcome: 'not_returned',
        signal: 'focus',
        awayMs: null,
      }),
    ).toBeNull()
  })
})

describe('createClickReturnWatcher (CLI)', () => {
  test('the next turn reports click → prompt latency, once', () => {
    const { clock, reports, watcher } = setup('cli')
    watcher.click('imp-1')
    clock.advance(12_345)
    watcher.back('next_turn')
    watcher.back('next_turn')
    expect(reports).toEqual([
      [
        'imp-1',
        {
          client: 'cli',
          outcome: 'returned',
          signal: 'next_turn',
          awayMs: 12_345,
        },
      ],
    ])
    expect(clock.pendingTimers()).toBe(0)
  })

  test('focus signals are ignored on the CLI', () => {
    const { clock, reports, watcher } = setup('cli')
    watcher.click('imp-1')
    clock.advance(100)
    watcher.back('focus')
    expect(reports).toEqual([])
  })

  test('a second click resolves the first as next_click', () => {
    const { clock, reports, watcher } = setup('cli')
    watcher.click('imp-1')
    clock.advance(3_000)
    watcher.click('imp-2')
    clock.advance(4_000)
    watcher.back('next_turn')
    expect(
      reports.map(([key, body]) => [key, body.signal, body.awayMs]),
    ).toEqual([
      ['imp-1', 'next_click', 3_000],
      ['imp-2', 'next_turn', 4_000],
    ])
  })

  test('the watch window expires as not_returned, with no leave grace', () => {
    const { clock, reports, watcher } = setup('cli')
    watcher.click('imp-1')
    clock.advance(CLICK_RETURN_LEAVE_GRACE_MS * 2)
    expect(reports).toEqual([])
    clock.advance(CLICK_RETURN_WATCH_MS)
    expect(reports).toEqual([
      [
        'imp-1',
        {
          client: 'cli',
          outcome: 'not_returned',
          signal: 'watch_expired',
          awayMs: null,
        },
      ],
    ])
    watcher.back('next_turn')
    expect(reports).toHaveLength(1)
  })

  test('dispose drops the pending click silently', () => {
    const { clock, reports, watcher } = setup('cli')
    watcher.click('imp-1')
    watcher.dispose()
    clock.advance(CLICK_RETURN_WATCH_MS * 2)
    watcher.back('next_turn')
    expect(reports).toEqual([])
    expect(clock.pendingTimers()).toBe(0)
  })
})

describe('createClickReturnWatcher (Desktop/Web)', () => {
  test('leave then return reports the duration from the click', () => {
    const { clock, reports, watcher } = setup('web')
    watcher.click('imp-1')
    clock.advance(200)
    watcher.left()
    clock.advance(9_800)
    watcher.back('visibility')
    expect(reports).toEqual([
      [
        'imp-1',
        {
          client: 'web',
          outcome: 'returned',
          signal: 'visibility',
          awayMs: 10_000,
        },
      ],
    ])
  })

  test('a return before any leave is not a return', () => {
    const { clock, reports, watcher } = setup('desktop')
    watcher.click('imp-1')
    clock.advance(10)
    watcher.back('focus')
    expect(reports).toEqual([])
    watcher.left()
    clock.advance(1_000)
    watcher.back('focus')
    expect(reports.map(([, body]) => body.outcome)).toEqual(['returned'])
  })

  test('nothing leaving within the grace is never_left', () => {
    const { clock, reports, watcher } = setup('desktop')
    watcher.click('imp-1')
    clock.advance(CLICK_RETURN_LEAVE_GRACE_MS)
    expect(reports).toEqual([
      [
        'imp-1',
        {
          client: 'desktop',
          outcome: 'never_left',
          signal: 'leave_grace_expired',
          awayMs: null,
        },
      ],
    ])
    expect(clock.pendingTimers()).toBe(0)
  })

  test('next_turn is ignored off the CLI', () => {
    const { clock, reports, watcher } = setup('web')
    watcher.click('imp-1')
    watcher.left()
    clock.advance(1_000)
    watcher.back('next_turn')
    expect(reports).toEqual([])
  })

  test('a report that throws does not break the watcher', () => {
    const clock = fakeClock()
    let calls = 0
    const watcher = createClickReturnWatcher<string>({
      client: 'web',
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      report: () => {
        calls++
        throw new Error('boom')
      },
    })
    watcher.click('a')
    watcher.left()
    watcher.back('focus')
    watcher.click('b')
    watcher.left()
    watcher.back('focus')
    expect(calls).toBe(2)
  })
})

describe('the watch deadline', () => {
  test('a return after the deadline is not_returned even if the expiry timer never fired', () => {
    // A backgrounded page can have its timers throttled or suspended: here
    // they never fire at all, and only the clock moves.
    let now = 1_000
    const reports: Array<[string, ClickReturnBody]> = []
    const watcher = createClickReturnWatcher<string>({
      client: 'desktop',
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => {},
      report: (key, body) => reports.push([key, body]),
    })
    watcher.click('imp-1')
    watcher.left()
    now += CLICK_RETURN_WATCH_MS + 5_000
    watcher.back('focus')
    expect(reports).toEqual([
      [
        'imp-1',
        {
          client: 'desktop',
          outcome: 'not_returned',
          signal: 'watch_expired',
          awayMs: null,
        },
      ],
    ])
  })
})

describe('createClickAckGate', () => {
  test('a return report waits for its click acknowledgement, then sends', async () => {
    const gate = createClickAckGate<string>()
    const sent: string[] = []
    let resolveAck!: () => void
    gate.track('imp-1', new Promise<void>((r) => (resolveAck = r)))
    gate.after('imp-1', () => sent.push('imp-1'))
    await Promise.resolve()
    expect(sent).toEqual([])
    resolveAck()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['imp-1'])
  })

  test('a failed click still releases its report, and an untracked key sends at once', async () => {
    const gate = createClickAckGate<string>()
    const sent: string[] = []
    gate.track('imp-1', Promise.reject(new Error('offline')))
    gate.after('imp-1', () => sent.push('imp-1'))
    gate.after('imp-2', () => sent.push('imp-2'))
    expect(sent).toEqual(['imp-2'])
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['imp-2', 'imp-1'])
  })
})

describe('bindClickReturnToDom', () => {
  function target() {
    const listeners = new Map<string, Set<() => void>>()
    return {
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(fn)
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn)
      },
      fire(type: string) {
        for (const fn of listeners.get(type) ?? []) fn()
      },
      count: () =>
        [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    }
  }

  test('visibility and focus drive the watcher, and unbind removes all', () => {
    const { clock, reports, watcher } = setup('web')
    const doc = target()
    const win = target()
    const unbind = bindClickReturnToDom(watcher, { document: doc, window: win })

    watcher.click('imp-1')
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    clock.advance(7_000)
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    win.fire('focus')
    expect(reports.map(([, body]) => [body.signal, body.awayMs])).toEqual([
      ['visibility', 7_000],
    ])

    watcher.click('imp-2')
    win.fire('blur')
    clock.advance(2_000)
    win.fire('focus')
    expect(reports.map(([, body]) => body.signal)).toEqual([
      'visibility',
      'focus',
    ])

    unbind()
    expect(doc.count() + win.count()).toBe(0)
  })
})
