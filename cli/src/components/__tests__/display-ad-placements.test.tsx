import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { sponsorFor, sponsorsFor } from '@codebuff/common/ads/display-ads/sponsors'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'

import { DisplayAdDeals, DEALS_FOOTER_HINT } from '../display-ad-deals'
import {
  DisplayAdSplash,
  displayAdSplashVariant,
  SPLASH_BOXED_MIN_ROWS,
} from '../display-ad-splash'
import { DisplayAdStatusline } from '../display-ad-statusline'
import { useDisplayAdsStore } from '../../ads/display-ads-store'
import { setCliDisplayAdTrackerForTests } from '../../ads/display-ads-telemetry'
import { initializeThemeStore } from '../../hooks/use-theme'

import type { ReactNode } from 'react'

let cleanup: (() => void) | undefined
beforeAll(initializeThemeStore)
let events: { event: string; properties: Record<string, unknown> }[] = []
beforeEach(() => {
  events = []
  setCliDisplayAdTrackerForTests((event, properties) => events.push({ event, properties }))
})
afterEach(() => {
  setCliDisplayAdTrackerForTests()
  cleanup?.()
  cleanup = undefined
  useDisplayAdsStore.setState({ splashHiddenOn: null, statuslineHidden: false })
})

async function mount(node: ReactNode, width = 100, height = 16) {
  const setup = await createTestRenderer({ width, height })
  const root = createRoot(setup.renderer)
  cleanup = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() => root.render(node))
  await setup.renderOnce()
  return { setup, root }
}

async function frameOf(node: ReactNode, width = 100, height = 16) {
  const { setup } = await mount(node, width, height)
  return setup.captureCharFrame()
}

const impressions = () =>
  events
    .filter((e) => e.event === 'display_ads.impression')
    .map((e) => [e.properties.placement_id, e.properties.sponsor_id, e.properties.position ?? null])

const splash = sponsorFor('cliSplash')!
const statusline = sponsorFor('cliStatusline')!

test('the boxed splash shows band, disclosure, copy, CTA and hide', async () => {
  const frame = await frameOf(
    <DisplayAdSplash width={68} variant="boxed" enabled />,
  )
  expect(frame).toContain(splash.name)
  expect(frame).toContain('Sponsored')
  expect(frame).toContain(splash.copy.headline)
  expect(frame).toContain(`${splash.domain} ↗`)
  expect(frame).toContain('hide for today')
})

test('the one-line splash keeps its disclosure and hide control', async () => {
  const frame = await frameOf(
    <DisplayAdSplash width={68} variant="line" enabled />,
  )
  expect(frame).toContain(`Sponsored │ ${splash.name}`)
  expect(frame).toContain('hide for today')
  expect(frame).not.toContain('·')
})

test('short terminals get the one-line splash', () => {
  expect(displayAdSplashVariant(SPLASH_BOXED_MIN_ROWS - 1)).toBe('line')
  expect(displayAdSplashVariant(SPLASH_BOXED_MIN_ROWS)).toBe('boxed')
})

test('the splash draws nothing when flagged off or hidden today', async () => {
  expect(
    (
      await frameOf(
        <DisplayAdSplash width={68} variant="boxed" enabled={false} />,
      )
    ).trim(),
  ).toBe('')
  cleanup?.()
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  useDisplayAdsStore.setState({
    splashHiddenOn: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
  })
  expect(
    (
      await frameOf(<DisplayAdSplash width={68} variant="boxed" enabled />)
    ).trim(),
  ).toBe('')
})

test('the statusline row has the chip, tagline, /deals hint and ×', async () => {
  const frame = await frameOf(<DisplayAdStatusline enabled />, 100, 2)
  expect(frame).toContain(`Ad │ ${statusline.name}`)
  expect(frame).toContain(statusline.copy.tagline)
  expect(frame).toContain('/deals')
  expect(frame).toContain('×')
})

test('a narrow statusline gives up the tagline before the disclosure', async () => {
  const frame = await frameOf(<DisplayAdStatusline enabled />, 30, 2)
  expect(frame).toContain(`Ad │ ${statusline.name}`)
  expect(frame).toContain('×')
})

test('hiding the statusline for the session removes it', async () => {
  useDisplayAdsStore.setState({ statuslineHidden: true })
  expect((await frameOf(<DisplayAdStatusline enabled />, 100, 2)).trim()).toBe(
    '',
  )
})

test('/deals cards show every lineup sponsor with its disclosure and CTA', async () => {
  const frame = await frameOf(<DisplayAdDeals open={() => {}} />, 100, 20)
  for (const name of ['Upstash', 'Neon', 'Clerk']) expect(frame).toContain(name)
  expect(frame.match(/Sponsored/g)?.length).toBe(3)
  expect(frame.match(/Open ↗/g)?.length).toBe(3)
  expect(frame).toContain(DEALS_FOOTER_HINT)
})

test('each unit reports one insertion impression per mount, with its placement id', async () => {
  const { setup } = await mount(<DisplayAdStatusline enabled />, 100, 2)
  await setup.renderOnce() // another frame is not another impression
  expect(impressions()).toEqual([['CLI-Statusline', statusline.id, null]])
  expect(events[0]!.properties).toMatchObject({
    surface: 'cli',
    viewability: 'insertion',
    mock_creative: true,
    billable: false,
  })
  cleanup?.()

  events = []
  await frameOf(<DisplayAdSplash width={68} variant="boxed" enabled />)
  expect(impressions()).toEqual([['CLI-Splash', splash.id, null]])
  cleanup?.()

  events = []
  await frameOf(<DisplayAdDeals open={() => {}} enabled />, 100, 20)
  expect(impressions()).toEqual(
    sponsorsFor('deals').map((s, i) => ['CLI-Deals', s.id, i + 1]),
  )
})

test('no impression while flagged off or hidden', async () => {
  await frameOf(<DisplayAdSplash width={68} variant="boxed" enabled={false} />)
  cleanup?.()
  useDisplayAdsStore.setState({ statuslineHidden: true })
  await frameOf(<DisplayAdStatusline enabled />, 100, 2)
  cleanup?.()
  await frameOf(<DisplayAdDeals open={() => {}} enabled={false} />, 100, 20)
  expect(events).toEqual([])
})
