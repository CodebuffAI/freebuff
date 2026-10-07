import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { RGBA, TextAttributes } from '@opentui/core'
import { greptileTerminalColors } from '../../ads/partner-brand'
import { AdCard } from '../ad-banner'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { createEngagementRegistry } from '../../ads/ad-engagement'
import { setAdEngagementRegistryForTests } from '../../ads/use-ad-engagement'
import { PartnerAdLineView, PartnerAdRow } from '../partner-ad-line'
import { SuggestionMenu } from '../suggestion-menu'
import { initializeThemeStore } from '../../hooks/use-theme'

import type { AdEngagement } from '@codebuff/common/types/ad-client-context'

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  setAdEngagementRegistryForTests(null)
})

const AD = {
  partnerBrand: 'greptile' as const,
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

  test('keeps the copy and disclosure when the colours are unusable', async () => {
    // Invalid colours do not remove the row. Greptile retains its indexed
    // green fallback; non-partner creatives keep the terminal theme.
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

describe('selectable partner menu row', () => {
  const items = [
    { id: 'plan', label: 'plan', description: 'Plan before making changes' },
    { id: 'review', label: 'review', description: 'Review code changes' },
    { id: 'partner:review', label: '', description: '',
      render: (selected: boolean, width: number) => <PartnerAdLineView ad={AD} width={width} selected={selected} /> },
    { id: 'queue', label: 'queue', description: 'Manage queued messages' },
  ]
  test('the ad occupies the position between review and queue and shows its selection', async () => {
    const frame = await renderFrame(<SuggestionMenu items={items} selectedIndex={2} maxVisible={5} />, 80, 6)
    const lines = frame.split('\n').map((line) => line.trim())
    const review = lines.findIndex((line) => line.startsWith('/review'))
    expect(lines[review + 1]).toStartWith('› Review PR with Greptile')
    expect(lines[review + 2]).toStartWith('/queue')
    const next = await renderFrame(<SuggestionMenu items={items} selectedIndex={3} maxVisible={1} />, 80, 2)
    expect(next).toContain('/queue')
    expect(next).not.toContain('Greptile')
    const adOnly = await renderFrame(<SuggestionMenu items={items} selectedIndex={2} maxVisible={1} />, 80, 2)
    expect(adOnly).toContain('› Review PR with Greptile')
  })
})

test('Greptile paints the row and ordinary card green with dark ink', async () => {
  const setup = await createTestRenderer({ width: 78, height: 7 })
  const root = createRoot(setup.renderer)
  const fill = { ...AD, adText: 'Ship reviewed code', cta: 'Review', favicon: '', impUrl: '', clickUrl: '' }
  flushSync(() => root.render(<box flexDirection="column">
    <PartnerAdLineView ad={AD} width={78} />
    <AdCard ad={fill} width={78} />
  </box>))
  try {
    await setup.renderOnce()
    const lines = setup.captureSpans().lines
    const palette = greptileTerminalColors(AD)!
    const color = (value: string | RGBA) => typeof value === 'string' ? RGBA.fromHex(value) : value
    for (const row of [0, 2]) {
      const text = lines[row]!.spans.find((span) => span.text.includes('Review PR'))!
      expect(text).toBeDefined()
      expect(text.bg.toInts()).toEqual(color(palette.background).toInts())
      expect(text.fg.toInts()).toEqual(color(palette.ink).toInts())
      expect(text.attributes & TextAttributes.BOLD).toBeTruthy()
    }
    // Includes padding: a full-width band, not a green label on a black row.
    expect(lines[0]!.spans.every((span) => span.bg.toInts().join() === color(palette.background).toInts().join())).toBe(true)
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
})

test('only Greptile gets ordinary branding, with explicit indexed fallback', () => {
  expect(greptileTerminalColors({ ...AD, partnerBrand: undefined }, true)).toBeNull()
  expect(greptileTerminalColors(AD, true)).toEqual({ background: AD.brandColor, ink: AD.brandInk })
  const indexed = greptileTerminalColors(AD, false)!
  expect((indexed.background as RGBA).intent).toBe('indexed')
  expect((indexed.background as RGBA).slot).toBe(48)
  expect((indexed.ink as RGBA).slot).toBe(16)
})

describe('PartnerAdRow engagement (COD-757)', () => {
  const FILL = {
    ...AD,
    adText: '',
    cta: '',
    favicon: '',
    // Not http(s): even the default opener would refuse it.
    clickUrl: 'test-only:partner-click',
    impUrl: 'imp-partner-1',
    provider: 'first_party' as const,
    placementId: 'CLI-Partner-Slash-Review',
  }

  test('a served partner row reports its exposure, hover and click', async () => {
    let now = 0
    const sent: AdEngagement[] = []
    const pending: Array<() => void> = []
    setAdEngagementRegistryForTests(
      createEngagementRegistry({
        now: () => now,
        send: (record) => sent.push(record),
        focus: () => ({ supported: false, focused: null }),
        setTimer: (fn) => {
          pending.push(fn)
          return pending.length
        },
        clearTimer: () => {},
      }),
    )
    const reported: string[] = []
    const opened: string[] = []
    const width = 60
    const setup = await createTestRenderer({ width, height: 1 })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(
        <PartnerAdRow
          ad={FILL}
          width={width}
          reportClick={(ad) => reported.push(ad.impUrl)}
          open={(url) => opened.push(url)}
        />,
      )
    })
    await setup.renderOnce()

    now += 800
    await setup.mockMouse.moveTo(4, 0)
    now += 200
    await setup.mockMouse.click(4, 0)
    await setup.mockMouse.moveTo(4, 5)
    await Promise.resolve()
    now += 1_000
    flushSync(() => root.unmount())
    setup.renderer.destroy()
    for (const fn of pending.splice(0)) fn()

    expect(reported).toEqual(['imp-partner-1'])
    expect(opened).toEqual(['test-only:partner-click'])
    const final = sent.at(-1)!
    expect(final).toMatchObject({
      v: 1,
      impUrl: 'imp-partner-1',
      exit: 'unmount',
      visibleAtMs: 0,
      visibleMs: 2_000,
      hoverCount: 1,
      firstHoverMs: 800,
      truncated: false,
      click: { msSinceMount: 1_000, pointerMovedOver: true, count: 1 },
    })
  })
})
