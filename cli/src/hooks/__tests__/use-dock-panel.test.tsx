import { describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import { fetchDockArm, useDockPanel, type DockPanelState } from '../use-dock-panel'

import type { CliDockArm } from '@codebuff/common/util/ad-experiment'
import type { AdResponse } from '../use-gravity-ad'

type TrackedEvent = [AnalyticsEvent, Record<string, unknown>]

const makeAd = (impUrl: string): AdResponse => ({
  adText: 'App data and vector search, together.',
  title: 'Build your next AI app on Atlas',
  cta: 'Explore Atlas',
  url: 'https://www.mongodb.com/atlas',
  favicon: '',
  clickUrl: 'https://www.mongodb.com/atlas?click=1',
  impUrl,
  provider: 'first_party',
  placementId: 'Single-Ad-Unit-1',
})

/**
 * Drive the hook through a real render tree. The alternative — extracting the
 * reducer — would leave the effects (the arm fetch and the collapse-on-rotate)
 * untested, and those are two of the three things this hook exists for.
 */
async function mountHook(options: {
  arm?: CliDockArm
  ad?: AdResponse | null
  canExpand?: boolean
}): Promise<{
  api: () => DockPanelState
  events: TrackedEvent[]
  setAd: (ad: AdResponse | null) => Promise<void>
  act: (fn: (api: DockPanelState) => void) => Promise<void>
  unmount: () => void
}> {
  const events: TrackedEvent[] = []
  let latest: DockPanelState | null = null
  let setAdExternal: ((ad: AdResponse | null) => void) | null = null
  let clock = 1_000

  const setup = await createTestRenderer({ width: 80, height: 24 })
  const root = createRoot(setup.renderer)

  // The tree is mounted ONCE and driven from inside, because re-calling
  // `root.render` resets the hook's state and would quietly make every
  // assertion below test a fresh mount instead of a live panel.
  const Harness: React.FC = () => {
    const [ad, setAd] = React.useState<AdResponse | null>(
      options.ad ?? makeAd('imp-1'),
    )
    setAdExternal = setAd
    latest = useDockPanel({
      ad,
      canExpand: options.canExpand ?? true,
      fetchArm: async () => options.arm ?? 'expandable',
      now: () => (clock += 500),
      track: (event, properties) => events.push([event, properties]),
    })
    return <box />
  }

  // A macrotask tick, not just microtasks: React schedules passive effects
  // (the arm fetch and the collapse-on-rotate) on its own scheduler, and
  // awaiting promises alone does not drain it.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await setup.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
    await setup.renderOnce()
  }

  flushSync(() => root.render(<Harness />))
  await settle()

  return {
    api: () => latest!,
    events,
    setAd: async (ad) => {
      flushSync(() => setAdExternal!(ad))
      await settle()
    },
    act: async (fn) => {
      flushSync(() => fn(latest!))
      await settle()
    },
    unmount: () => {
      flushSync(() => root.unmount())
      setup.renderer.destroy()
    },
  }
}

