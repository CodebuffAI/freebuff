import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { createEngagementRegistry } from '../../ads/ad-engagement'
import { setAdEngagementRegistryForTests } from '../../ads/use-ad-engagement'
import { initializeThemeStore } from '../../hooks/use-theme'
import { AD_CARD_HEIGHT, AdCard } from '../ad-banner'

import type { AdEngagement } from '@codebuff/common/types/ad-client-context'

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  setAdEngagementRegistryForTests(null)
})

const ad = {
  adText:
    'Automate mobile UI testing with plain-English test steps and AI-powered execution.',
  title: 'Test every release before you ship',
  cta: 'Try free',
  url: 'https://www.drizz.dev/ios',
  favicon: '',
  // Not http(s): `safeOpen` refuses it, so a test click opens nothing.
  clickUrl: 'test-only:click',
  impUrl: 'imp-card-1',
}

function fakeRegistry() {
  let now = 0
  const sent: AdEngagement[] = []
  const pending: Array<() => void> = []
  const registry = createEngagementRegistry({
    now: () => now,
    send: (record) => sent.push(record),
    focus: () => ({ supported: false, focused: null }),
    setTimer: (fn) => {
      pending.push(fn)
      return pending.length
    },
    clearTimer: () => {},
  })
  setAdEngagementRegistryForTests(registry)
  return {
    sent,
    advance: (ms: number) => {
      now += ms
    },
    runTimers: () => {
      for (const fn of pending.splice(0)) fn()
    },
  }
}

describe('AdCard engagement', () => {
  test('one record per impression, with hover, click and truncation', async () => {
    const fake = fakeRegistry()
    const width = 40
    const setup = await createTestRenderer({ width, height: AD_CARD_HEIGHT })
    const root = createRoot(setup.renderer)
    const clicked: string[] = []
    // A state update, not a second `root.render`: OpenTUI's `render` builds a
    // fresh container each call, which is a remount the app never does.
    let rerender: () => void = () => {}
    const Host = () => {
      const [copy, setCopy] = React.useState(ad)
      rerender = () => setCopy({ ...ad })
      return (
        <AdCard
          ad={copy}
          width={width}
          onClick={(a) => clicked.push(a.impUrl)}
        />
      )
    }
    flushSync(() => {
      root.render(<Host />)
    })
    await setup.renderOnce()

    fake.advance(1_000)
    await setup.mockMouse.moveTo(5, 2)
    fake.advance(400)
    await setup.mockMouse.click(5, 2)
    await setup.mockMouse.moveTo(5, AD_CARD_HEIGHT + 5)
    await Promise.resolve()
    fake.advance(600)

    // a re-render with the same ad is not a new impression
    flushSync(() => rerender())
    flushSync(() => root.unmount())
    setup.renderer.destroy()
    expect(fake.sent).toHaveLength(0)
    fake.runTimers()

    expect(clicked).toEqual(['imp-card-1'])
    expect(fake.sent).toHaveLength(1)
    const record = fake.sent[0]!
    expect(record).toMatchObject({
      v: 1,
      impUrl: 'imp-card-1',
      exit: 'unmount',
      visibleAtMs: 0,
      visibleMs: 2_000,
      hoverCount: 1,
      firstHoverMs: 1_000,
      truncated: true,
    })
    expect(record.click).toMatchObject({
      msSinceMount: 1_400,
      pointerMovedOver: true,
      count: 1,
    })
    expect(record.mrc50).toBeUndefined()
    expect(record.focusedVisibleMs).toBeUndefined()
  })

  test('a wide card that fits says it was not truncated', async () => {
    const fake = fakeRegistry()
    const width = 200
    const setup = await createTestRenderer({ width, height: AD_CARD_HEIGHT })
    const root = createRoot(setup.renderer)
    flushSync(() => {
      root.render(<AdCard ad={ad} width={width} />)
    })
    await setup.renderOnce()
    flushSync(() => root.unmount())
    setup.renderer.destroy()
    fake.runTimers()
    expect(fake.sent[0]).toMatchObject({ truncated: false, hoverCount: 0 })
  })
})
