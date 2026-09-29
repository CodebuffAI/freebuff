import { beforeEach, describe, expect, test } from 'bun:test'

import { buildAdAuctionRequest } from '../ad-request'
import {
  CLI_PARTNER_PLACEMENT_IDS,
  getPartnerAd,
  PARTNER_AD_TTL_MS,
  partnerAuctionParams,
  resetPartnerAds,
  type PartnerAdDeps,
} from '../partner-ads'

import type { AdResponse } from '../../hooks/use-gravity-ad'

const PLACEMENT = CLI_PARTNER_PLACEMENT_IDS.composer

const FILL: AdResponse = {
  adText: 'Ship reviewed code.',
  title: 'Review PR with Greptile',
  cta: 'Review',
  url: 'https://greptile.com',
  favicon: '',
  clickUrl: 'https://greptile.com?click=1',
  impUrl: 'imp-partner-1',
  brandColor: '#20d6a0',
  brandInk: '#112923',
}

/**
 * A harness rather than module mocks, per `docs/testing.md`: everything worth
 * asserting about this module is a timing or an ordering rule, and both need
 * a clock and a request count the test controls.
 */
function harness(
  overrides: Partial<PartnerAdDeps> & {
    body?: () => {
      ads?: AdResponse[]
      provider?: AdResponse['provider']
    } | null
  } = {},
) {
  let clock = 1_000_000
  const asked: string[] = []
  const deps: PartnerAdDeps = {
    adsEnabled: () => true,
    authToken: () => 'token-a',
    announcedPlacements: async () => [PLACEMENT],
    fetchAuction: async (placementId) => {
      asked.push(placementId)
      return overrides.body
        ? overrides.body()
        : { ads: [FILL], provider: 'first_party' }
    },
    now: () => clock,
    ...overrides,
  }
  return {
    deps,
    asked,
    advance: (ms: number) => {
      clock += ms
    },
    get: () => getPartnerAd(PLACEMENT, deps),
  }
}

beforeEach(() => {
  resetPartnerAds()
})

describe('the hold', () => {
  test('one answer per placement, for the whole window', async () => {
    // The composer row remounts on a keystroke and the slash row on every
    // open of the menu. Auctioning per mount would make the CPM meter a
    // function of how often somebody types.
    const h = harness()

    expect(await h.get()).toMatchObject({ impUrl: 'imp-partner-1' })
    h.advance(PARTNER_AD_TTL_MS - 1)
    expect(await h.get()).toMatchObject({ impUrl: 'imp-partner-1' })
    expect(h.asked).toEqual([PLACEMENT])
  })

  test('re-auctions once the window is over', async () => {
    // The TTL is why the hold is not for the whole session: a held fill is a
    // creative frozen at fetch time, and a paused campaign has to stop
    // showing within one work break.
    const h = harness()

    await h.get()
    h.advance(PARTNER_AD_TTL_MS)
    await h.get()
    expect(h.asked).toEqual([PLACEMENT, PLACEMENT])
  })

  test('holds a no-fill exactly as firmly as a fill', async () => {
    // Otherwise the slot the deal is paced out of re-auctions on every
    // keystroke: the busiest slot in the app asking hardest precisely when
    // there is nothing to give it.
    const h = harness({ body: () => ({ ads: [] }) })

    expect(await h.get()).toBeNull()
    expect(await h.get()).toBeNull()
    expect(h.asked).toEqual([PLACEMENT])
  })

  test('collapses concurrent asks into one auction', async () => {
    // Both rows can mount in the same frame, and each mount is an ask.
    const h = harness()

    const [first, second] = await Promise.all([h.get(), h.get()])
    expect(first).toEqual(second)
    expect(h.asked).toEqual([PLACEMENT])
  })
})

