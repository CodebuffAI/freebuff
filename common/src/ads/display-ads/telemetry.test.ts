import { describe, expect, test } from 'bun:test'

import { AnalyticsEvent } from '../../constants/analytics-events'
import { buildDisplayAdEvent, displayAdFlagFor, parseDisplayAdEvent } from './telemetry'

describe('display-ad telemetry', () => {
  test('stamps the placement id for the surface, the sponsor, and the mock / not-billable flags', () => {
    expect(
      buildDisplayAdEvent({
        kind: 'impression',
        slot: 'topBanner',
        surface: 'web',
        sponsorId: 'sentry',
        action: 'view',
        viewability: 'mrc50',
      }),
    ).toEqual({
      event: AnalyticsEvent.DISPLAY_AD_IMPRESSION,
      properties: {
        placement_id: 'Desktop-Top-Banner:web',
        slot: 'topBanner',
        surface: 'web',
        sponsor_id: 'sentry',
        action: 'view',
        mock_creative: true,
        billable: false,
        viewability: 'mrc50',
      },
    })
    expect(
      buildDisplayAdEvent({
        kind: 'click',
        slot: 'deals',
        surface: 'cli',
        sponsorId: 'neon',
        action: 'deals_use',
        position: 2,
      })?.properties,
    ).toMatchObject({ placement_id: 'CLI-Deals', position: 2, billable: false })
  })

  test('never uses the served-ad event names', () => {
    const event = buildDisplayAdEvent({
      kind: 'click',
      slot: 'mcpFeatured',
      surface: 'desktop',
      sponsorId: 'neon',
      action: 'link',
    })!.event
    expect(event).toBe(AnalyticsEvent.DISPLAY_AD_CLICK)
    expect([
      AnalyticsEvent.ADS_IMPRESSION_RECORDED,
      AnalyticsEvent.ADS_CLICKED,
      AnalyticsEvent.DESKTOP_AD_SHOWN,
      AnalyticsEvent.DESKTOP_AD_CLICKED,
    ]).not.toContain(event)
  })

  test('refuses anything outside the allowlist', () => {
    const ok = { kind: 'dismiss', slot: 'homeTakeover', surface: 'desktop', sponsorId: 'deepgram', action: 'hide_button' }
    expect(buildDisplayAdEvent(ok)).not.toBeNull()
    expect(buildDisplayAdEvent({ ...ok, kind: 'bill' })).toBeNull()
    expect(buildDisplayAdEvent({ ...ok, surface: 'cli' })).toBeNull() // no CLI id for this slot
    expect(buildDisplayAdEvent({ ...ok, sponsorId: 'acme' })).toBeNull()
    expect(buildDisplayAdEvent({ ...ok, action: 'cta' })).toBeNull() // not a dismiss control
    expect(buildDisplayAdEvent({ ...ok, slot: '__proto__' })).toBeNull()
    expect(buildDisplayAdEvent({ ...ok, position: 99, scope: 'forever' })?.properties).not.toHaveProperty('position')
  })

  test('parse rebuilds a wire event and cannot flip mock_creative or billable', () => {
    const built = buildDisplayAdEvent({
      kind: 'action',
      slot: 'mcpFeatured',
      surface: 'desktop',
      sponsorId: 'upstash',
      action: 'mcp_add_server',
      position: 3,
    })!
    expect(parseDisplayAdEvent(built)).toEqual(built)
    const forged = { ...built, properties: { ...built.properties, billable: true, mock_creative: false, extra: 'x' } }
    expect(parseDisplayAdEvent(forged)).toEqual(built)
    expect(parseDisplayAdEvent({ event: 'desktop.ad_clicked', properties: built.properties })).toBeNull()
  })

  test('/deals rides on the cliStatusline flag', () => {
    expect(displayAdFlagFor('deals')).toBe('cliStatusline')
    expect(displayAdFlagFor('topBanner')).toBe('topBanner')
  })
})
