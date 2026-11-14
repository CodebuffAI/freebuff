import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  sponsorFor,
  sponsorsFor,
} from '@codebuff/common/ads/display-ads/sponsors'

import { useDisplayAdsStore } from '../../ads/display-ads-store'
import { setCliDisplayAdTrackerForTests } from '../../ads/display-ads-telemetry'
import {
  recordServedDisplayImpression,
  resetServedDisplayAds,
  setServedDisplayAdBillingForTests,
  type CliServedSponsor,
} from '../../ads/served-display-ads'
import { servedDisplayAdToSponsor } from '@codebuff/common/ads/display-ads/served'
import {
  DEALS_HIDDEN,
  DEALS_OFF,
  DEALS_ON,
  DEALS_UNAVAILABLE,
  handleDealsCommand,
} from '../deals'

let events: { event: string; properties: Record<string, unknown> }[] = []
let billed: [
  kind: 'impression' | 'click',
  impUrl: string,
  placementId: string,
][] = []
beforeEach(() => {
  events = []
  billed = []
  setCliDisplayAdTrackerForTests((event, properties) =>
    events.push({ event, properties }),
  )
  setServedDisplayAdBillingForTests({
    impression: (s) =>
      billed.push(['impression', s.served.impUrl, s.served.placementId]),
    click: (s) => billed.push(['click', s.served.impUrl, s.served.placementId]),
  })
})
afterEach(() => {
  useDisplayAdsStore.setState({ statuslineHidden: false })
  setCliDisplayAdTrackerForTests()
  setServedDisplayAdBillingForTests()
})

const SERVED: CliServedSponsor = {
  ...servedDisplayAdToSponsor({
    placementId: 'CLI-Deals',
    provider: 'first_party',
    impUrl: 'https://www.codebuff.com/imp/deal-1',
    clickUrl: 'https://www.codebuff.com/click/deal-1',
    url: 'https://acme.dev/start',
    title: 'Ship faster with Acme',
    adText: 'Acme builds it.',
    cta: 'Try Acme',
    favicon: '',
    brandColor: '#123456',
    sponsorName: 'Acme',
  }),
  landingUrl: 'https://acme.dev/start',
  receivedAtMs: 1,
}

const opened: string[] = []
const deps = { enabled: true, open: (url: string) => opened.push(url) }

test('flagged off, /deals says nothing is available', async () => {
  expect(
    await handleDealsCommand('', { enabled: false, announced: async () => [] }),
  ).toBe(DEALS_UNAVAILABLE)
})

test('/deals prints the cards as one html block', async () => {
  const result = await handleDealsCommand('', deps)
  expect(Array.isArray(result)).toBe(true)
  expect((result as { type: string }[])[0].type).toBe('html')
})

test('/deals use <n> and /deals <n> open that offer', async () => {
  opened.length = 0
  const sponsors = sponsorsFor('deals')
  await handleDealsCommand('use 2', deps)
  await handleDealsCommand('1', deps)
  expect(opened).toEqual([sponsors[1].url, sponsors[0].url])
  expect(await handleDealsCommand('use 9', deps)).toContain('Usage:')
})

test('/deals off hides the row and list for the session; /deals on restores', async () => {
  expect(await handleDealsCommand('off', deps)).toBe(DEALS_OFF)
  expect(useDisplayAdsStore.getState().statuslineHidden).toBe(true)
  expect(await handleDealsCommand('', deps)).toBe(DEALS_HIDDEN)
  expect(await handleDealsCommand('on', deps)).toBe(DEALS_ON)
  expect(useDisplayAdsStore.getState().statuslineHidden).toBe(false)
})

test('/deals use <n> reports a click on CLI-Deals for that sponsor and position', async () => {
  const sponsors = sponsorsFor('deals')
  await handleDealsCommand('use 2', deps)
  await handleDealsCommand('use 9', deps)
  expect(events).toEqual([
    {
      event: 'display_ads.click',
      properties: {
        placement_id: 'CLI-Deals',
        slot: 'deals',
        surface: 'cli',
        sponsor_id: sponsors[1].id,
        action: 'deals_use',
        mock_creative: true,
        billable: false,
        position: 2,
      },
    },
  ])
})

