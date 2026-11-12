import { describe, expect, test } from 'bun:test'

import {
  createLazyResponseAdQueue,
  getResponseAdForSlot,
  MAX_RESPONSE_AD_POOL_SIZE,
  requestLazyResponseAds,
  responseAdDisplayCount,
} from '../lazy-response-ads'
import { RESPONSE_AD_END_SLOT_COUNT } from '../response-ad-positions'

type TestAd = { impUrl: string; clickUrl?: string }

describe('requestLazyResponseAds', () => {
  test('fetches only when slots become eligible and caps the pool at four', async () => {
    const queue = createLazyResponseAdQueue<TestAd>()
    const shown: TestAd[] = []
    let fetchCount = 0
    const fetchOne = async () => ({ impUrl: `imp-${++fetchCount}` })

    expect(fetchCount).toBe(0)
    expect(
      requestLazyResponseAds({
        queue,
        messageId: 'ai-1',
        count: 0,
        fetchOne,
        onAd: (ad) => shown.push(ad),
      }),
    ).toBeNull()
    expect(fetchCount).toBe(0)

    await requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 1,
      fetchOne,
      onAd: (ad) => shown.push(ad),
    })
    expect(fetchCount).toBe(1)

    await requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 10,
      fetchOne,
      onAd: (ad) => shown.push(ad),
    })
    expect(fetchCount).toBe(MAX_RESPONSE_AD_POOL_SIZE)
    expect(shown).toHaveLength(MAX_RESPONSE_AD_POOL_SIZE)

    await requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 100,
      fetchOne,
      onAd: (ad) => shown.push(ad),
    })
    expect(fetchCount).toBe(MAX_RESPONSE_AD_POOL_SIZE)
  })

  test('does not retry no-fill or duplicate results for the same slots', async () => {
    const queue = createLazyResponseAdQueue<TestAd>()
    const shown: TestAd[] = []
    const results: Array<TestAd | null> = [
      null,
      { impUrl: 'same' },
      { impUrl: 'same' },
    ]
    let fetchCount = 0

    await requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 3,
      fetchOne: async () => results[fetchCount++] ?? null,
      onAd: (ad) => shown.push(ad),
    })

    expect(fetchCount).toBe(3)
    expect(shown).toEqual([{ impUrl: 'same' }])

    await requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 3,
      fetchOne: async () => {
        fetchCount++
        return { impUrl: 'new' }
      },
      onAd: (ad) => shown.push(ad),
    })
    expect(fetchCount).toBe(3)
  })

  test('extends an in-flight queue when more slots become eligible', async () => {
    const queue = createLazyResponseAdQueue<TestAd>()
    const shown: TestAd[] = []
    let fetchCount = 0
    let releaseFirst!: () => void
    const firstFetchBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fetchOne = async () => {
      const current = ++fetchCount
      if (current === 1) await firstFetchBlocked
      return { impUrl: `imp-${current}` }
    }

    const firstTask = requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 1,
      fetchOne,
      onAd: (ad) => shown.push(ad),
    })
    const extendedTask = requestLazyResponseAds({
      queue,
      messageId: 'ai-1',
      count: 3,
      fetchOne,
      onAd: (ad) => shown.push(ad),
    })

    expect(extendedTask).toBe(firstTask)
    releaseFirst()
    await extendedTask
    expect(fetchCount).toBe(3)
    expect(shown.map((ad) => ad.impUrl)).toEqual(['imp-1', 'imp-2', 'imp-3'])
  })
})

describe('repeated response ad pool', () => {
  const ads: TestAd[] = Array.from(
    { length: MAX_RESPONSE_AD_POOL_SIZE },
    (_, i) => ({
      impUrl: `imp-${i + 1}`,
      clickUrl: `https://click.example/${i + 1}`,
    }),
  )

  test('waits for the distinct pool, then fills every eligible slot', () => {
    expect(responseAdDisplayCount({ eligibleCount: 10, poolSize: 0 })).toBe(0)
    expect(responseAdDisplayCount({ eligibleCount: 10, poolSize: 3 })).toBe(3)
    expect(responseAdDisplayCount({ eligibleCount: 10, poolSize: 4 })).toBe(10)
  })

  test('repeats the same four ad objects and click URLs in order', () => {
    const sequence = Array.from({ length: 10 }, (_, slot) =>
      getResponseAdForSlot(ads, slot),
    )

    expect(sequence.map((ad) => ad?.impUrl)).toEqual([
      'imp-1',
      'imp-2',
      'imp-3',
      'imp-4',
      'imp-1',
      'imp-2',
      'imp-3',
      'imp-4',
      'imp-1',
      'imp-2',
    ])
    expect(sequence[0]).toBe(sequence[4])
    expect(sequence[0]?.clickUrl).toBe(sequence[4]?.clickUrl)
  })
})

describe('one end-of-answer slot', () => {
  test('repeated requests for one answer auction exactly once', async () => {
    const queue = createLazyResponseAdQueue<TestAd>()
    const shown: TestAd[] = []
    let fetchCount = 0
    const fetchOne = async () => ({ impUrl: `imp-${++fetchCount}` })
    for (let i = 0; i < 5; i++) {
      await requestLazyResponseAds({
        queue,
        messageId: 'ai-1',
        count: RESPONSE_AD_END_SLOT_COUNT,
        fetchOne,
        onAd: (ad) => shown.push(ad),
      })
    }
    expect(fetchCount).toBe(1)
    expect(shown.map((ad) => ad.impUrl)).toEqual(['imp-1'])
  })

  test('a no-fill is not retried for the same answer', async () => {
    const queue = createLazyResponseAdQueue<TestAd>()
    let fetchCount = 0
    const fetchOne = async () => {
      fetchCount++
      return null
    }
    for (let i = 0; i < 3; i++) {
      await requestLazyResponseAds({
        queue,
        messageId: 'ai-1',
        count: RESPONSE_AD_END_SLOT_COUNT,
        fetchOne,
        onAd: () => {},
      })
    }
    expect(fetchCount).toBe(1)
  })
})
