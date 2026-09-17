/**
 * The free-mode country groups.
 *
 * These live in `common` rather than beside the access-tier logic in
 * `@codebuff/internal` because the landing FAQ is a CLIENT component: the
 * server package pulls in geoip and a database client, and nothing in a
 * browser bundle may import it. `packages/internal/src/free-mode-country/
 * allowed-countries.ts` re-exports these, so the meter and the public copy
 * cannot disagree about which countries get what.
 *
 * Groups are ranked by advertiser value per account (measured 2026-09-12;
 * see docs/freebuff-freebucks.md "Country tiers"). The union of the three
 * full-access groups is the full-access allowlist; everywhere else, and any
 * VPN, is limited access.
 *
 * PUBLIC: `common` ships in the public export, and the landing FAQ prints
 * these codes and their allowances anyway.
 */
export const FREE_MODE_TIER_ONE_COUNTRIES = new Set(['US'])

export const FREE_MODE_TIER_TWO_COUNTRIES = new Set([
  'CA',
  'GB',
  'AU',
  'NZ',
  'IE',
  'NO',
  'SE',
  'DK',
  'FI',
  'NL',
  'AT',
  'LU',
  'IS',
])

// SG and IL left full access on 2026-09-15: ads fill 8-25% of their requests
// against 43-80% across the rest of these groups, so they earn about a tenth
// of a US account. KR fills as poorly and stays here by decision. SG and IL
// subscribers briefly kept the full-access PAID pools; that carve-out was
// retired on 2026-09-18 and they are now limited access uniformly, plan or no
// plan — see `freebucksPlan`.
export const FREE_MODE_TIER_THREE_COUNTRIES = new Set([
  'DE',
  'FR',
  'ES',
  'IT',
  'PT',
  'BE',
  'CH',
  'LI',
  'MT',
  'KR',
])

/** Countries whose users get the full Freebuff tier: the union of the three
 *  groups above. Everyone else gets the limited tier. */
export const FREE_MODE_ALLOWED_COUNTRIES = new Set([
  ...FREE_MODE_TIER_ONE_COUNTRIES,
  ...FREE_MODE_TIER_TWO_COUNTRIES,
  ...FREE_MODE_TIER_THREE_COUNTRIES,
])

/** ISO codes as public copy lists them: "US, CA and GB". */
export function formatCountryCodes(codes: Iterable<string>): string {
  const list = [...codes]
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}
