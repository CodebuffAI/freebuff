/**
 * The chat's cloud browser (docs/freebuff-cloud-browser.md): lightweight iframe
 * previews, or a Kernel Chromium in kiosk mode streamed over WebRTC. These
 * shapes cross the workspace gateway between freebuff-web and the Cloud API.
 */

export type CloudBrowserViewport = { width: number; height: number }

/** Agent reveals default to an iframe. Only an explicit browser request starts
 * Kernel. Omit the preview URL to use the chat's authenticated dev server;
 * bootstrap tickets must never be included in durable reveal events. */
export type CloudBrowserOpenRequest = {
  mode: 'preview' | 'browser'
  url?: string
}

export function isCloudBrowserPreviewUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/** Older dev-server reveal events only have vmSlug; keep them inexpensive too. */
export function readCloudBrowserOpenRequest(
  value: unknown,
): CloudBrowserOpenRequest | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.mode !== undefined && v.mode !== 'preview' && v.mode !== 'browser')
    return null
  if (v.url !== undefined && !isCloudBrowserPreviewUrl(v.url)) return null
  return {
    mode: v.mode === 'browser' ? 'browser' : 'preview',
    ...(typeof v.url === 'string' ? { url: v.url } : {}),
  }
}

export type CloudBrowserTab = {
  /** The Chromium target id. Stable for the tab's life, never reused. */
  id: string
  url: string
  title: string
  /** The page's own icon, omitted for blank pages or unsupported URLs. */
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type CloudBrowserSnapshot = {
  tabs: CloudBrowserTab[]
  activeTabId: string | null
}

/** What the panel needs to draw a streaming browser. `liveViewUrl` is a
 * capability for the session's lifetime; it stays in component memory. */
export type CloudBrowserSession = CloudBrowserSnapshot & {
  state: 'ready'
  sessionId: string
  liveViewUrl: string
  viewport: CloudBrowserViewport
  /** When the agent last drove this browser, for the panel's idle pause. */
  agentActiveAt: number | null
}

export type CloudBrowserStatus = CloudBrowserSession | { state: 'none' }

export type CloudBrowserAction =
  | { action: 'connect'; viewport: CloudBrowserViewport }
  | { action: 'resize'; viewport: CloudBrowserViewport }
  | { action: 'open'; url?: string }
  | { action: 'select'; tabId: string }
  | { action: 'close'; tabId: string }
  | { action: 'navigate'; tabId: string; to: string }
  | { action: 'stop'; tabId: string }
  | { action: 'end' }

/** The stream is 1:1 with the panel in CSS pixels; a retina user sees a
 * soft-but-sharp-enough page and the encoder works half as hard. */
export const CLOUD_BROWSER_MIN_WIDTH = 320
export const CLOUD_BROWSER_MIN_HEIGHT = 240
export const CLOUD_BROWSER_MAX_WIDTH = 2560
export const CLOUD_BROWSER_MAX_HEIGHT = 1600
/** Kernel's display aligns the width down to a multiple of 8 (measured:
 * 900→896, 436→432). Asking for that width keeps the stream pixel-exact. */
export const CLOUD_BROWSER_WIDTH_STEP = 8

/** The display size to ask for given the panel's content box. */
export function cloudBrowserViewport(
  width: number,
  height: number,
): CloudBrowserViewport | null {
  if (!(width > 0 && height > 0)) return null
  const w = Math.floor(
    Math.min(CLOUD_BROWSER_MAX_WIDTH, Math.max(CLOUD_BROWSER_MIN_WIDTH, width)) /
      CLOUD_BROWSER_WIDTH_STEP,
  ) * CLOUD_BROWSER_WIDTH_STEP
  const h = Math.floor(
    Math.min(CLOUD_BROWSER_MAX_HEIGHT, Math.max(CLOUD_BROWSER_MIN_HEIGHT, height)),
  )
  return { width: w, height: h }
}

export function sameCloudBrowserViewport(
  a: CloudBrowserViewport | null | undefined,
  b: CloudBrowserViewport | null | undefined,
) {
  return !!a && !!b && a.width === b.width && a.height === b.height
}

export function isCloudBrowserViewport(value: unknown): value is CloudBrowserViewport {
  if (!value || typeof value !== 'object') return false
  const { width, height } = value as Record<string, unknown>
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    (width as number) >= CLOUD_BROWSER_MIN_WIDTH &&
    (width as number) <= CLOUD_BROWSER_MAX_WIDTH &&
    (height as number) >= CLOUD_BROWSER_MIN_HEIGHT &&
    (height as number) <= CLOUD_BROWSER_MAX_HEIGHT
  )
}

/**
 * Kernel refuses some exact sizes (its display driver has no mode for them;
 * about one in five arbitrary sizes, measured 2026-11-03), and a refusal is
 * fast. Nudging the height by a pixel or three always found a mode within a
 * few tries, so these are the sizes to try, closest first. The panel sizes
 * its frame to whichever one took, so a nudge never shows as a bar.
 */
export function cloudBrowserViewportCandidates(
  target: CloudBrowserViewport,
): CloudBrowserViewport[] {
  const out: CloudBrowserViewport[] = []
  const push = (width: number, height: number) => {
    if (
      width < CLOUD_BROWSER_MIN_WIDTH ||
      width > CLOUD_BROWSER_MAX_WIDTH ||
      height < CLOUD_BROWSER_MIN_HEIGHT ||
      height > CLOUD_BROWSER_MAX_HEIGHT
    )
      return
    if (!out.some((c) => c.width === width && c.height === height))
      out.push({ width, height })
  }
  push(target.width, target.height)
  for (let delta = 1; delta <= 4; delta++) {
    push(target.width, target.height - delta)
    push(target.width, target.height + delta)
  }
  push(target.width - CLOUD_BROWSER_WIDTH_STEP, target.height)
  push(target.width - CLOUD_BROWSER_WIDTH_STEP, target.height - 1)
  push(target.width - CLOUD_BROWSER_WIDTH_STEP, target.height + 1)
  return out
}

/** Chromium's blank pages, which the panel draws as its own start page. */
export function isBlankCloudBrowserUrl(url: string | undefined | null) {
  return !url || url === 'about:blank' || url.startsWith('chrome://newtab') || url.startsWith('chrome://new-tab-page')
}

export function isCloudBrowserTab(value: unknown): value is CloudBrowserTab {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return typeof t.id === 'string' && typeof t.url === 'string' && typeof t.title === 'string' &&
    (t.faviconUrl === undefined || isCloudBrowserFaviconUrl(t.faviconUrl))
}

/** A tab icon is an image URL, never an executable or a remote VM's blob URL.
 * Bound inline icons too: tab snapshots are polled and must stay small. */
export function isCloudBrowserFaviconUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32_768) return false
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;[^,]*)?,/i.test(value)) return true
  if (value.length > 4_096) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

export function isCloudBrowserStatus(value: unknown): value is CloudBrowserStatus {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.state === 'none') return true
  return (
    v.state === 'ready' &&
    typeof v.sessionId === 'string' &&
    typeof v.liveViewUrl === 'string' &&
    isCloudBrowserViewport(v.viewport) &&
    Array.isArray(v.tabs) &&
    v.tabs.every(isCloudBrowserTab) &&
    (v.activeTabId === null || typeof v.activeTabId === 'string')
  )
}

/** Only Kernel's own live-view hosts may be framed, and only over HTTPS. */
export function isCloudBrowserLiveViewUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (url.hostname.endsWith('.kernel.sh') || url.hostname.endsWith('.onkernel.com')) &&
      url.pathname.startsWith('/browser/live')
    )
  } catch {
    return false
  }
}
