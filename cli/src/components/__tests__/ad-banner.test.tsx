import { beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import {
  AD_CARD_HEIGHT,
  AdCard,
  adLinkNotice,
  openAdClick,
  type AdClickDeps,
  getAdDisplayLabel,
  getCardAdLayout,
  getInlineAdLayout,
  orderedRequestedAds,
} from '../ad-banner'
import { initializeThemeStore } from '../../hooks/use-theme'
import {
  getAdTerminalFocus,
  registerAdTranscriptViewport,
  resetAdSignalsForTests,
} from '../../ads/ad-signals'

beforeAll(() => {
  initializeThemeStore()
})

describe('requested waiting-room ads', () => {
  test('mount order follows the canonical request and excludes duplicates/unrequested ads', () => {
    const ads = [
      {
        placementId: 'waiting-room-2',
        impUrl: 'two',
        adText: '',
        title: '',
        cta: '',
        url: '',
        favicon: '',
        clickUrl: '',
      },
      {
        placementId: 'waiting-room-1',
        impUrl: 'one',
        adText: '',
        title: '',
        cta: '',
        url: '',
        favicon: '',
        clickUrl: '',
      },
      {
        placementId: 'waiting-room-1',
        impUrl: 'duplicate',
        adText: '',
        title: '',
        cta: '',
        url: '',
        favicon: '',
        clickUrl: '',
      },
      {
        placementId: 'waiting-room-4',
        impUrl: 'hidden',
        adText: '',
        title: '',
        cta: '',
        url: '',
        favicon: '',
        clickUrl: '',
      },
    ]
    expect(
      orderedRequestedAds(ads, ['waiting-room-1', 'waiting-room-2']).map(
        (ad) => ad.impUrl,
      ),
    ).toEqual(['one', 'two'])
  })
})

describe('card ad layout', () => {
  const ad = {
    adText:
      'Automate mobile UI testing with plain-English test steps and AI-powered execution.',
    title: 'Test every release before you ship',
    cta: 'Try free',
    url: 'https://www.drizz.dev/ios',
  }

  test('renders the headline for the creative the console asks for', () => {
    // The regression this whole function exists for: with a CTA and a landing
    // URL both set, the headline used to reach neither the CTA fallback nor
    // the destination label, so it rendered nowhere at all.
    const layout = getCardAdLayout(ad, 78)

    expect(layout.headline).toBe('Test every release before you ship')
    expect(layout.ctaText).toBe('Try free')
    expect(layout.labelText).toBe('drizz.dev')
  })

  test('gives up a description line to make room for the headline', () => {
    expect(getCardAdLayout(ad, 78).descriptionLines).toBe(1)
  })

  test('keeps both description lines when the ad has no headline', () => {
    const layout = getCardAdLayout({ ...ad, title: '' }, 78)

    expect(layout.headline).toBe('')
    expect(layout.descriptionLines).toBe(2)
  })

  test('the interior always sums to the reserved card height', () => {
    // The landing screen subtracts AD_CARD_HEIGHT from the model picker's
    // budget, so a layout that needs a row it was not given clips silently.
    for (const title of ['A headline', '']) {
      const layout = getCardAdLayout({ ...ad, title }, 78)
      const headlineRows = layout.headline ? 1 : 0
      const borderRows = 2
      const ctaRow = 1

      expect(borderRows + headlineRows + layout.descriptionLines + ctaRow).toBe(
        AD_CARD_HEIGHT,
      )
    }
  })

  test('falls back to Learn more rather than reprinting the headline', () => {
    // `ad.cta || ad.title` put the same string in two rows of a five-row card.
    expect(getCardAdLayout({ ...ad, cta: '' }, 78).ctaText).toBe('Learn more')
  })

  test('drops the destination label when it would repeat the headline', () => {
    // With no URL the label falls back to the title, which now has its own row.
    const layout = getCardAdLayout({ ...ad, url: '' }, 78)

    expect(layout.headline).toBe('Test every release before you ship')
    expect(layout.labelText).toBe('')
  })

  test('keeps the Sponsored label when there is no headline and no URL', () => {
    const layout = getCardAdLayout({ ...ad, title: '', url: '' }, 78)

    expect(layout.labelText).toBe('Sponsored')
  })

  test('survives a provider that omits fields the type says are required', () => {
    // `AdResponse` types these as required strings, but the Gravity provider
    // casts `response.json()` instead of parsing it and copies `cta: raw.cta`
    // with no default. A throw here is a throw inside AdCard's render on the
    // landing screen.
    const layout = getCardAdLayout(
      {} as Parameters<typeof getCardAdLayout>[0],
      78,
    )

    expect(layout.headline).toBe('')
    expect(layout.description).toBe('')
    expect(layout.ctaText).toBe('Learn more')
    expect(layout.labelText).toBe('Sponsored')
    expect(layout.descriptionLines).toBe(2)
  })

  test('falls back to Learn more when only the CTA is missing', () => {
    const layout = getCardAdLayout(
      { ...ad, cta: undefined } as unknown as Parameters<
        typeof getCardAdLayout
      >[0],
      78,
    )

    expect(layout.ctaText).toBe('Learn more')
    expect(layout.headline).toBe('Test every release before you ship')
  })

  test('truncates the headline to the interior width', () => {
    const layout = getCardAdLayout(
      {
        ...ad,
        title:
          'A headline considerably longer than this narrow card could ever hold',
      },
      60,
    )

    expect(layout.headline.length).toBeLessThanOrEqual(60 - 8)
    expect(layout.headline.endsWith('…')).toBe(true)
  })
})

describe('card ad render', () => {
  // getCardAdLayout being correct proves nothing on its own: the bug it fixes
  // was that the JSX never referenced the title at all. This renders a real
  // character frame, so a refactor that drops the headline row goes red here
  // rather than shipping an advertiser a field that renders nowhere.
  const ad = {
    adText: 'Automate mobile UI testing with plain-English test steps.',
    title: 'Test every release before you ship',
    cta: 'Try free',
    url: 'https://www.drizz.dev/ios',
    favicon: '',
    clickUrl: 'https://www.drizz.dev/ios?click=1',
    impUrl: 'imp-1',
  }

  const renderCard = async (
    overrides: Partial<typeof ad>,
    width = 78,
  ): Promise<string> => {
    const setup = await createTestRenderer({ width, height: AD_CARD_HEIGHT })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(<AdCard ad={{ ...ad, ...overrides }} width={width} />)
    })
    try {
      await setup.renderOnce()
      return setup.captureCharFrame()
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    }
  }

  test('draws the headline, the body, the CTA and the destination', async () => {
    const frame = await renderCard({})

    expect(frame).toContain('Test every release before you ship')
    expect(frame).toContain('Automate mobile UI testing')
    expect(frame).toContain('Try free')
    expect(frame).toContain('drizz.dev')
  })

  test('still discloses itself as an ad', async () => {
    expect(await renderCard({})).toContain('Ad')
  })

  test('reports presentation only after the card mounts', async () => {
    const presented: string[] = []
    const setup = await createTestRenderer({
      width: 78,
      height: AD_CARD_HEIGHT,
    })
    const root = createRoot(setup.renderer)
    const mountedAd = { ...ad, provider: 'first_party' as const }

    flushSync(() => {
      root.render(
        <AdCard
          ad={mountedAd}
          width={78}
          onImpression={(presentedAd) => presented.push(presentedAd.impUrl)}
        />,
      )
    })
    await setup.renderOnce()
    expect(presented).toEqual(['imp-1'])

    flushSync(() => root.unmount())
    setup.renderer.destroy()
  })

  test('does not print the headline twice when there is no CTA', async () => {
    const frame = await renderCard({ cta: '' })

    expect(frame).toContain('Test every release before you ship')
    expect(frame).toContain('Learn more')
  })

  test('renders rather than throwing when the provider omits a CTA', async () => {
    // The regression this guards: `ad.cta.trim()` threw inside render, and
    // cli/src/components/error-boundary.tsx does not catch render errors, so
    // one malformed Gravity creative took down the landing screen.
    const frame = await renderCard({
      cta: undefined,
    } as Partial<typeof ad>)

    expect(frame).toContain('Learn more')
    expect(frame).toContain('Test every release before you ship')
  })

  test('renders a title-less ad without a blank first row', async () => {
    const frame = await renderCard({ title: '' })

    expect(frame).toContain('Automate mobile UI testing')
    expect(frame).toContain('Ad')
  })
})

