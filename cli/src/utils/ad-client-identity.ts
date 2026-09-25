import { IS_FREEBUFF } from './constants'
import { getCliEnv } from './env'

/**
 * How this CLI names itself to the ad routes: the product User-Agent and the
 * device facts every ad request carries.
 *
 * One module because two rails now send them -- the display auction
 * (`use-gravity-ad.ts`) and the per-turn agentic offer
 * (`sponsored-offer.ts`) -- and the server pairs them. A capability claimed by
 * `cli_macos` is believed only beside a `Freebuff-CLI/` UA and a `macos`
 * device, so the two rails must not be able to disagree about either.
 */

/** Device info sent to the ads API for targeting */
export type AdDeviceInfo = {
  os: 'macos' | 'windows' | 'linux'
  timezone: string
  locale: string
}

/** Get device info for ads API */
export function getAdDeviceInfo(): AdDeviceInfo {
  // Map Node.js platform to Gravity API os values
  const platformToOs: Record<string, 'macos' | 'windows' | 'linux'> = {
    darwin: 'macos',
    win32: 'windows',
    linux: 'linux',
  }
  const os = platformToOs[process.platform] ?? 'linux'

  // Get IANA timezone (e.g., "America/New_York")
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  // Get locale (e.g., "en-US")
  const locale = Intl.DateTimeFormat().resolvedOptions().locale

  return { os, timezone, locale }
}

export function getCliAdRequestUserAgent(): string {
  const product = IS_FREEBUFF ? 'Freebuff-CLI' : 'Codebuff-CLI'
  const version = getCliEnv().CODEBUFF_CLI_VERSION ?? 'dev'
  return `${product}/${version}`
}
