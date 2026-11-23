import { expect, test } from 'bun:test'
import { PLACEMENT_SLOTS } from '../constants/freebuff-placements'
import {
  adTargetingSurface,
  browserAdMobileDevice,
  placementSurface,
  placementSurfaceAllowed,
  placementSupportsSurfaces,
} from './placement-surfaces'

test('every catalog slot has a device surface, with web copies distinct from Desktop', () => {
  for (const slot of PLACEMENT_SLOTS)
    expect(placementSurface(slot.id)).not.toBeNull()
  expect(placementSurface('Desktop-Inline-Chat')).toBe('desktop')
  expect(placementSurface('Desktop-Inline-Chat:web')).toBe('web')
  expect(placementSurface('CLI-Chat-Inline')).toBe('cli')
  expect(placementSurface('Single-Ad-Unit-1')).toBe('cli')
  expect(placementSurface('Chat-Assistant-Above-Input')).toBe('web')
})
test('campaign targeting separates the requesting app from the placement name', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  const android = 'Mozilla/5.0 (Linux; Android 14)'
  const cases = [
    ['Above-Input-Web', 'hosted_desktop', mac, false, 'desktop'],
    ['Desktop-Below-Chat:web', 'browser', mac, false, 'web_desktop'],
    ['Above-Input-Web', 'browser', android, false, 'web_mobile'],
    ['Above-Input-Web', 'browser', mac, true, 'web_mobile'],
    ['Above-Input-Web', 'browser', undefined, false, 'web'],
    ['Above-Input-Desktop', 'native', 'Freebuff-Desktop/1.0', false, 'desktop'],
    ['Above-Input-Desktop', 'native', 'Freebuff-CLI/1.0', false, null],
    ['Above-Input-Desktop', 'browser', mac, false, null],
    ['Single-Ad-Unit-1', 'native', 'Freebuff-CLI/1.0', false, 'cli'],
    ['Inline-After-Agent-Android', 'native', android, false, 'mobile'],
    ['Above-Input-Mobile', 'browser', undefined, false, 'web_mobile'],
  ] as const
  for (const [placement, client, ua, mobile, expected] of cases) {
    const surface = adTargetingSurface(placement, client, ua, mobile)
    expect(surface).toBe(expected)
    expect(placementSurfaceAllowed(['desktop'], surface)).toBe(
      expected === 'desktop',
    )
  }
  expect(placementSurfaceAllowed(['web'], 'web_desktop')).toBe(true)
  expect(placementSurfaceAllowed(['web'], 'web_mobile')).toBe(true)
  expect(placementSurfaceAllowed(['web'], 'desktop')).toBe(false)
  expect(placementSurfaceAllowed(null, null)).toBe(true)
  expect(placementSupportsSurfaces(['desktop'], 'Above-Input-Web')).toBe(true)
  expect(
    placementSupportsSurfaces(['desktop'], 'Legacy-Inline-After-Agent-Web'),
  ).toBe(false)
  expect(browserAdMobileDevice({ userAgent: mac, maxTouchPoints: 5 })).toBe(
    true,
  )
  expect(
    browserAdMobileDevice({ userAgent: 'Windows NT 10.0', maxTouchPoints: 10 }),
  ).toBe(false)
})
