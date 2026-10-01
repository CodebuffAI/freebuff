import { describe, expect, test } from 'bun:test'

import {
  landingAdOptions,
  landingScreenDrawsAds,
} from '../freebuff-landing-screen'
import { shouldHideGravityAds } from '../../hooks/use-gravity-ad'

/**
 * The landing screen drops its ad banner on short terminals. Until 2026-10-01
 * its ad hook stayed enabled there, and Freebuff ignores the hook's own
 * compact-height rule, so it kept fetching a slot nobody could see. Every
 * such fill is served and never acknowledged, which is what the ad-signal
 * detector's render ratio counts against an account.
 */
describe('landing screen ads are fetched only when drawn', () => {
  test('the banner floor is 18 rows', () => {
    expect(landingScreenDrawsAds(17)).toBe(false)
    expect(landingScreenDrawsAds(18)).toBe(true)
  })

  test('at every height, the hook fetches exactly when the banner is drawn', () => {
    for (let height = 5; height <= 60; height++) {
      const options = landingAdOptions({
        terminalHeight: height,
        placementIds: ['Waiting-Room-1'],
      })
      const hidden = shouldHideGravityAds({
        enabled: options.enabled,
        terminalHeight: height,
        isFreeMode: true,
      })
      expect({ height, fetches: !hidden }).toEqual({
        height,
        fetches: landingScreenDrawsAds(height),
      })
    }
  })

  test('the surface keeps its legacy wire name', () => {
    const options = landingAdOptions({ terminalHeight: 40, placementIds: [] })
    expect(options.surface).toBe('waiting_room')
    expect(options.forceStart).toBe(true)
  })
})
