/** License activation flow: deep-link parsing (pure) plus the Tauri hook
 *  that turns an `agentvoice://activate?key=…` return into an activation. */

import { onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { activateLicense } from './api'
import type { StateView } from './types'

export const DEEP_LINK_SCHEME = 'agentvoice'

export type ActivationPayload =
  | { ok: true; key: string }
  | { ok: false; reason: 'malformed' | 'not-an-activation' | 'missing-key' }

/** Parse the Paddle return URL. Pure, so it is unit tested directly. */
export function parseActivationUrl(raw: string): ActivationPayload {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (url.protocol.replace(':', '') !== DEEP_LINK_SCHEME) {
    return { ok: false, reason: 'malformed' }
  }
  // `agentvoice://activate?key=…` parses with host="activate"; some platforms
  // deliver it as `agentvoice:///activate?key=…`, so accept both.
  const action = url.host || url.pathname.replace(/^\/+/, '')
  if (action !== 'activate') {
    return { ok: false, reason: 'not-an-activation' }
  }
  const key = (url.searchParams.get('key') ?? '').trim()
  if (!key) {
    return { ok: false, reason: 'missing-key' }
  }
  return { ok: true, key }
}

/**
 * Listen for the checkout return deep link and activate the license key it
 * carries. Returns a disposer.
 */
export async function listenForActivation(
  onActivated: (state: StateView) => void,
  onError: (message: string) => void,
): Promise<() => void> {
  const unlisten = await onOpenUrl((urls) => {
    for (const url of urls) {
      const parsed = parseActivationUrl(url)
      if (!parsed.ok) continue
      activateLicense(parsed.key)
        .then(onActivated)
        .catch((e) => onError(String(e)))
    }
  })
  return unlisten
}
