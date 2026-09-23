/**
 * One line answering "why these models?" for a user whose account resolved to
 * the reduced catalog.
 *
 * Tone matters here: this is shown to users who, through no fault of their own,
 * get the smaller model set. Frame it as model *availability* ("aren't
 * available in BR yet"), never as restricted *access* ("limited mode",
 * "blocked") — clear enough to answer the question for someone who goes
 * looking, quiet enough to ignore for someone who doesn't. The VPN case is the
 * one the user can act on, so it leads with the action.
 *
 * Shared by the CLI landing picker and the Desktop model menu so the two
 * surfaces cannot drift — a user who reads it in one and asks support about the
 * other should be told the same thing.
 */

import type {
  FreebuffIpPrivacySignal,
  FreebuffLimitedModeReason,
} from '../types/freebuff-session'

/**
 * A short release note shared by CLI and Desktop. Current policy belongs in
 * the catalog; this is only the user-facing explanation of the change.
 */
export const FREEBUFF_TIER_CHANGE_NOTICE =
  'Solar Mini 4 is now unmetered at full access and available with limited access. GPT-6 Luna still uses your shared premium allowance, charging partial time rounded up to a tenth. —❤️ Freebuff Team'

const PRIVACY_SIGNAL_LABELS: Partial<Record<FreebuffIpPrivacySignal, string>> =
  {
    anonymous: 'anonymized network',
    proxy: 'proxy',
    relay: 'relay',
    res_proxy: 'residential proxy',
    tor: 'Tor',
    vpn: 'VPN',
    hosting: 'hosting network',
    service: 'privacy service',
  }

export function formatFreebuffPrivacySignalList(
  signals: readonly FreebuffIpPrivacySignal[] | null | undefined,
): string {
  const labels = Array.from(
    new Set(
      signals
        ?.map((signal) => PRIVACY_SIGNAL_LABELS[signal])
        .filter((label): label is string => Boolean(label)) ?? [],
    ),
  )

  if (labels.length === 0) {
    return 'VPN, Tor, proxy, relay, or anonymized network'
  }
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`
}

/** "BR" → "Brazil". Falls back to the raw code when the runtime can't
 *  resolve it (malformed code, missing ICU data). */
export function formatFreebuffCountryName(countryCode: string): string {
  try {
    return (
      new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ??
      countryCode
    )
  } catch {
    return countryCode
  }
}

/**
 * The one line to render next to the model list. Callers gate on the access
 * tier: a full-access account has the whole catalog and needs no explanation.
 *
 * A missing/unknown reason still returns a line — the reduced catalog is
 * visible either way, so saying nothing is the one option that leaves the
 * question unanswered.
 */
export function getFreebuffModelAvailabilityNotice(
  reason: FreebuffLimitedModeReason | null | undefined,
): string {
  const generic = "Some models aren't available on this connection"
  if (!reason) return generic

  const countryCode =
    reason.countryCode && reason.countryCode !== 'UNKNOWN'
      ? reason.countryCode
      : null

  switch (reason.countryBlockReason) {
    case 'anonymous_network':
      return `Using a ${formatFreebuffPrivacySignalList(
        reason.ipPrivacySignals,
      )}? More models are available on a direct connection`
    case 'country_not_allowed':
      return `Some models aren't available in ${
        countryCode ? formatFreebuffCountryName(countryCode) : 'your region'
      } yet`
    case 'recent_limited_country':
      return "This account was recently used from a region where some models aren't available yet, so those limits still apply for a while. Moved? Verify your country at freebuff.com/account?tab=country"
    case 'anonymized_or_unknown_country':
    case 'missing_client_ip':
    case 'unresolved_client_ip':
      return "We couldn't confirm your region, so we're showing models available everywhere"
    case 'ip_privacy_lookup_failed':
      return "We couldn't finish a network check, so we're showing models available everywhere"
    default:
      return generic
  }
}
