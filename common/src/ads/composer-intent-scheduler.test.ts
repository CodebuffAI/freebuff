import { describe, expect, test } from 'bun:test'

import { createComposerIntentScheduler } from './composer-intent-scheduler'

/** A manual clock and a request whose answers the test releases by hand. */
function harness() {
  let now = 0
  const timers: { at: number; fire: () => void; live: boolean }[] = []
  const pending: { draft: string; resolve: (ad: string | null) => void }[] = []
  const shown: (string | null)[] = []
  const scheduler = createComposerIntentScheduler<string>({
    request: (draft) =>
      new Promise((resolve) => pending.push({ draft, resolve })),
    onAnswer: (ad) => shown.push(ad),
    setTimeout: (fire, ms) => {
      const timer = { at: now + ms, fire, live: true }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      ;(timer as { live: boolean }).live = false
    },
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers)
      if (timer.live && timer.at <= now) {
        timer.live = false
        timer.fire()
      }
  }
  /** Let the scheduler's promise chain settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { scheduler, advance, flush, pending, shown }
}

describe('the composer intent scheduler', () => {
  test('asks only after 1s idle, and not for drafts under 3 characters', () => {
    const { scheduler, advance, pending } = harness()
    scheduler.update('re')
    advance(2_000)
    expect(pending).toEqual([])
    scheduler.update('review my pr')
    advance(999)
    expect(pending).toEqual([])
    scheduler.update('review my pr please')
    advance(999)
    expect(pending).toEqual([])
    advance(1)
    expect(pending.map((p) => p.draft)).toEqual(['review my pr please'])
  })

  test('keeps one request in flight and sends only the newest waiting draft', async () => {
    const { scheduler, advance, flush, pending, shown } = harness()
    scheduler.update('review my pr')
    advance(1_000)
    scheduler.update('review my pr and')
    advance(1_000)
    scheduler.update('review my pr and merge it')
    advance(1_000)
    expect(pending.map((p) => p.draft)).toEqual(['review my pr'])

    // The first answer is for a draft that is no longer current: not shown.
    pending[0]!.resolve('greptile')
    await flush()
    expect(shown).toEqual([])
    // ...and only the newest settled draft follows it.
    expect(pending.map((p) => p.draft)).toEqual([
      'review my pr',
      'review my pr and merge it',
    ])
    pending[1]!.resolve('greptile-2')
    await flush()
    expect(shown).toEqual(['greptile-2'])
  })

  test('answers a draft it has already asked about from memory', async () => {
    const { scheduler, advance, flush, pending, shown } = harness()
    scheduler.update('ship this launch')
    advance(1_000)
    pending[0]!.resolve('runable')
    await flush()
    scheduler.update('ship this launch video')
    scheduler.update('ship this launch')
    advance(1_000)
    expect(pending).toHaveLength(1)
    expect(shown).toEqual(['runable', 'runable'])
  })

  test('clearing the draft hides the answer at once, and dispose silences late answers', async () => {
    const { scheduler, advance, flush, pending, shown } = harness()
    scheduler.update('review my pr')
    advance(1_000)
    scheduler.update('')
    expect(shown).toEqual([null])
    scheduler.update('merge the pr')
    advance(1_000)
    scheduler.dispose()
    pending[0]!.resolve('greptile')
    await flush()
    expect(shown).toEqual([null])
    expect(pending.map((p) => p.draft)).toEqual(['review my pr'])
  })
})
