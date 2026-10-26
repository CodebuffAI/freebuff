import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { servedDisplayAdToSponsor } from '@codebuff/common/ads/display-ads/served'
import { RGBA } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'

import { DisplayAdDeals } from '../display-ad-deals'
import { DisplayAdSplash } from '../display-ad-splash'
import { DisplayAdStatusline } from '../display-ad-statusline'
import { cliSponsorColors } from '../../ads/display-ads'
import { useDisplayAdsStore } from '../../ads/display-ads-store'
import { setCliDisplayAdTrackerForTests } from '../../ads/display-ads-telemetry'
import {
  setServedDisplayAdBillingForTests,
  type CliServedSponsor,
  type GetDisplayAd,
} from '../../ads/served-display-ads'
import { initializeThemeStore } from '../../hooks/use-theme'

import type { ReactNode } from 'react'

let cleanup: (() => void) | undefined
beforeAll(initializeThemeStore)

let events: string[] = []
let billed: [kind: string, impUrl: string, placementId: string][] = []
let opened: string[] = []
beforeEach(() => {
  events = []
  billed = []
  opened = []
  setCliDisplayAdTrackerForTests((event) => events.push(event))
  setServedDisplayAdBillingForTests({
    impression: (s) =>
      billed.push(['impression', s.served.impUrl, s.served.placementId]),
    click: (s) => billed.push(['click', s.served.impUrl, s.served.placementId]),
  })
})
afterEach(() => {
  setCliDisplayAdTrackerForTests()
  setServedDisplayAdBillingForTests()
  cleanup?.()
  cleanup = undefined
  useDisplayAdsStore.setState({ splashHiddenOn: null, statuslineHidden: false })
})

function served(placementId: 'CLI-Splash' | 'CLI-Statusline' | 'CLI-Deals') {
  const ad = {
    placementId,
    provider: 'first_party' as const,
    impUrl: `https://www.codebuff.com/imp/${placementId}`,
    clickUrl: `https://www.codebuff.com/click/${placementId}`,
    url: 'https://acme.dev/start',
    title: 'Ship faster with Acme',
    adText: 'Acme builds the boring parts.',
    cta: 'Try Acme',
    favicon: '',
    brandColor: '#2244aa',
    brandInk: '#ffffff',
    sponsorName: 'Acme Cloud',
  }
  return {
    ...servedDisplayAdToSponsor(ad),
    landingUrl: ad.url,
    receivedAtMs: 1,
  } satisfies CliServedSponsor
}

function fake(fill: CliServedSponsor | null) {
  const asked: string[] = []
  const get: GetDisplayAd = async (id) => {
    asked.push(id)
    return fill
  }
  return { asked, get }
}

async function mount(node: ReactNode, width = 100, height = 16) {
  const setup = await createTestRenderer({ width, height })
  const root = createRoot(setup.renderer)
  cleanup = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => root.render(node))
  await setup.renderOnce()
  // Let the served fetch resolve and its state commit.
  await Bun.sleep(5)
  await setup.renderOnce()
  return { setup, root }
}

async function settle(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  done: () => boolean,
  tries = 50,
) {
  for (let i = 0; i < tries && !done(); i++) {
    await Bun.sleep(2)
    await setup.renderOnce()
  }
}

const open = (url: string) => void opened.push(url)
const color = (value: string | RGBA) =>
  typeof value === 'string' ? RGBA.fromHex(value) : value

test('served statusline: draws the served sponsor in its brand colours, billed once on insertion', async () => {
  const fill = served('CLI-Statusline')
  const { asked, get } = fake(fill)
  const { setup } = await mount(
    <DisplayAdStatusline enabled={false} getServed={get} open={open} />,
    100,
    2,
  )
  const frame = setup.captureCharFrame()
  expect(frame).toContain('Ad │ Acme Cloud')
  expect(frame).toContain('Ship faster with Acme')
  expect(asked).toEqual(['CLI-Statusline'])

  const fillColor = color(
    cliSponsorColors(fill.theme, {
      surface: '#000000',
      foreground: '#ffffff',
      muted: '#888888',
    }).fill as string | RGBA,
  )
  const tagline = setup
    .captureSpans()
    .lines[0]!.spans.find((s) => s.text.includes('Ship faster'))!
  expect(tagline.bg.toInts()).toEqual(fillColor.toInts())

  await settle(setup, () => billed.some(([kind]) => kind === 'impression'))
  await setup.renderOnce() // another frame is not another impression
  expect(billed).toEqual([
    [
      'impression',
      'https://www.codebuff.com/imp/CLI-Statusline',
      'CLI-Statusline',
    ],
  ])

  const y = 0
  await setup.mockMouse.click(5, y)
  expect(billed.at(-1)).toEqual([
    'click',
    'https://www.codebuff.com/imp/CLI-Statusline',
    'CLI-Statusline',
  ])
  expect(opened).toEqual(['https://www.codebuff.com/click/CLI-Statusline'])
  // Served units never send the mock analytics events.
  expect(events).toEqual([])
})