test('/deals off and on report a dismiss and a restore of the CLI-Statusline row', async () => {
  const row = sponsorFor('cliStatusline')!
  await handleDealsCommand('off', deps)
  await handleDealsCommand('off', deps) // already hidden: nothing new
  await handleDealsCommand('on', deps)
  expect(
    events.map((e) => [
      e.event,
      e.properties.action,
      e.properties.placement_id,
      e.properties.sponsor_id,
    ]),
  ).toEqual([
    ['display_ads.dismiss', 'deals_off', 'CLI-Statusline', row.id],
    ['display_ads.restore', 'deals_on', 'CLI-Statusline', row.id],
  ])
})

test('flagged off, /deals sends nothing', async () => {
  const off = { ...deps, enabled: false, announced: async () => [] }
  await handleDealsCommand('use 1', off)
  await handleDealsCommand('off', off)
  expect(events).toEqual([])
})

test('the mock /deals path never calls the billed endpoints', async () => {
  await handleDealsCommand('', deps)
  await handleDealsCommand('use 1', deps)
  expect(billed).toEqual([])
})

describe('served /deals (flag off)', () => {
  const asked: string[] = []
  const served = (fill: CliServedSponsor | null, ids = ['CLI-Deals']) => ({
    enabled: false,
    open: (url: string) => opened.push(url),
    announced: async () => ids,
    getServed: async (id: string) => {
      asked.push(id)
      return fill
    },
  })
  beforeEach(() => {
    asked.length = 0
    opened.length = 0
    resetServedDisplayAds()
  })

  test('/deals use 1 on a card never printed bills nothing and prints the list', async () => {
    const result = await handleDealsCommand('use 1', served(SERVED))
    expect((result as { type: string }[])[0].type).toBe('html')
    expect(await handleDealsCommand('1', served(SERVED))).not.toContain(
      'Opening',
    )
    expect(billed).toEqual([])
    expect(opened).toEqual([])
  })

  test('nothing is requested when CLI-Deals is not announced', async () => {
    expect(await handleDealsCommand('', served(SERVED, []))).toBe(
      DEALS_UNAVAILABLE,
    )
    expect(await handleDealsCommand('use 1', served(SERVED, []))).toBe(
      DEALS_UNAVAILABLE,
    )
    expect(asked).toEqual([])
    expect(billed).toEqual([])
  })

  test('no fill: nothing available', async () => {
    expect(await handleDealsCommand('', served(null))).toBe(DEALS_UNAVAILABLE)
    expect(asked).toEqual(['CLI-Deals'])
  })

  test('a fill prints one html card block, with no analytics events', async () => {
    const result = await handleDealsCommand('', served(SERVED))
    expect((result as { type: string }[]).length).toBe(1)
    expect((result as { type: string }[])[0].type).toBe('html')
    expect(events).toEqual([])
  })

  test('/deals use 1 on a printed card records the billed click and opens the clickUrl', async () => {
    // Printing the card records its impression on insertion.
    recordServedDisplayImpression(SERVED)
    billed.length = 0
    expect(await handleDealsCommand('use 1', served(SERVED))).toContain(
      'acme.dev',
    )
    expect(billed).toEqual([
      ['click', 'https://www.codebuff.com/imp/deal-1', 'CLI-Deals'],
    ])
    expect(opened).toEqual(['https://www.codebuff.com/click/deal-1'])
    expect(await handleDealsCommand('use 2', served(SERVED))).toContain(
      'Usage:',
    )
    expect(billed.length).toBe(1)
    expect(events).toEqual([])
  })

  test('off/on stay local and send nothing', async () => {
    expect(await handleDealsCommand('off', served(SERVED))).toBe(DEALS_OFF)
    expect(await handleDealsCommand('', served(SERVED))).toBe(DEALS_HIDDEN)
    expect(await handleDealsCommand('on', served(SERVED))).toBe(DEALS_ON)
    expect(billed).toEqual([])
    expect(events).toEqual([])
  })
})