describe('ad banner display label', () => {
  test('uses the display domain when the ad has a URL', () => {
    expect(
      getAdDisplayLabel({
        title: 'Example Sponsor',
        url: 'https://www.example.com/path',
      }),
    ).toEqual({ text: 'example.com', variant: 'domain' })
  })

  test('uses the ad title when the ad has no URL', () => {
    expect(
      getAdDisplayLabel({
        title: 'Example Sponsor',
        url: '',
      }),
    ).toEqual({ text: 'Example Sponsor', variant: 'title' })
  })
})

describe('inline ad layout', () => {
  const ad = {
    adText:
      'Deploy frontends globally with zero config and preview every pull request.',
    title: 'Vercel',
    url: 'https://www.vercel.com/products',
  }

  test('fits the compact copy and sponsor within the card interior', () => {
    const width = 60
    const layout = getInlineAdLayout(ad, width)
    const header = `${layout.title}  Ad`
    const detail = `${layout.description}  ${layout.label} ↗`

    expect(header.length).toBeLessThanOrEqual(width - 4)
    expect(detail.length).toBeLessThanOrEqual(width - 4)
    expect(layout.title).toBe('Vercel')
    expect(layout.label).toBe('vercel.com')
    expect(layout.description.endsWith('…')).toBe(true)
  })

  test('truncates long labels without starving narrow cards', () => {
    const layout = getInlineAdLayout(
      {
        ...ad,
        url: 'https://www.extraordinarily-long-sponsor-domain.example',
      },
      48,
    )

    expect(layout.label).toBe('extraordinari…')
    expect(layout.description.length).toBeGreaterThan(0)
    expect(`${layout.title}  Ad`.length).toBeLessThanOrEqual(44)
  })

  test('prioritizes copy over the destination on very narrow cards', () => {
    const width = 47
    const layout = getInlineAdLayout(ad, width)

    expect(layout.label).toBe('')
    expect(layout.description.length).toBe(width - 4)
    expect(layout.description.endsWith('…')).toBe(true)
  })

  test('uses the full detail row when no destination domain is available', () => {
    const layout = getInlineAdLayout(
      {
        adText:
          'A network ad whose tracked destination is intentionally hidden.',
        title: 'Example Sponsor',
        url: '',
      },
      40,
    )

    expect(layout.title).toBe('Example Sponsor')
    expect(layout.label).toBe('')
    expect(layout.description.length).toBe(36)
  })
})

