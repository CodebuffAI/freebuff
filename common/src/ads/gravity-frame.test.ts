import { describe, expect, test } from 'bun:test'
import {
  GFB_ACK,
  GFB_CLICK_COOLDOWN_MS,
  GFB_READY_TIMEOUT_MS,
  attachGravityFrame,
  clampFrameHeight,
  createGravityFrameClickGate,
  gravitySidebarRender,
  parseGfbMessage,
} from './gravity-frame'

const msg = (data: Record<string, unknown>) => ({
  __gravity: 1,
  protocol: 'gfb-1',
  ...data,
})

function harness(maxHeight?: number) {
  const listeners = new Set<(e: any) => void>()
  const timers = new Map<number, () => void>()
  let nextId = 1
  const posted: unknown[] = []
  const frameWindow = { postMessage: (m: unknown) => posted.push(m) }
  const calls = { ready: 0, heights: [] as number[], clicks: [] as unknown[], fail: 0 }
  const dispose = attachGravityFrame(
    () => frameWindow,
    {
      onReady: () => calls.ready++,
      onHeight: (h) => calls.heights.push(h),
      onClick: (a) => calls.clicks.push(a),
      onFail: () => calls.fail++,
      maxHeight,
    },
    {
      target: {
        addEventListener: (_t, l) => listeners.add(l),
        removeEventListener: (_t, l) => listeners.delete(l),
      },
      timers: {
        setTimeout: (fn, ms) => {
          expect(ms).toBe(GFB_READY_TIMEOUT_MS)
          const id = nextId++
          timers.set(id, fn)
          return id
        },
        clearTimeout: (id) => timers.delete(id),
      },
    },
  )
  const send = (data: unknown, source: unknown = frameWindow) =>
    listeners.forEach((l) => l({ source, data }))
  const fireTimeout = () => [...timers.values()].forEach((fn) => fn())
  return { send, fireTimeout, posted, calls, dispose, listeners, timers }
}

describe('gravitySidebarRender', () => {
  test('keeps only a safe iframe', () => {
    expect(
      gravitySidebarRender({ mode: 'iframe', frameUrl: 'https://f.trygravity.ai/u', layout: 'x' }),
    ).toEqual({ mode: 'iframe', frameUrl: 'https://f.trygravity.ai/u' })
    for (const bad of [
      null,
      [],
      { mode: 'spec', frameUrl: 'https://a.b/' },
      { mode: 'iframe' },
      { mode: 'iframe', frameUrl: 'http://a.b/' },
      { mode: 'iframe', frameUrl: 'javascript:alert(1)' },
      { mode: 'iframe', frameUrl: 'https://u:p@a.b/' },
      { mode: 'iframe', frameUrl: 'https://a.b:8443/' },
      { mode: 'iframe', frameUrl: `https://a.b/${'x'.repeat(2048)}` },
    ])
      expect(gravitySidebarRender(bad)).toBeUndefined()
  })
})

describe('parseGfbMessage', () => {
  const win = {}
  test('ignores other sources and protocols', () => {
    expect(parseGfbMessage({ source: {}, data: msg({ type: 'ready' }) }, win)).toBeNull()
    expect(parseGfbMessage({ source: win, data: { type: 'ready' } }, win)).toBeNull()
    expect(
      parseGfbMessage({ source: win, data: { ...msg({ type: 'ready' }), protocol: 'gfb-2' } }, win),
    ).toBeNull()
    expect(parseGfbMessage({ source: null, data: msg({ type: 'ready' }) }, null)).toBeNull()
    expect(parseGfbMessage({ source: win, data: msg({ type: 'event' }) }, win)).toBeNull()
  })
  test('drops non-finite heights', () => {
    expect(parseGfbMessage({ source: win, data: msg({ type: 'resize', height: NaN }) }, win)).toEqual({
      type: 'resize',
    })
  })
})

test('clampFrameHeight', () => {
  expect(clampFrameHeight(5)).toBe(40)
  expect(clampFrameHeight(5000)).toBe(1200)
  expect(clampFrameHeight(500, 300)).toBe(300)
  expect(clampFrameHeight(123.6)).toBe(124)
})

describe('attachGravityFrame', () => {
  test('acks once, reports clamped heights and cancels the fallback', () => {
    const h = harness(300)
    h.send(msg({ type: 'ready', height: 200 }))
    h.send(msg({ type: 'resize', height: 900 }))
    h.send(msg({ type: 'resize', height: 10 }))
    expect(h.posted).toEqual([GFB_ACK])
    expect(h.calls.ready).toBe(1)
    expect(h.calls.heights).toEqual([200, 300, 40])
    expect(h.timers.size).toBe(0)
    h.fireTimeout()
    expect(h.calls.fail).toBe(0)
  })
  test('ignores messages from other windows', () => {
    const h = harness()
    h.send(msg({ type: 'ready', height: 200 }), {})
    h.send(msg({ type: 'click' }), {})
    expect(h.posted).toEqual([])
    expect(h.calls.clicks).toEqual([])
  })
  test('click goes to the caller only', () => {
    const h = harness()
    h.send(msg({ type: 'click', action: 'cta' }))
    h.send(msg({ type: 'click' }))
    expect(h.calls.clicks).toEqual(['cta', null])
  })
  test('no ready within the timeout fails once and goes quiet', () => {
    const h = harness()
    h.fireTimeout()
    h.fireTimeout()
    expect(h.calls.fail).toBe(1)
    h.send(msg({ type: 'ready', height: 200 }))
    expect(h.calls.ready).toBe(0)
    expect(h.posted).toEqual([])
  })
  test('dispose removes the listener and timer', () => {
    const h = harness()
    h.dispose()
    expect(h.listeners.size).toBe(0)
    expect(h.timers.size).toBe(0)
  })
})

describe('createGravityFrameClickGate', () => {
  function setup() {
    let now = 10_000
    const frame = { blurs: 0, blur() { this.blurs++ } }
    const doc = { activeElement: frame as unknown, focused: true, hasFocus() { return this.focused } }
    const gate = createGravityFrameClickGate(GFB_CLICK_COOLDOWN_MS, () => now)
    return { frame, doc, gate, advance: (ms: number) => { now += ms } }
  }

  test('honours a click only while the frame holds focus, then blurs it', () => {
    const { frame, doc, gate } = setup()
    expect(gate(frame, doc)).toBe(true)
    expect(frame.blurs).toBe(1)
  })

  test('refuses a click the user did not make in the frame', () => {
    const { frame, doc, gate } = setup()
    doc.activeElement = {}
    expect(gate(frame, doc)).toBe(false)
    doc.activeElement = frame
    doc.focused = false
    expect(gate(frame, doc)).toBe(false)
    expect(gate(null, doc)).toBe(false)
    expect(frame.blurs).toBe(0)
  })

  test('caps honoured clicks to one per cooldown', () => {
    const { frame, doc, gate, advance } = setup()
    expect(gate(frame, doc)).toBe(true)
    advance(GFB_CLICK_COOLDOWN_MS - 1)
    expect(gate(frame, doc)).toBe(false)
    advance(1)
    expect(gate(frame, doc)).toBe(true)
    expect(frame.blurs).toBe(2)
  })
})
