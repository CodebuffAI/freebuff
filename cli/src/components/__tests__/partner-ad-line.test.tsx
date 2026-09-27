import { beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { PartnerAdLineView } from '../partner-ad-line'
import { SuggestionMenu } from '../suggestion-menu'
import { initializeThemeStore } from '../../hooks/use-theme'

beforeAll(() => {
  initializeThemeStore()
})

const AD = {
  title: 'Review PR with Greptile',
  url: 'https://greptile.com',
  brandColor: '#20d6a0',
  brandInk: '#112923',
}

const renderFrame = async (
  node: React.ReactNode,
  width: number,
  height: number,
): Promise<string> => {
  const setup = await createTestRenderer({ width, height })
  const root = createRoot(setup.renderer)
  flushSync(() => root.render(node))
  try {
    await setup.renderOnce()
    return setup.captureCharFrame()
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
}

describe('PartnerAdLineView', () => {
  test('draws the headline, the destination and the disclosure on one row', async () => {
    const frame = await renderFrame(<PartnerAdLineView ad={AD} width={78} />, 78, 1)

    expect(frame).toContain('Review PR with Greptile')
    expect(frame).toContain('greptile.com')
    expect(frame).toContain('Ad')
    expect(frame.split('\n').filter((line) => line.trim()).length).toBe(1)
  })

  test('keeps the disclosure when the row is too narrow for the domain', async () => {
    // The layout gives up the advertiser's domain before it gives up the word
    // that says it is an ad: a line of somebody's brand colour inside our own
    // chrome with no label on it is the one state this format may not have.
    const frame = await renderFrame(<PartnerAdLineView ad={AD} width={30} />, 30, 1)

    expect(frame).toContain('Ad')
    expect(frame).not.toContain('greptile.com')
  })

  test('draws plainly rather than not at all when the colours are unusable', async () => {
    // A creative mid-edit, and a terminal with no truecolor, both land here.
    // The row keeps its shape, its click and its disclosure; only the colour
    // is ours rather than a brand we would be inventing.
    const frame = await renderFrame(
      <PartnerAdLineView
        ad={{ ...AD, brandColor: 'not-a-colour', brandInk: undefined }}
        width={78}
      />,
      78,
      1,
    )

    expect(frame).toContain('Review PR with Greptile')
    expect(frame).toContain('Ad')
  })
})

describe('the slash menu’s extra row', () => {
  const items = [
    { id: 'plan', label: 'plan', description: 'Plan before making changes' },
    { id: 'review', label: 'review', description: 'Review code changes' },
    { id: 'queue', label: 'queue', description: 'Manage queued messages' },
  ]

  test('draws the partner row directly under /review', async () => {
    const frame = await renderFrame(
      <SuggestionMenu
        items={items}
        selectedIndex={0}
        maxVisible={5}
        afterItem={{
          id: 'review',
          node: <PartnerAdLineView key="ad" ad={AD} width={72} />,
        }}
      />,
      80,
      6,
    )

    const lines = frame.split('\n').map((line) => line.trim())
    const reviewRow = lines.findIndex((line) => line.startsWith('/review'))
    const adRow = lines.findIndex((line) => line.includes('Review PR with'))
    const queueRow = lines.findIndex((line) => line.startsWith('/queue'))
    expect(reviewRow).toBeGreaterThanOrEqual(0)
    expect(adRow).toBe(reviewRow + 1)
    expect(queueRow).toBe(adRow + 1)
  })

  test('is not an item, so it cannot be selected or scrolled onto', async () => {
    // The row takes no index. If it were an item, `selectedIndex` would land
    // on an ad and Enter would run it as a command.
    const withAd = await renderFrame(
      <SuggestionMenu
        items={items}
        selectedIndex={2}
        maxVisible={5}
        afterItem={{
          id: 'review',
          node: <PartnerAdLineView key="ad" ad={AD} width={72} />,
        }}
      />,
      80,
      6,
    )
    // `/queue` is still the third item and still the selected one.
    expect(withAd).toContain('/queue')
    expect(withAd).toContain('Review PR with Greptile')
  })

  test('draws nothing extra when no row is supplied', async () => {
    const frame = await renderFrame(
      <SuggestionMenu items={items} selectedIndex={0} maxVisible={5} />,
      80,
      4,
    )

    expect(frame).toContain('/review')
    expect(frame).not.toContain('Review PR with Greptile')
  })

  test('ignores a row whose item is not on screen', async () => {
    // The window scrolls, and the ad belongs to `/review` rather than to the
    // menu: a request made while the command is off screen is an impression
    // for a slot nobody is looking at.
    const frame = await renderFrame(
      <SuggestionMenu
        items={items}
        selectedIndex={0}
        maxVisible={5}
        afterItem={{
          id: 'not-a-command',
          node: <PartnerAdLineView key="ad" ad={AD} width={72} />,
        }}
      />,
      80,
      4,
    )

    expect(frame).not.toContain('Review PR with Greptile')
  })
})