test('served splash: served copy through the boxed view, billed impression and click', async () => {
  const { get } = fake(served('CLI-Splash'))
  const { setup } = await mount(
    <DisplayAdSplash
      width={68}
      variant="boxed"
      enabled={false}
      getServed={get}
      open={open}
    />,
  )
  const frame = setup.captureCharFrame()
  expect(frame).toContain('Acme Cloud')
  expect(frame).toContain('Sponsored')
  expect(frame).toContain('Ship faster with Acme')
  expect(frame).toContain('acme.dev ↗')
  await settle(setup, () => billed.some(([kind]) => kind === 'impression'))
  expect(billed).toEqual([
    ['impression', 'https://www.codebuff.com/imp/CLI-Splash', 'CLI-Splash'],
  ])
  const lines = frame.split('\n')
  const y = lines.findIndex((l) => l.includes('Acme Cloud'))
  await setup.mockMouse.click(lines[y]!.indexOf('Acme Cloud') + 1, y)
  expect(billed.at(-1)?.[0]).toBe('click')
  expect(opened).toEqual(['https://www.codebuff.com/click/CLI-Splash'])
  expect(events).toEqual([])
})

test('no fill renders nothing and bills nothing', async () => {
  const { asked, get } = fake(null)
  const { setup } = await mount(
    <DisplayAdStatusline enabled={false} getServed={get} />,
    100,
    2,
  )
  expect(setup.captureCharFrame().trim()).toBe('')
  expect(asked).toEqual(['CLI-Statusline'])
  cleanup?.()
  const splash = await mount(
    <DisplayAdSplash
      width={68}
      variant="boxed"
      enabled={false}
      getServed={get}
    />,
  )
  expect(splash.setup.captureCharFrame().trim()).toBe('')
  expect(billed).toEqual([])
})

test('hidden: nothing is requested', async () => {
  useDisplayAdsStore.setState({ statuslineHidden: true })
  const { asked, get } = fake(served('CLI-Statusline'))
  const { setup } = await mount(
    <DisplayAdStatusline enabled={false} getServed={get} />,
    100,
    2,
  )
  expect(setup.captureCharFrame().trim()).toBe('')
  expect(asked).toEqual([])
  expect(billed).toEqual([])
})

test('mock path: flag on draws the mock, never asks for or bills a served ad', async () => {
  const { asked, get } = fake(served('CLI-Statusline'))
  const { setup } = await mount(
    <DisplayAdStatusline enabled getServed={get} open={open} />,
    100,
    2,
  )
  expect(setup.captureCharFrame()).not.toContain('Acme')
  await setup.mockMouse.click(5, 0)
  cleanup?.()
  await mount(
    <DisplayAdSplash width={68} variant="boxed" enabled getServed={get} />,
  )
  expect(asked).toEqual([])
  expect(billed).toEqual([])
  expect(events).toContain('display_ads.impression')
  expect(events).toContain('display_ads.click')
})

test('served /deals card: position 1 only, billed impression on insertion, billed click', async () => {
  const fill = served('CLI-Deals')
  const { setup } = await mount(
    <DisplayAdDeals sponsors={[fill]} open={open} enabled={false} />,
    100,
    10,
  )
  const frame = setup.captureCharFrame()
  expect(frame).toContain('1')
  expect(frame).toContain('Acme Cloud')
  expect(frame.match(/Sponsored/g)?.length).toBe(1)
  await settle(setup, () => billed.some(([kind]) => kind === 'impression'))
  expect(billed).toEqual([
    ['impression', 'https://www.codebuff.com/imp/CLI-Deals', 'CLI-Deals'],
  ])
  const lines = frame.split('\n')
  const y = lines.findIndex((l) => l.includes('Open ↗'))
  await setup.mockMouse.click(lines[y]!.indexOf('Open ↗') + 1, y)
  expect(billed.at(-1)).toEqual([
    'click',
    'https://www.codebuff.com/imp/CLI-Deals',
    'CLI-Deals',
  ])
  expect(opened).toEqual(['https://www.codebuff.com/click/CLI-Deals'])
  expect(events).toEqual([])
})

test('the served row shows the /deals hint only when CLI-Deals is served', async () => {
  const { get } = fake(served('CLI-Statusline'))
  const without = await mount(
    <DisplayAdStatusline enabled={false} getServed={get} dealsLive={false} />,
    100,
    2,
  )
  expect(without.setup.captureCharFrame()).toContain('Ad │ Acme Cloud')
  expect(without.setup.captureCharFrame()).not.toContain('/deals')
  cleanup?.()
  const withDeals = await mount(
    <DisplayAdStatusline enabled={false} getServed={get} dealsLive />,
    100,
    2,
  )
  expect(withDeals.setup.captureCharFrame()).toContain('/deals')
})