describe('the refusals', () => {
  test('never asks when the policy named no partner slot', async () => {
    // While the deal is off the policy is empty, so no shipping client makes
    // a request to be refused.
    const h = harness({ announcedPlacements: async () => [] })

    expect(await h.get()).toBeNull()
    expect(h.asked).toEqual([])
  })

  test('never asks with ads off, or with no credentials', async () => {
    const adsOff = harness({ adsEnabled: () => false })
    expect(await adsOff.get()).toBeNull()
    expect(adsOff.asked).toEqual([])

    const signedOut = harness({ authToken: () => null })
    expect(await signedOut.get()).toBeNull()
    expect(signedOut.asked).toEqual([])
  })

  test('refuses a fill with no impression token', async () => {
    // An ad that cannot be acknowledged cannot be billed, and an unbillable
    // partner impression is one we would be giving away.
    const h = harness({
      body: () => ({ ads: [{ ...FILL, impUrl: '' }], provider: 'first_party' }),
    })

    expect(await h.get()).toBeNull()
  })

  test('refuses a fill from anyone but our own CPM leg', async () => {
    // The client-side echo of `dropForeignPartnerFills`. Somebody else's ad
    // in this advertiser's colours is the one thing this format may not draw.
    for (const provider of ['gravity', 'carbon', 'zeroclick'] as const) {
      const h = harness({ body: () => ({ ads: [FILL], provider }) })
      expect([provider, await h.get()]).toEqual([provider, null])
    }
  })

  test('an auction that throws is an ad that is not there', async () => {
    const h = harness({
      fetchAuction: async () => {
        throw new Error('network')
      },
    })

    expect(await h.get()).toBeNull()
  })
})

describe('the cache owner', () => {
  test('a different account drops the previous one’s held fill', async () => {
    // A held fill is one account's answer. Drawn to whoever signed in next
    // inside the same half hour, it would be the previous account's data.
    let token = 'token-a'
    const h = harness({ authToken: () => token })

    expect(await h.get()).toMatchObject({ impUrl: 'imp-partner-1' })
    token = 'token-b'
    await h.get()
    expect(h.asked).toEqual([PLACEMENT, PLACEMENT])
  })

  test('the first account of a process keeps its answer', async () => {
    // Adopting an owner is not a change of owner: resetting on the first ask
    // would also drop the policy the dock hook had just resolved.
    const h = harness()

    await h.get()
    await h.get()
    expect(h.asked).toEqual([PLACEMENT])
  })
})

describe('the request', () => {
  test('is a body the CLI rail accepts', async () => {
    // `/api/v1/ads` takes `provider` from the paid networks only and answers
    // anything else with a 400, which would leave every partner slot dark.
    const saved = process.env.CODEBUFF_API_KEY
    process.env.CODEBUFF_API_KEY = saved || 'test-key'
    try {
      const built = await buildAdAuctionRequest(partnerAuctionParams(PLACEMENT))
      const body = JSON.parse(String(built?.init.body))
      expect(built?.url.endsWith('/api/v1/ads')).toBe(true)
      expect(body.provider).toBeUndefined()
      expect(body).toMatchObject({
        surface: 'cli_chat',
        placementId: PLACEMENT,
      })
    } finally {
      if (saved === undefined) delete process.env.CODEBUFF_API_KEY
      else process.env.CODEBUFF_API_KEY = saved
    }
  })
})

describe('advertiser text reaching the terminal', () => {
  test('escape sequences and controls are stripped from every field', async () => {
    const ESC = '\x1b'
    const h = harness({
      body: () => ({
        ads: [
          {
            ...FILL,
            title: `Review PR${ESC}]52;c;Y3VybCBldmlsIHwgc2g=\x07 with Greptile`,
            adText: `${ESC}[2J${ESC}[HShip ${ESC}]8;;https://evil.example${ESC}\\reviewed${ESC}]8;;${ESC}\\ code.`,
            cta: `Review\x9b1A`,
          },
        ],
        provider: 'first_party',
      }),
    })

    const ad = await h.get()
    expect(ad).toMatchObject({
      title: 'Review PR with Greptile',
      adText: 'Ship reviewed code.',
      cta: 'Review',
      clickUrl: 'https://greptile.com?click=1',
      impUrl: 'imp-partner-1',
    })
    expect(JSON.stringify(ad)).not.toContain('\\u001b')
  })
})
