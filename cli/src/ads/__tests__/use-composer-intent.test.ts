import { describe, expect, test } from 'bun:test'
import { createComposerIntentScheduler } from '@codebuff/common/ads/composer-intent-scheduler'

/**
 * What `useComposerIntentAd` relies on when its gate closes (an ad-network
 * ad on screen, a menu, a form): it tells the scheduler the draft is empty.
 */
describe('the composer row gate closing', () => {
  const harness = () => {
    const timers: Array<() => void> = []
    const answers: Array<(ad: string | null) => void> = []
    const asked: string[] = []
    const shown: Array<string | null> = []
    const scheduler = createComposerIntentScheduler<string>({
      request: (draft) => {
        asked.push(draft)
        return new Promise((resolve) => answers.push(resolve))
      },
      onAnswer: (ad) => shown.push(ad),
      setTimeout: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimeout: () => {
        timers.length = 0
      },
    })
    const flush = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }
    return { scheduler, timers, answers, asked, shown, flush }
  }

  test('a draft waiting for its idle timer is never asked about', () => {
    const h = harness()
    h.scheduler.update('open a pull request')
    h.scheduler.update('') // gate closed before the idle timer fired
    for (const fire of h.timers.splice(0)) fire()
    expect(h.asked).toEqual([])
    expect(h.shown).toEqual([null])
  })

  test('a late answer is not shown; the same draft on reopen shows it with no new request', async () => {
    const h = harness()
    h.scheduler.update('open a pull request')
    h.timers.shift()!()
    expect(h.asked).toEqual(['open a pull request'])
    h.scheduler.update('') // gate closed while the request is out
    h.answers.shift()!('row')
    await h.flush()
    expect(h.shown).toEqual([null])
    h.scheduler.update('open a pull request') // gate reopened, same draft
    h.timers.shift()!()
    expect(h.asked).toEqual(['open a pull request'])
    expect(h.shown).toEqual([null, 'row'])
  })
})
