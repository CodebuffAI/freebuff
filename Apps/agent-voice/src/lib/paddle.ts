/** Paddle Billing checkout overlay.
 *
 * Paddle.js is loaded from the vendor CDN on demand (no npm dependency, no
 * network hit unless the user actually clicks Upgrade) and typed locally so the
 * app compiles without `@types/paddle-js`. */

const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js'

/** Env overrides come from `tauri.conf.json` → `app > windows > env`. */
declare global {
  interface Window {
    Paddle?: PaddleGlobal
    __TAURI__?: unknown
  }
}

interface PaddleEventData {
  /**
   * Paddle Billing issues no license keys — the purchase transaction id is the
   * license code. It is `undefined` until payment has actually been taken, so
   * callers must treat a missing value as "not finished yet".
   */
  transaction_id?: string
}

interface PaddleCheckoutOptions {
  items: { priceId: string; quantity: number }[]
  settings?: {
    displayMode?: 'overlay' | 'inline'
    allowLogout?: boolean
    showAddDiscountCode?: boolean
    variant?: 'one-page' | 'multi-page'
  }
  customer?: { email?: string }
  customData?: Record<string, string>
}

interface PaddleGlobal {
  Initialize(options: {
    token: string
    eventCallback?: (event: { name: string; data?: PaddleEventData }) => void
  }): void
  Checkout?: {
    open(options: PaddleCheckoutOptions): void
    close(): void
  }
  Environment?: { set(environment: 'sandbox' | 'production'): void }
}

export interface PaddleConfig {
  /** Client-side token from the Paddle dashboard. */
  token: string
  /** Price id for the one-time Pro license. */
  priceId: string
  /** `sandbox` for test checkouts. */
  environment: 'sandbox' | 'production'
  /** Included with the webhook so the worker can bind the license. */
  deviceId: string
}

export function paddleConfigFromEnv(
  env: Record<string, string | undefined>,
  deviceId: string,
): PaddleConfig | null {
  const token = env.VITE_PADDLE_TOKEN
  const priceId = env.VITE_PADDLE_PRICE_ID
  if (!token || !priceId) return null
  return {
    token,
    priceId,
    environment:
      env.VITE_PADDLE_ENV === 'production' ? 'production' : 'sandbox',
    deviceId,
  }
}

let scriptPromise: Promise<PaddleGlobal> | null = null

/** Inject the vendor script once and resolve with the `Paddle` global. */
export function loadPaddle(): Promise<PaddleGlobal> {
  if (window.Paddle) return Promise.resolve(window.Paddle)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<PaddleGlobal>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = PADDLE_SCRIPT
    script.async = true
    script.onload = () => {
      if (window.Paddle) resolve(window.Paddle)
      else reject(new Error('Paddle.js loaded but did not register'))
    }
    script.onerror = () => {
      scriptPromise = null
      reject(new Error('could not load Paddle.js — check your network'))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/**
 * Open the checkout overlay and hand back the license code.
 *
 * `onLicenseCode` fires once, when Paddle reports the checkout completed; the
 * deep link (`agentvoice://activate?code=…`) is the fallback path for when the
 * browser swallows the event.
 */
export async function openCheckout(
  config: PaddleConfig,
  onLicenseCode: (code: string) => void,
): Promise<void> {
  const paddle = await loadPaddle()
  paddle.Environment?.set(config.environment)
  let handedOver = false
  paddle.Initialize({
    token: config.token,
    eventCallback: (event) => {
      const code = event.data?.transaction_id
      if (event.name === 'checkout.completed' && code && !handedOver) {
        handedOver = true
        onLicenseCode(code)
      }
    },
  })
  paddle.Checkout?.open({
    items: [{ priceId: config.priceId, quantity: 1 }],
    settings: { displayMode: 'overlay', variant: 'one-page' },
    customData: { device_id: config.deviceId },
  })
}

export function closeCheckout(): void {
  window.Paddle?.Checkout?.close()
}
