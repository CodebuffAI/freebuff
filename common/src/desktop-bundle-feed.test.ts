import { describe, expect, test } from 'bun:test'

import {
  DESKTOP_BUNDLE_VERSION_PATTERN,
  desktopBundleFeedSchema,
  desktopBundleRolloutBucket,
} from './desktop-bundle-feed'

describe('desktopBundleRolloutBucket', () => {
  test('is fixed per install and version, in [0, 100), and spread evenly', () => {
    expect(desktopBundleRolloutBucket('anon_abc', '0.0.205-b1')).toBe(desktopBundleRolloutBucket('anon_abc', '0.0.205-b1'))
    const buckets = Array.from({ length: 10_000 }, (_, i) => desktopBundleRolloutBucket(`anon_${i}`, '0.0.205-b1'))
    expect(buckets.every((b) => b >= 0 && b < 100)).toBe(true)
    const underTen = buckets.filter((b) => b < 10).length
    expect(underTen).toBeGreaterThan(850)
    expect(underTen).toBeLessThan(1150)
  })

  test('each version draws its own first installs', () => {
    const ids = Array.from({ length: 2_000 }, (_, i) => `anon_${i}`)
    const first = new Set(ids.filter((id) => desktopBundleRolloutBucket(id, '0.0.205-b1') < 5))
    const next = ids.filter((id) => desktopBundleRolloutBucket(id, '0.0.205-b2') < 5)
    expect(next.filter((id) => first.has(id)).length).toBeLessThan(next.length / 2)
  })
})

describe('desktopBundleFeedSchema', () => {
  const current = { version: '0.0.205-b1', shellAbi: 1, rolloutPercent: 10, manifest: 'bQ==', signature: 'cw==' }

  test('fills the optional lists and accepts a feed with nothing current', () => {
    expect(desktopBundleFeedSchema.parse({ format: 1, current })).toEqual({
      format: 1,
      current: { ...current, installIds: [] },
      revoked: [],
    })
    expect(desktopBundleFeedSchema.parse({ format: 1, current: null, revoked: ['0.0.204-b3'] }).revoked).toEqual(['0.0.204-b3'])
  })

  test('refuses what a client would refuse or could not use', () => {
    const bad = [
      { format: 2, current: null },
      { format: 1, current: { ...current, version: '../x' } },
      { format: 1, current: { ...current, rolloutPercent: 101 } },
      { format: 1, current: { ...current, shellAbi: 1.5 } },
      { format: 1, current: { ...current, manifest: '' } },
      { format: 1, current: null, revoked: ['not a version!'] },
    ]
    for (const feed of bad) expect(desktopBundleFeedSchema.safeParse(feed).success).toBe(false)
  })

  test('the version pattern is the client one', () => {
    // freebuff-desktop/electron/orchestrator-bundle.cjs VERSION_PATTERN
    expect(DESKTOP_BUNDLE_VERSION_PATTERN.source).toBe('^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$')
  })
})
