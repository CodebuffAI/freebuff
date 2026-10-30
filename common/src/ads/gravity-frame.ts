/**
 * GRAVITY FRAMES: the `gfb-1` handshake for Gravity's rich HTML sidebar
 * units, shared by the Web and Desktop sidebar renderers.
 *
 * Mirrors `GravityFrame` in `@gravity-ai/react` 1.3 with two deliberate
 * differences: the ack is sent once (Gravity's spec), and a click never opens
 * anything itself — it goes to the caller, so clicks take our own click path
 * and billing. The caller owns the iframe, which must be
 * `sandbox="allow-scripts"` and nothing else.
 *
 * Kept framework- and DOM-lib-free (structural types) so `common` compiles
 * without `lib: dom`.
 */

/** Rollout switch for asking Gravity for frames. Checked in, not an env var. */
export const GRAVITY_SIDEBAR_FRAMES = true

export const GFB_PROTOCOL = 'gfb-1'
export const GFB_READY_TIMEOUT_MS = 4_000
export const GFB_MIN_HEIGHT = 40
export const GFB_MAX_HEIGHT = 1200
export const GFB_ACK = { __gravity: 1, protocol: GFB_PROTOCOL, type: 'ack' } as const
/**
 * Tallest a sidebar card grows to fit its frame, matching the static card's
 * `max-height: min(390px, …)`. The card sizes to the frame up to this, rather
 * than clipping it to the static card's 4:3 box.
 */
export const GFB_SIDEBAR_CARD_MAX_HEIGHT = 390
/** Least gap between two honoured frame clicks. */
export const GFB_CLICK_COOLDOWN_MS = 1_000

const MAX_FRAME_URL_LENGTH = 2048

export type GravitySidebarRender = { mode: 'iframe'; frameUrl: string }

/** A frame URL we will load: https, port 443, no credentials, bounded length. */
export function isSafeFrameUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_FRAME_URL_LENGTH)
    return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
    )
  } catch {
    return false
  }
}

/**
 * Projects Gravity's `render` envelope onto the only shape the sidebar draws.
 * Anything but a safe iframe drops `render`, leaving the static card.
 */
export function gravitySidebarRender(
  value: unknown,
): GravitySidebarRender | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const { mode, frameUrl } = value as Record<string, unknown>
  if (mode !== 'iframe' || !isSafeFrameUrl(frameUrl)) return undefined
  return { mode: 'iframe', frameUrl }
}

export function clampFrameHeight(height: number, max = GFB_MAX_HEIGHT): number {
  return Math.max(GFB_MIN_HEIGHT, Math.min(max, Math.round(height)))
}

export type GfbMessage =
  | { type: 'ready' | 'resize'; height?: number }
  | { type: 'click'; action: string | null }

/** Reads a `gfb-1` message, or null unless it came from `frameWindow`. */
export function parseGfbMessage(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
): GfbMessage | null {
  if (!frameWindow || event.source !== frameWindow) return null
  const msg = event.data as Record<string, unknown> | null
  if (
    typeof msg !== 'object' ||
    msg === null ||
    msg.__gravity !== 1 ||
    msg.protocol !== GFB_PROTOCOL
  )
    return null
  if (msg.type === 'ready' || msg.type === 'resize') {
    return typeof msg.height === 'number' && Number.isFinite(msg.height)
      ? { type: msg.type, height: msg.height }
      : { type: msg.type }
  }
  if (msg.type === 'click')
    return {
      type: 'click',
      action: typeof msg.action === 'string' ? msg.action : null,
    }
  return null
}

type FrameWindow = { postMessage(message: unknown, targetOrigin: string): void }
type MessageTarget = {
  addEventListener(type: 'message', listener: (event: any) => void): void
  removeEventListener(type: 'message', listener: (event: any) => void): void
}
type Timers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: any): void
}

export type GravityFrameHandlers = {
  /** First `ready`. The frame is showing; count the impression from here. */
  onReady?: () => void
  /** Clamped height from `ready` / `resize`. */
  onHeight: (height: number) => void
  /**
   * The frame posted a click: gate it (`createGravityFrameClickGate`), then
   * open `clickUrl` via our click path.
   */
  onClick: (action: string | null) => void
  /** No `ready` within the timeout: show the static card instead. */
  onFail: () => void
  maxHeight?: number
}

type FocusableFrame = { blur(): void }
type FocusDocument = { activeElement: unknown; hasFocus(): boolean }

/**
 * Decides whether a posted `click` is honoured. The frame runs third-party
 * script, so a posted click is only a claim. A real click (or keyboard
 * activation) inside a cross-origin frame focuses it; without that, nobody
 * touched the ad. Blurring after honouring one means each further click needs
 * the user to interact again, and the cooldown caps the rest. One gate per
 * frame; both sidebar renderers use it.
 */
export function createGravityFrameClickGate(
  cooldownMs = GFB_CLICK_COOLDOWN_MS,
  now: () => number = () => Date.now(),
): (frame: FocusableFrame | null | undefined, doc: FocusDocument) => boolean {
  let lastClickAt = -Infinity
  return (frame, doc) => {
    if (!frame || doc.activeElement !== frame || !doc.hasFocus()) return false
    const at = now()
    if (at - lastClickAt < cooldownMs) return false
    lastClickAt = at
    frame.blur()
    return true
  }
}

/**
 * Wires one sidebar iframe to the `gfb-1` protocol. `getFrameWindow` is read
 * per message because the iframe's `contentWindow` changes when it navigates.
 * Returns a dispose function.
 */
export function attachGravityFrame(
  getFrameWindow: () => FrameWindow | null | undefined,
  handlers: GravityFrameHandlers,
  env: { target: MessageTarget; timers: Timers } = {
    target: globalThis as unknown as MessageTarget,
    timers: globalThis as unknown as Timers,
  },
): () => void {
  let ready = false
  let failed = false
  const timer = env.timers.setTimeout(() => {
    if (ready || failed) return
    failed = true
    handlers.onFail()
  }, GFB_READY_TIMEOUT_MS)

  const onMessage = (event: { source: unknown; data: unknown }) => {
    if (failed) return
    const frameWindow = getFrameWindow()
    const msg = parseGfbMessage(event, frameWindow)
    if (!msg || !frameWindow) return
    if (msg.type === 'click') {
      // A click before the handshake still came from the frame; honour it.
      handlers.onClick(msg.action)
      return
    }
    if (!ready) {
      ready = true
      env.timers.clearTimeout(timer)
      frameWindow.postMessage(GFB_ACK, '*')
      handlers.onReady?.()
    }
    if (msg.height !== undefined)
      handlers.onHeight(clampFrameHeight(msg.height, handlers.maxHeight))
  }

  env.target.addEventListener('message', onMessage)
  return () => {
    env.timers.clearTimeout(timer)
    env.target.removeEventListener('message', onMessage)
  }
}
