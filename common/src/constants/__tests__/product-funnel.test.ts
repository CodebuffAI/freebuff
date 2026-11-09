import { expect, test } from 'bun:test'
import { AnalyticsEvent } from '../analytics-events'
import {
  PRODUCT_FUNNEL_EVENT,
  REFERRAL_INVITE_EMAIL_VIA,
  REFERRAL_INVITE_VIA,
  REFERRAL_PLACEMENTS,
  UNMARKED_REFERRAL_PLACEMENT,
  WELCOME_INVITE_VIA,
  isKnownReferralVia,
  productFunnelEventSchema,
  referralInviteUrl,
  referralPlacementFromVia,
  sanitizeProductFunnelCapture,
  REFERRAL_LINK_ONLY_VIA,
  FRIEND_JOINED_LIFECYCLE_VIA,
} from '../product-funnel'
import { shouldTrackAnalyticsEvent } from '../../util/analytics-sampling'

const payload = {
  product: 'cli' as const,
  flow_id: '10000000-0000-4000-8000-000000000001',
  entry_route: 'cli' as const,
  funnel_stage: 'send' as const,
  funnel_state: 'accepted' as const,
  event_version: 1 as const,
  surface: 'cli' as const,
  observer: 'cli' as const,
}

test('closed product funnel contract rejects prompt, path, auth ID and arbitrary errors', () => {
  expect(productFunnelEventSchema.safeParse(payload).success).toBe(true)
  for (const details of [
    { prompt: 'private' },
    { project_id: '/home/private' },
    { auth_flow_id: payload.flow_id },
    { reason: 'raw vendor failure' },
    { entry_account_state: 'new' },
  ])
    expect(
      productFunnelEventSchema.safeParse({ ...payload, ...details }).success,
    ).toBe(false)
})

test('hosted Desktop dimensions stay bounded and survive SDK enrichment sanitization', () => {
  const hosted = {
    ...payload, product: 'desktop', surface: 'desktop', observer: 'ui',
    originApp: 'desktop', renderer: 'web-workspace', appVersion: '1.2.3-staging.2',
    executionTarget: 'device',
  }
  expect(productFunnelEventSchema.safeParse(hosted).success).toBe(true)
  expect(sanitizeProductFunnelCapture({
    event: PRODUCT_FUNNEL_EVENT,
    properties: { ...hosted, $current_url: 'https://host/?secret=private' },
  }, 'public-token')?.properties).toEqual({ ...hosted, token: 'public-token' })
  for (const extra of [
    { appVersion: '/private/path' }, { appVersion: 'x'.repeat(65) },
    { executionTarget: 'local-path' }, { renderer: 'untrusted' },
  ]) expect(productFunnelEventSchema.safeParse({ ...hosted, ...extra }).success).toBe(false)
})

test('SDK URL and person enrichments are removed before capture or mirroring', () => {
  const event: {
    event: string
    properties: Record<string, unknown>
    [key: string]: unknown
  } = {
    event: PRODUCT_FUNNEL_EVENT,
    properties: {
      ...payload,
      distinct_id: 'opaque-device',
      $insert_id: 'insert',
      $current_url: 'https://example.invalid/?code=secret',
      $set: { email: 'private' },
    },
    $set: { url: 'private' },
    $set_once: { referrer: 'private' },
  }
  const clean = sanitizeProductFunnelCapture(event, 'phc_public-project-key')
  expect(clean?.properties).toEqual({
    ...payload,
    distinct_id: 'opaque-device',
    $insert_id: 'insert',
    token: 'phc_public-project-key',
  })
  expect(clean).not.toHaveProperty('$set')
  expect(clean).not.toHaveProperty('$set_once')
  expect(
    sanitizeProductFunnelCapture(
      { event: 'other', properties: { value: 'unchanged' } },
      'phc_public-project-key',
    ),
  ).toEqual({ event: 'other', properties: { value: 'unchanged' } })
})

test('invalid envelopes are dropped and every conversion anchor is unsampled', () => {
  expect(
    sanitizeProductFunnelCapture(
      {
        event: PRODUCT_FUNNEL_EVENT,
        properties: { ...payload, flow_id: 'not-a-uuid' },
      },
      'phc_public-project-key',
    ),
  ).toBeNull()
  for (let n = 0; n < 200; n++)
    expect(
      shouldTrackAnalyticsEvent({
        event: AnalyticsEvent.PRODUCT_FUNNEL_STEP,
        distinctId: `device-${n}`,
        properties: payload,
      }),
    ).toBe(true)
})

test('each invite placement names its links; the route accepts only email values', () => {
  expect(referralInviteUrl('https://freebuff.com', 'a b', 'sidebar')).toBe(
    'https://freebuff.com/?ref=a%20b&via=sidebar_link',
  )
  expect(REFERRAL_INVITE_EMAIL_VIA).toEqual([
    'welcome_email',
    'dock_email',
    'inline_email',
    'sidebar_email',
    'settings_email',
    'friend_joined_email',
    'settings_earn_email',
    'earn_email',
    'appearance_email',
    'desktop_settings_email',
    'cli_email',
  ])
})

test('every placement maps its link and email via back to itself; anything else is the unmarked bucket', () => {
  expect(REFERRAL_PLACEMENTS).toEqual([
    'welcome',
    ...Object.keys(REFERRAL_INVITE_VIA),
    'lifecycle_email',
    'friend_joined_lifecycle',
  ])
  expect(referralPlacementFromVia(WELCOME_INVITE_VIA.link)).toEqual({
    placement: 'welcome',
    method: 'link',
  })
  expect(referralPlacementFromVia(WELCOME_INVITE_VIA.email)).toEqual({
    placement: 'welcome',
    method: 'email',
  })
  for (const [placement, via] of Object.entries(REFERRAL_INVITE_VIA)) {
    expect(referralPlacementFromVia(via.link)).toEqual({ placement, method: 'link' })
    expect(referralPlacementFromVia(via.email)).toEqual({ placement, method: 'email' })
    expect(isKnownReferralVia(via.link)).toBe(true)
    // The builder's URL carries exactly that via.
    expect(referralInviteUrl('https://freebuff.com', 'c-1', placement as keyof typeof REFERRAL_INVITE_VIA))
      .toBe(`https://freebuff.com/?ref=c-1&via=${via.link}`)
  }
  // The link-only vias are placements of their own, always a copied link.
  for (const via of [REFERRAL_LINK_ONLY_VIA.lifecycleEmail, FRIEND_JOINED_LIFECYCLE_VIA]) {
    expect(referralPlacementFromVia(via)).toEqual({ placement: via, method: 'link' })
    expect(isKnownReferralVia(via)).toBe(true)
  }
  for (const via of [null, undefined, '', 'utm_blob', 'welcome', 42]) {
    expect(referralPlacementFromVia(via as string | null)).toEqual({
      placement: UNMARKED_REFERRAL_PLACEMENT,
      method: null,
    })
    expect(isKnownReferralVia(via)).toBe(false)
  }
})
