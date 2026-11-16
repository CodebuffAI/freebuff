/**
 * What the Web and Cloud sidebars say about an account's country, from the
 * session GET (docs/freebuff-account-hub.md).
 *
 * Limited access is never explained, with one exception: a VPN or proxy exit
 * in a full-access country, where turning it off or verifying the country
 * unlocks full access. An account limited because of where it is, by the
 * access floor or on an unresolved connection gets no banner and no sentence;
 * nothing names its country or region (product, 2026-11-16).
 */

import { FREE_MODE_ALLOWED_COUNTRIES } from '../constants/freebuff-countries'
import {
  getFreebuffServerAccessTier,
  getSubscriptionInfo,
} from '../types/freebuff-session'

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
 * Why an account without a plan is on limited access, for surfaces that may
 * explain the smaller allowance (plan card, Earn). Only a VPN or proxy exit
 * in a full-access country is ever put into words (`freebuffLimitedAccessCopy`):
 * - `vpn` / `proxy`: the sidebar's banner (`freebuffCountryVerificationPrompt`),
 *   the only case that earns "verify country to unlock";
 * - `anonymous`: a VPN or proxy the banner does not name (verifying cannot
 *   help, a country already verified, or a limited-access exit). It carries
 *   the exit's country, which decides whether it is said at all;
 * - `country`: limited because of where it is (`country_not_allowed`);
 * - `floor`: held by the access floor (`recent_limited_country`);
 * - `unresolved`: the connection's region could not be confirmed;
 * - `other`: no reason given (the limited-IP list, an older server).
 * Null at full access and for a paying account, which is never called
 * limited nor sent to verify (operator, 2026-10-01).
 */
export type FreebuffLimitedAccessReason =
  | { kind: 'vpn' | 'proxy'; prompt: FreebuffCountryVerificationPrompt }
  | { kind: 'anonymous'; countryCode: string | null }
  | { kind: 'country' | 'floor' | 'unresolved' | 'other' }

export function freebuffLimitedAccessReason(
  session: SessionLike,
): FreebuffLimitedAccessReason | null {
  if (!session || getFreebuffServerAccessTier(session) !== 'limited') {
    return null
  }
  if (getSubscriptionInfo(session)?.tierId != null) return null
  const prompt = freebuffCountryVerificationPrompt(session)
  if (prompt) return { kind: prompt.kind, prompt }
  const fields = session as CountryFields
  switch (fields.countryBlockReason) {
    case 'country_not_allowed':
      return { kind: 'country' }
    case 'recent_limited_country':
      return { kind: 'floor' }
    case 'anonymous_network':
      return { kind: 'anonymous', countryCode: fields.countryCode ?? null }
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
 * offer Account → Country beside it (`verify`, only the banner's VPN or
 * proxy). Null unless a VPN or proxy exit in a full-access country is the
 * cause: no other reason is explained, and nothing says "limited" or names a
 * country or region (product, 2026-11-16).
 */
export function freebuffLimitedAccessCopy(
  reason: FreebuffLimitedAccessReason | null,
): { text: string; verify: boolean } | null {
  switch (reason?.kind) {
    case 'vpn':
    case 'proxy':
      return { text: `${reason.prompt.label}. ${reason.prompt.tooltip}`, verify: true }
    case 'anonymous':
      return reason.countryCode &&
        FREE_MODE_ALLOWED_COUNTRIES.has(reason.countryCode)
        ? {
            text: 'This connection looks like a VPN or proxy, so a smaller allowance applies while you use it.',
            verify: false,
          }
        : null
    default:
      return null
  }
}