describe('useDockPanel', () => {
  test('resolves the arm once and reports expandable', async () => {
    const h = await mountHook({ arm: 'expandable' })
    expect(h.api().arm).toBe('expandable')
    expect(h.api().expandable).toBe(true)
    expect(h.api().expanded).toBe(false)
    h.unmount()
  })

  test('the control arm can never open, whatever is pressed', async () => {
    const h = await mountHook({ arm: 'control' })
    await h.act((api) => api.toggle('key'))
    expect(h.api().expandable).toBe(false)
    expect(h.api().expanded).toBe(false)
    h.unmount()
  })

  test('fires one dock_expanded per impUrl per session, never an impression', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))
    await h.act((api) => api.collapse('esc'))
    await h.act((api) => api.toggle('key'))

    const expanded = h.events.filter(
      ([event]) => event === AnalyticsEvent.ADS_DOCK_EXPANDED,
    )
    expect(expanded).toHaveLength(1)
    expect(expanded[0]![1].method).toBe('click')
    expect(expanded[0]![1].imp_url).toBe('imp-1')

    // Nothing here may ever look like a view or a click.
    expect(
      h.events.some(
        ([event]) =>
          event === AnalyticsEvent.ADS_IMPRESSION_RECORDED ||
          event === AnalyticsEvent.ADS_CLICKED,
      ),
    ).toBe(false)
    h.unmount()
  })

  test('a new impUrl re-arms the expansion event', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))
    await h.setAd(makeAd('imp-2'))
    await h.act((api) => api.toggle('click'))

    expect(
      h.events.filter(([e]) => e === AnalyticsEvent.ADS_DOCK_EXPANDED),
    ).toHaveLength(2)
    h.unmount()
  })

  test('reports the right method and a dwell for every collapse route', async () => {
    const methods = ['esc', 'close', 'outside', 'send'] as const
    for (const method of methods) {
      const h = await mountHook({})
      await h.act((api) => api.toggle('click'))
      await h.act((api) => api.collapse(method))
      const collapsed = h.events.filter(
        ([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED,
      )
      expect(collapsed).toHaveLength(1)
      expect(collapsed[0]![1].method).toBe(method)
      expect(collapsed[0]![1].dwell_ms as number).toBeGreaterThan(0)
      h.unmount()
    }
  })

  test('the chord toggling shut reports method key', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('key'))
    await h.act((api) => api.toggle('key'))
    const collapsed = h.events.filter(
      ([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED,
    )
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]![1].method).toBe('key')
    h.unmount()
  })

  test('a rotation under an open panel collapses it as rotate', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))
    expect(h.api().expanded).toBe(true)

    await h.setAd(makeAd('imp-next'))
    expect(h.api().expanded).toBe(false)
    const collapsed = h.events.filter(
      ([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED,
    )
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]![1].method).toBe('rotate')
    h.unmount()
  })

  test('the ad going away collapses it as gone', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))
    await h.setAd(null)
    const collapsed = h.events.filter(
      ([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED,
    )
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]![1].method).toBe('gone')
    h.unmount()
  })

  test('collapsing an already-closed panel reports nothing', async () => {
    const h = await mountHook({})
    await h.act((api) => api.collapse('esc'))
    await h.act((api) => api.collapse('send'))
    expect(
      h.events.filter(([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED),
    ).toHaveLength(0)
    h.unmount()
  })

  test('a click yields its origin and dwell, and emits NO event of its own', async () => {
    // The whole point of `clickContext`: these fields ride the click
    // acknowledgement so the canonical server-side `ads.clicked` carries them.
    // A second client-side click event here would double-count every dock
    // click, and would carry the metadata only when the ack happened to work.
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))

    const panel = h.api().clickContext('panel')
    expect(panel.from).toBe('panel')
    // The injected clock advances 500 ms per read, so this dwell is over the
    // 300 ms threshold and must NOT be flagged.
    expect(panel.dwellMs).toBeGreaterThan(300)
    expect(panel.accidental).toBe(false)

    const dock = h.api().clickContext('dock')
    expect(dock.from).toBe('dock')
    expect(dock.dwellMs).toBe(0)
    expect(dock.accidental).toBe(false)

    expect(
      h.events.filter(([e]) => e === AnalyticsEvent.ADS_CLICKED),
    ).toHaveLength(0)
    h.unmount()
  })

  test('refuses to open when the panel would not fit', async () => {
    // Otherwise the hook parks in an open state that renders nothing: the
    // dock looks broken, the chord hint disappears, and Escape is needed to
    // clear something the user never saw.
    const h = await mountHook({ canExpand: false })
    await h.act((api) => api.toggle('click'))
    expect(h.api().expanded).toBe(false)
    expect(
      h.events.filter(([e]) => e === AnalyticsEvent.ADS_DOCK_EXPANDED),
    ).toHaveLength(0)
    h.unmount()
  })

  test('rotation collapse reports the OUTGOING ad, not the incoming one', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))
    await h.setAd(makeAd('imp-next'))

    const collapsed = h.events.filter(
      ([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED,
    )
    expect(collapsed).toHaveLength(1)
    // The dwell belongs to imp-1; attributing it to imp-next would credit the
    // incoming ad with attention it never received.
    expect(collapsed[0]![1].imp_url).toBe('imp-1')
    h.unmount()
  })

  test('the ad going away still reports the ad that was open', async () => {
    const h = await mountHook({})
    await h.act((api) => api.toggle('click'))
    await h.setAd(null)

    const collapsed = h.events.filter(
      ([e]) => e === AnalyticsEvent.ADS_DOCK_COLLAPSED,
    )
    expect(collapsed).toHaveLength(1)
    // Was `undefined` before the snapshot: `adRef` had already been cleared.
    expect(collapsed[0]![1].imp_url).toBe('imp-1')
    expect(collapsed[0]![1].placement_id).toBe('Single-Ad-Unit-1')
    h.unmount()
  })
})

describe('fetchDockArm', () => {
  const ok = (body: unknown) =>
    (async () =>
      ({ ok: true, json: async () => body }) as unknown as Response) as
      unknown as typeof fetch

  test('lands on control for every failure mode', async () => {
    const failures: Array<typeof fetch> = [
      (async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
      (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch,
      ok({}),
      ok({ dockArm: 'nonsense' }),
      ok({ dockArm: null }),
      (async () => ({
        ok: true,
        json: async () => {
          throw new Error('bad json')
        },
      })) as unknown as typeof fetch,
    ]
    for (const impl of failures) {
      expect(await fetchDockArm(impl, 'https://example.invalid')).toBe('control')
    }
  })

  test('returns control without an auth token, without calling out', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return { ok: true, json: async () => ({ dockArm: 'expandable' }) }
    }) as unknown as typeof fetch
    // No CLI auth token is set in the test environment.
    expect(await fetchDockArm(spy, 'https://example.invalid')).toBe('control')
    expect(called).toBe(false)
  })
})
