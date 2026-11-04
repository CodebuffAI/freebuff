import { describe, expect, test } from 'bun:test'
import {
  cloudBrowserViewport,
  cloudBrowserViewportCandidates,
  isCloudBrowserLiveViewUrl,
  isCloudBrowserFaviconUrl,
  isCloudBrowserStatus,
  isCloudBrowserTab,
} from './cloud-browser'

describe('cloud browser sizing', () => {
  test('the display size is the box aligned to Kernel width steps and bounded', () => {
    expect(cloudBrowserViewport(437.6, 611.2)).toEqual({ width: 432, height: 611 })
    expect(cloudBrowserViewport(900, 700)).toEqual({ width: 896, height: 700 })
    expect(cloudBrowserViewport(100, 100)).toEqual({ width: 320, height: 240 })
    expect(cloudBrowserViewport(9000, 9000)).toEqual({ width: 2560, height: 1600 })
    expect(cloudBrowserViewport(0, 500)).toBeNull()
  })
  test('refused sizes fall back to height nudges, closest first, then a narrower width', () => {
    const candidates = cloudBrowserViewportCandidates({ width: 448, height: 608 })
    expect(candidates.slice(0, 5)).toEqual([
      { width: 448, height: 608 },
      { width: 448, height: 607 },
      { width: 448, height: 609 },
      { width: 448, height: 606 },
      { width: 448, height: 610 },
    ])
    expect(candidates.at(-3)).toEqual({ width: 440, height: 608 })
    expect(new Set(candidates.map((c) => `${c.width}x${c.height}`)).size).toBe(candidates.length)
    // Never below the minimum height, so the first candidates at the floor are the upward nudges.
    expect(cloudBrowserViewportCandidates({ width: 320, height: 240 }).every((c) => c.height >= 240)).toBe(true)
  })
})

describe('cloud browser wire shapes', () => {
  test('tab icons accept bounded web and image URLs, never executable or VM-local URLs', () => {
    for (const url of [
      'https://example.test/favicon.ico',
      'http://example.test/icon.png',
      'data:image/png;base64,aWNvbg==',
      'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E',
    ]) expect(isCloudBrowserFaviconUrl(url)).toBe(true)
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/icon.png',
      'blob:https://example.test/remote-vm-only',
      'data:text/html,<script>alert(1)</script>',
      'https://user:password@example.test/icon.png',
      '/favicon.ico',
      `https://example.test/${'a'.repeat(4_096)}`,
      `data:image/png;base64,${'a'.repeat(32_768)}`,
    ]) expect(isCloudBrowserFaviconUrl(url)).toBe(false)
    const tab = { id: 't', url: 'https://example.test', title: 'Example' }
    expect(isCloudBrowserTab(tab)).toBe(true)
    expect(isCloudBrowserTab({ ...tab, faviconUrl: 'https://example.test/favicon.ico' })).toBe(true)
    expect(isCloudBrowserTab({ ...tab, faviconUrl: 'javascript:alert(1)' })).toBe(false)
  })
  test('only Kernel live-view hosts over HTTPS may be framed', () => {
    expect(isCloudBrowserLiveViewUrl('https://prod-jfk-hypeman-16.kernel.sh:8443/browser/live/QmDHuC1ncH3h')).toBe(true)
    expect(isCloudBrowserLiveViewUrl('http://prod-jfk-hypeman-16.kernel.sh:8443/browser/live/x')).toBe(false)
    expect(isCloudBrowserLiveViewUrl('https://kernel.sh.attacker.test/browser/live/x')).toBe(false)
    expect(isCloudBrowserLiveViewUrl('https://prod.kernel.sh:8443/other')).toBe(false)
  })
  test('a status is none or a complete session', () => {
    expect(isCloudBrowserStatus({ state: 'none' })).toBe(true)
    expect(
      isCloudBrowserStatus({
        state: 'ready',
        sessionId: 's',
        liveViewUrl: 'https://x.kernel.sh:8443/browser/live/a',
        viewport: { width: 440, height: 612 },
        tabs: [{ id: 't', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false }],
        activeTabId: 't',
        agentActiveAt: null,
      }),
    ).toBe(true)
    expect(isCloudBrowserStatus({ state: 'ready', sessionId: 's' })).toBe(false)
  })
})