describe('openAdClick: a click is recorded only when a browser opened', () => {
  const clickAd = {
    url: 'https://www.drizz.dev/ios',
    clickUrl: 'https://track.example/c/abc',
  }
  function deps(over: Partial<AdClickDeps> = {}) {
    const opened: string[] = []
    const shown: string[] = []
    const d: AdClickDeps = {
      open: async (url) => {
        opened.push(url)
        return true
      },
      isRemote: () => false,
      showLink: (ad) => shown.push(adLinkNotice(ad)),
      ...over,
    }
    return { d, opened, shown }
  }

  test('records the click after the tracked link opened', async () => {
    const { d, opened, shown } = deps()
    let recorded = 0
    expect(await openAdClick(clickAd, () => recorded++, d)).toBe('opened')
    expect(opened).toEqual([clickAd.clickUrl])
    expect(recorded).toBe(1)
    expect(shown).toEqual([])
  })

  test('records nothing and shows the landing URL when opening fails', async () => {
    const { d, shown } = deps({ open: async () => false })
    let recorded = 0
    expect(await openAdClick(clickAd, () => recorded++, d)).toBe('link_shown')
    expect(recorded).toBe(0)
    expect(shown).toEqual([
      "Couldn't open a browser here. Link: https://www.drizz.dev/ios",
    ])
  })

  test('a throwing opener counts as a failed open', async () => {
    const { d } = deps({
      open: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    let recorded = 0
    expect(await openAdClick(clickAd, () => recorded++, d)).toBe('link_shown')
    expect(recorded).toBe(0)
  })

  test('under SSH it never opens and never records', async () => {
    const { d, opened, shown } = deps({ isRemote: () => true })
    let recorded = 0
    expect(await openAdClick(clickAd, () => recorded++, d)).toBe('link_shown')
    expect(opened).toEqual([])
    expect(recorded).toBe(0)
    expect(shown).toHaveLength(1)
  })

  test('prints the landing url, never the tracked click url', () => {
    expect(adLinkNotice(clickAd)).not.toContain('track.example')
    expect(adLinkNotice({ url: 'javascript:alert(1)' })).toBe(
      "Couldn't open a browser here.",
    )
  })

  test('an ad without a click url does nothing', async () => {
    const { d, opened, shown } = deps()
    expect(
      await openAdClick({ url: clickAd.url, clickUrl: '' }, () => {}, d),
    ).toBe('ignored')
    expect(opened).toEqual([])
    expect(shown).toEqual([])
  })
})

describe('inline transcript card impression', () => {
  const inlineAd = {
    adText: 'Automate mobile UI testing with plain-English steps.',
    title: 'Test every release',
    cta: 'Try free',
    url: 'https://www.drizz.dev/ios',
    favicon: '',
    clickUrl: 'test-only:click',
    impUrl: 'imp-inline-1',
  }

  test('does not fire on mount; fires after the dwell', async () => {
    // No viewport is registered here, so visibility is unknown and counts as
    // seen; the terminal never reported focus, which counts as focused.
    expect(getAdTerminalFocus()).toBeUndefined()
    const presented: string[] = []
    const setup = await createTestRenderer({ width: 60, height: 4 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <AdCard
          ad={inlineAd}
          width={60}
          variant="inline"
          onImpression={(a) => presented.push(a.impUrl)}
        />,
      )
    })
    await setup.renderOnce()
    expect(presented).toEqual([])
    await new Promise((r) => setTimeout(r, 400))
    expect(presented).toEqual([])
    await new Promise((r) => setTimeout(r, 1_000))
    expect(presented).toEqual(['imp-inline-1'])
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  })

  test('with a measurable viewport: scrolled away before 1 s, no impression; back in view for 1 s, one', async () => {
    const inView = { top: 0, bottom: 4 }
    const scrolledAway = { top: 100, bottom: 120 }
    let viewport = inView
    const unregister = registerAdTranscriptViewport(() => viewport)
    const presented: string[] = []
    const setup = await createTestRenderer({ width: 60, height: 4 })
    const root = createRoot(setup.renderer)
    try {
      flushSync(() => {
        root.render(
          <AdCard
            ad={{ ...inlineAd, impUrl: 'imp-inline-dwell' }}
            width={60}
            variant="inline"
            onImpression={(a) => presented.push(a.impUrl)}
          />,
        )
      })
      await setup.renderOnce()
      // In view for 500 ms, then scrolled away before the dwell elapsed.
      await new Promise((r) => setTimeout(r, 500))
      viewport = scrolledAway
      await new Promise((r) => setTimeout(r, 1_100))
      expect(presented).toEqual([])
      // Back in view: not before a full dwell, then exactly once.
      viewport = inView
      await new Promise((r) => setTimeout(r, 600))
      expect(presented).toEqual([])
      await new Promise((r) => setTimeout(r, 900))
      expect(presented).toEqual(['imp-inline-dwell'])
      await new Promise((r) => setTimeout(r, 600))
      expect(presented).toEqual(['imp-inline-dwell'])
    } finally {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
      unregister()
      resetAdSignalsForTests()
    }
  }, 10_000)

  test('a click before the dwell fires the impression first', async () => {
    const presented: string[] = []
    const setup = await createTestRenderer({ width: 60, height: 4 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <AdCard
          ad={inlineAd}
          width={60}
          variant="inline"
          onImpression={(a) => presented.push(a.impUrl)}
        />,
      )
    })
    await setup.renderOnce()
    expect(presented).toEqual([])
    await setup.mockMouse.click(5, 1)
    expect(presented).toEqual(['imp-inline-1'])
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  })
})
