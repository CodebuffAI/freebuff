import { beforeEach, expect, test } from 'bun:test'

import { noteAdDrawn, resetAdExpiryClock } from '../ad-expiry-clock'
import { buildAdAuctionRequest } from '../ad-request'
import {
  DISPLAY_AD_TTL_MS,
  displayAuctionParams,
  getDisplayAd,
  resetServedDisplayAds,
  servedSponsorAdResponse,
  type DisplayAdDeps,
} from '../served-display-ads'
import { policyPlacementIds } from '../../hooks/use-dock-panel'

const FILL = {
  placementId: 'CLI-Statusline',
  impUrl: 'https://www.codebuff.com/imp/1',
  clickUrl: 'https://www.codebuff.com/click/1',
  url: 'https://acme.dev/start',
  title: 'Ship faster \u001b[31mwith Acme',
  adText: 'Acme builds it.',
  cta: 'Try Acme',
  favicon: 'https://acme.dev/logo.png',
  brandColor: '#2244aa',
  brandInk: '#ffffff',
  sponsorName: 'Acme Cloud',
}

function harness(
  overrides: Partial<DisplayAdDeps> & {
    body?: () => { ads?: unknown[]; provider?: unknown } | null
  } = {},
) {
  let clock = 1_000_000
  const asked: string[] = []
  const deps: DisplayAdDeps = {
    adsEnabled: () => true,
    authToken: () => 'token-a',
    announcedPlacements: async () => ['CLI-Statusline', 'CLI-Splash'],
    fetchAuction: async (placementId) => {
      asked.push(placementId)
      return overrides.body
        ? overrides.body()
        : { ads: [FILL], provider: 'first_party' }
    },
    now: () => clock,
    ...overrides,
  }
  return { deps, asked, tick: (ms: number) => (clock += ms) }
}

beforeEach(() => {
  resetServedDisplayAds()
  resetAdExpiryClock()
})

test('a held fill that expired on screen is not served again', async () => {
  const h = harness()
  await getDisplayAd('CLI-Statusline', h.deps)
  noteAdDrawn(FILL.impUrl, Date.now() - 6 * 60_000)
  await getDisplayAd('CLI-Statusline', h.deps)
  expect(h.asked).toEqual(['CLI-Statusline', 'CLI-Statusline'])
})

test('the auction asks for this placement on cli_chat with no sponsored route', async () => {
  expect(displayAuctionParams('CLI-Splash')).toEqual({
    surface: 'cli_chat',
    placementId: 'CLI-Splash',
    allowSponsoredRoute: false,
  })
  // The real builder accepts it (null only for a signed-out test process).
  await buildAdAuctionRequest(displayAuctionParams('CLI-Splash'))
})

test('a fill maps to a served sponsor: brand colours, sanitized copy, tracking', async () => {
  const h = harness()
  const sponsor = (await getDisplayAd('CLI-Statusline', h.deps))!
  expect(sponsor.name).toBe('Acme Cloud')
  expect(sponsor.domain).toBe('acme.dev')
  expect(sponsor.url).toBe(FILL.clickUrl)
  expect(sponsor.colors).toEqual({ fill: '#2244aa', ink: '#ffffff' })
  expect(sponsor.copy.headline).not.toContain('\u001b')
  expect(sponsor.logoUrl).toBe(FILL.favicon)
  expect(sponsor.served).toEqual({
    placementId: 'CLI-Statusline',
    provider: 'first_party',
    impUrl: FILL.impUrl,
    clickUrl: FILL.clickUrl,
  })
  expect(servedSponsorAdResponse(sponsor)).toMatchObject({
    impUrl: FILL.impUrl,
    clickUrl: FILL.clickUrl,
    url: FILL.url,
    provider: 'first_party',
    placementId: 'CLI-Statusline',
    receivedAtMs: 1_000_000,
  })
})

test('nothing is requested when the policy did not announce the id', async () => {
  const h = harness({ announcedPlacements: async () => ['CLI-Splash'] })
  expect(await getDisplayAd('CLI-Statusline', h.deps)).toBeNull()
  expect(h.asked).toEqual([])
})

test('nothing is requested with ads off, signed out, or a non-display id', async () => {
  const off = harness({ adsEnabled: () => false })
  expect(await getDisplayAd('CLI-Statusline', off.deps)).toBeNull()
  const out = harness({ authToken: () => null })
  expect(await getDisplayAd('CLI-Statusline', out.deps)).toBeNull()
  const other = harness({ announcedPlacements: async () => ['CLI-Other'] })
  expect(await getDisplayAd('CLI-Other', other.deps)).toBeNull()
  expect([...off.asked, ...out.asked, ...other.asked]).toEqual([])
})

test('no fill, a foreign provider, another placement or no impUrl: null', async () => {
  const bodies = [
    null,
    { ads: [] },
    { ads: [FILL], provider: 'gravity' },
    { ads: [{ ...FILL, placementId: 'CLI-Splash' }], provider: 'first_party' },
    { ads: [{ ...FILL, impUrl: '' }], provider: 'first_party' },
  ]
  for (const body of bodies) {
    resetServedDisplayAds()
    const h = harness({ body: () => body })
    expect(await getDisplayAd('CLI-Statusline', h.deps)).toBeNull()
  }
})

test('one answer per placement is held for the TTL, a no-fill too', async () => {
  const h = harness()
  const first = await getDisplayAd('CLI-Statusline', h.deps)
  expect(await getDisplayAd('CLI-Statusline', h.deps)).toBe(first)
  h.tick(DISPLAY_AD_TTL_MS)
  await getDisplayAd('CLI-Statusline', h.deps)
  expect(h.asked).toEqual(['CLI-Statusline', 'CLI-Statusline'])

  resetServedDisplayAds()
  const empty = harness({ body: () => ({ ads: [] }) })
  await getDisplayAd('CLI-Splash', empty.deps)
  await getDisplayAd('CLI-Splash', empty.deps)
  expect(empty.asked).toEqual(['CLI-Splash'])
})

test('concurrent askers share one request; an account change drops the hold', async () => {
  const h = harness()
  await Promise.all([
    getDisplayAd('CLI-Splash', h.deps),
    getDisplayAd('CLI-Splash', h.deps),
  ])
  expect(h.asked).toEqual(['CLI-Splash'])
  await getDisplayAd('CLI-Splash', { ...h.deps, authToken: () => 'token-b' })
  expect(h.asked).toEqual(['CLI-Splash', 'CLI-Splash'])
})

test('the policy display list keeps non-empty strings and fails to empty', () => {
  expect(policyPlacementIds(['CLI-Splash', '', 3, 'CLI-Deals'])).toEqual([
    'CLI-Splash',
    'CLI-Deals',
  ])
  expect(policyPlacementIds(undefined)).toEqual([])
  expect(policyPlacementIds('CLI-Splash')).toEqual([])
})
