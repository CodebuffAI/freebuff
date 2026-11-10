/**
 * What the Web and Cloud sidebars say about an account's country, from the
 * session GET (docs/freebuff-account-hub.md).
 *
 * Only a connection the user can do something about earns a banner: a VPN or
 * proxy exit in a full-access country, where turning it off or verifying the
 * country unlocks full access. An account that is limited because of where it
 * IS gets no banner (it read as a scolding, product 2026-11-09); its country
 * rides the daily hours row instead (`freebuffLimitedCountry`).
 */

import { FREE_MODE_ALLOWED_COUNTRIES } from '../constants/freebuff-countries'
import {
  getFreebuffServerAccessTier,
  getSubscriptionInfo,
} from '../types/freebuff-session'
import { formatFreebuffCountryName } from './freebuff-model-availability'

import type {
  FreebuffCountryBlockReason,
  FreebuffIpPrivacySignal,
} from '../types/freebuff-session'

type SessionLike = { status: string } | null | undefined

type CountryFields = {
  countryCode?: string | null
  countryBlockReason?: FreebuffCountryBlockReason | null
  ipPrivacySignals?: FreebuffIpPrivacySignal[] | null
  countryVerified?: boolean
  verificationCanChangeAccess?: boolean
}

export type FreebuffCountryVerificationPrompt = {
  kind: 'vpn' | 'proxy'
  label: string
  tooltip: string
}

const PROXY_SIGNALS: ReadonlySet<FreebuffIpPrivacySignal> = new Set([
  'proxy',
  'res_proxy',
])

/** The "VPN detected" / "Proxy detected" banner, or null for no banner. */
export function freebuffCountryVerificationPrompt(
  session: SessionLike,
): FreebuffCountryVerificationPrompt | null {
  if (!session || getFreebuffServerAccessTier(session) !== 'limited') {
    return null
  }
  // A paying account is never sent to verify (operator, 2026-10-01).
  if (getSubscriptionInfo(session)?.tierId != null) return null
  const fields = session as CountryFields
  if (fields.countryVerified === true) return null
  if (fields.verificationCanChangeAccess === false) return null
  if (fields.countryBlockReason !== 'anonymous_network') return null
  // The exit's country: a full-access one means verifying from a direct
  // line can unlock full access. Elsewhere there is nothing to unlock.
  if (
    !fields.countryCode ||
    !FREE_MODE_ALLOWED_COUNTRIES.has(fields.countryCode)
  ) {
    return null
  }
  const signals = fields.ipPrivacySignals ?? []
  const proxy =
    !signals.includes('vpn') &&
    signals.some((signal) => PROXY_SIGNALS.has(signal))
  if (proxy) {
    return {
      kind: 'proxy',
      label: 'Proxy detected, verify country to unlock',
      tooltip: signals.includes('res_proxy')
        ? 'This network is listed as a proxy, often because of a bandwidth-sharing app on a device here. Verify your country to unlock full access.'
        : 'This connection goes through a proxy. Turn it off, or verify your country from home internet or mobile data, to unlock full access.',
    }
  }
  return {
    kind: 'vpn',
    label: 'VPN detected, verify country to unlock',
    tooltip:
      'This connection looks like a VPN. Turn it off, or verify your country from home internet or mobile data, to unlock full access.',
  }
}

/**
 * The limited-access country an account is in, for the badge on its daily
 * hours row: set only when the account is limited because of where it is
 * (`country_not_allowed` in a limited-access country), never for a VPN,
 * proxy or unresolved connection.
 */
export function freebuffLimitedCountry(
  session: SessionLike,
): { code: string; name: string } | null {
  if (!session || getFreebuffServerAccessTier(session) !== 'limited') {
    return null
  }
  const fields = session as CountryFields
  const code = fields.countryCode
  if (
    fields.countryBlockReason !== 'country_not_allowed' ||
    !code ||
    code === 'UNKNOWN' ||
    FREE_MODE_ALLOWED_COUNTRIES.has(code)
  ) {
    return null
  }
  return { code, name: formatFreebuffCountryName(code) }
}
