import { expect, test } from 'bun:test'
import {
  normalizeRedditAttribution,
  redditAttributionFromCookies,
  REDDIT_ATTRIBUTION_WINDOW_MS,
  withinRedditActivationWindow,
  REDDIT_ACTIVATION_WINDOW_MS,
} from './reddit-acquisition'

const now = Date.parse('2026-10-20T12:00:00Z')
test('bounded Reddit IDs survive installer serialization without renewing their capture time', () => {
  const input = {
    clickId: 'rdt-click_1',
    uuid: 'pixel-uuid',
    capturedAt: now - 1000,
  }
  expect(
    normalizeRedditAttribution(JSON.parse(JSON.stringify(input)), now),
  ).toEqual(input)
  const cookies: Record<string, string> = {
    freebuff_rdt_cid: input.clickId,
    _rdt_uuid: input.uuid,
    freebuff_rdt_captured_at: String(input.capturedAt),
  }
  expect(redditAttributionFromCookies((n) => cookies[n], now)).toEqual(input)
})
test('expired, future, oversized and malformed identifiers cannot enter the handoff', () => {
  for (const capturedAt of [now + 1, now - REDDIT_ATTRIBUTION_WINDOW_MS, NaN])
    expect(
      normalizeRedditAttribution({ clickId: 'click', capturedAt }, now),
    ).toBeUndefined()
  for (const clickId of ['x'.repeat(513), 'click?email=person', '', ' click '])
    expect(
      normalizeRedditAttribution({ clickId, capturedAt: now }, now),
    ).toBeUndefined()
})
test('activation uses the same strict seven-day account window as Meta and Google', () => {
  const at = new Date(now)
  expect(withinRedditActivationWindow(at, new Date(now - 1))).toBe(false)
  expect(withinRedditActivationWindow(at, new Date(now))).toBe(true)
  expect(
    withinRedditActivationWindow(
      at,
      new Date(now + REDDIT_ACTIVATION_WINDOW_MS - 1),
    ),
  ).toBe(true)
  expect(
    withinRedditActivationWindow(
      at,
      new Date(now + REDDIT_ACTIVATION_WINDOW_MS),
    ),
  ).toBe(false)
})
