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

/**
 * Why an account without a plan is on limited access, for surfaces that
 * explain the smaller allowance in words (plan card, Earn, Cloud meter). It
 * composes the two helpers above so every surface agrees with the sidebar:
 * - `vpn` / `proxy`: the sidebar's banner (`freebuffCountryVerificationPrompt`),
 *   the only case that earns "verify country to unlock";
 * - `country`: limited because of where it is (`freebuffLimitedCountry`);
 *   verifying cannot change it, so no verify link;
 * - `floor`: held by the access floor (`recent_limited_country`); verifying
 *   from home internet or mobile data is the way out for someone who moved;
 * - `anonymous`: a VPN or proxy verifying cannot unlock (a limited-access exit,
 *   a country already verified): a direct connection is the way out;
 * - `unresolved`: the connection's region could not be confirmed;
 * - `other`: no reason given (the limited-IP list, an older server).
 * Null at full access and for a paying account, which is never called
 * limited nor sent to verify (operator, 2026-10-01).
 */
export type FreebuffLimitedAccessReason =
  | { kind: 'vpn' | 'proxy'; prompt: FreebuffCountryVerificationPrompt }
  | { kind: 'country'; country: { code: string; name: string } }
  | { kind: 'floor' | 'anonymous' | 'unresolved' | 'other' }

export function freebuffLimitedAccessReason(
  session: SessionLike,
): FreebuffLimitedAccessReason | null {
  if (!session || getFreebuffServerAccessTier(session) !== 'limited') {
    return null
  }
  if (getSubscriptionInfo(session)?.tierId != null) return null
  const prompt = freebuffCountryVerificationPrompt(session)
  if (prompt) return { kind: prompt.kind, prompt }
  const country = freebuffLimitedCountry(session)
  if (country) return { kind: 'country', country }
  switch ((session as CountryFields).countryBlockReason) {
    case 'recent_limited_country':
      return { kind: 'floor' }
    case 'anonymous_network':
      return { kind: 'anonymous' }
    case 'anonymized_or_unknown_country':
    case 'missing_client_ip':
    case 'unresolved_client_ip':
    case 'ip_privacy_lookup_failed':
      return { kind: 'unresolved' }
    default:
      return { kind: 'other' }
  }
}

/**
 * The sentence a surface shows for a limited reason, and whether it may
 * offer Account → Country beside it (`verify`): only a VPN or proxy the
 * banner would show, and the access floor ("Moved?"). Null where there is
 * nothing to say (`other`).
 */
export function freebuffLimitedAccessCopy(
  reason: FreebuffLimitedAccessReason | null,
): { text: string; verify: boolean } | null {
  switch (reason?.kind) {
    case 'vpn':
    case 'proxy':
      return { text: `${reason.prompt.label}. ${reason.prompt.tooltip}`, verify: true }
    case 'country':
      return {
        text: `Daily hours are set by country; this is the allowance in ${reason.country.name}.`,
        verify: false,
      }
    case 'floor':
      return {
        text: 'This account was recently used from a region with a smaller allowance, so that allowance applies for a while. Moved? Verify your country from home internet or mobile data.',
        verify: true,
      }
    case 'anonymous':
      return {
        text: 'This connection looks like a VPN or proxy, so the smaller allowance applies while you use it.',
        verify: false,
      }
    case 'unresolved':
      return {
        text: "We couldn't confirm your region on this connection, so the smaller allowance applies for now.",
        verify: false,
      }
    default:
      return null
  }
}
