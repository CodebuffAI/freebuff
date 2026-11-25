import { describe, expect, test } from 'bun:test'
import type { AdReport } from '@codebuff/common/ads/ad-report'
import { createAdReportRegistry } from '../ad-reports'

const AD = {
  title: 'First ad',
  url: 'https://example.com/first',
  surface: 'cli',
  impUrl: 'first',
}
const REASON = 'This ad makes a misleading claim.'

describe('the ad report form state', () => {
  test('validation cannot be bypassed and cancel sends nothing', async () => {
    const sent: AdReport[] = []
    const registry = createAdReportRegistry()
    registry.open({ ...AD, reason: REASON }, async (ad) => {
      sent.push(ad)
    })
    expect(registry.getPrompt()?.ad.reason).toBeUndefined()
    for (const reason of ['', ' '.repeat(20), 'short', 'a'.repeat(2001)]) {
      await expect(registry.submit(reason)).rejects.toThrow()
    }
    expect(registry.getPrompt()?.status).toBe('idle')
    registry.cancel()
    expect(registry.getPrompt()).toBeNull()
    expect(sent).toEqual([])
  })

  test('an open form keeps its ad and sender; it sends the trimmed explanation once', async () => {
    const sent: AdReport[] = []
    const registry = createAdReportRegistry()
    registry.open(AD, async (ad) => {
      sent.push(ad)
    })
    registry.open({ ...AD, title: 'Second ad' }, async () => {
      throw new Error('wrong sender')
    })
    await registry.submit(`  ${REASON}  `)
    expect(sent).toEqual([{ ...AD, reason: REASON }])
    expect(registry.getPrompt()).toBeNull()
  })

  test('no duplicate send while sending; a failure keeps the form for a retry', async () => {
    let finish!: () => void
    let calls = 0
    const registry = createAdReportRegistry()
    registry.open(AD, async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await registry.submit(REASON)
    expect(registry.getPrompt()?.status).toBe('error')
    const retry = registry.submit(REASON)
    expect(registry.getPrompt()?.status).toBe('sending')
    await registry.submit(REASON)
    registry.cancel()
    expect(registry.getPrompt()?.status).toBe('sending')
    finish()
    await retry
    expect(registry.getPrompt()).toBeNull()
    expect(calls).toBe(2)
  })

  test('a reset while sending leaves the next form alone when the send settles', async () => {
    let fail!: (error: Error) => void
    const registry = createAdReportRegistry()
    registry.open(AD, () => new Promise((_, reject) => (fail = reject)))
    const sending = registry.submit(REASON)
    registry.reset()
    registry.open({ ...AD, title: 'Next ad' }, async () => {})
    const next = registry.getPrompt()
    fail(new Error('offline'))
    await sending
    expect(registry.getPrompt()).toBe(next)
  })
})
