import { sanitizeAdUrl } from '../util/ad-creative-safety'

/**
 * The advertiser CTA on a sponsored proposal — the one link that hands the
 * conversion token over (COD-512).
 *
 * Settlement mints a signed `bfcid` over the Accept's attribution id and
 * writes it to `ad_sponsored_proposal.conversion_token`; the advertiser's
 * postback (`/api/ads/agentic/postback`) verifies exactly that token. Until
 * this module nothing ever presented the token to anyone, so the advertiser
 * could never report `account_created` / `tool_used` against a sponsored run.
 *
 * The CTA is the campaign's landing URL with `bfcid=<conversion_token>`
 * appended — the same shape the display rail's `/r/<code>` redirect lands the
 * user on, so an advertiser integrated for display clicks reads the agentic
 * click without a second integration.
 *
 * ## Derived on the SERVER, never by a client
 *
 * Both inputs live on the proposal row and only a server projection
 * (`activeProposal` in `freebuff/web/convex/ads/proposals.ts`, which the
 * `/api/v1/ads/proposal` REST front forwards) assembles them. The row's raw
 * `conversion_token` and `advertiser_landing_url` are never sent to a surface:
 * a client that composed the link itself would have to hold the token, and a
 * token in a network tab is a token a user can present to the postback as an
 * advertiser.
 *
 * ## The three gates, and why each refuses
 *
 * 1. `settlement_status` must be `charged` or `already_clicked`. Those are the
 *    two verdicts under which a real click exists on the ledger. `absorbed`,
 *    `not_billable`, `unbillable`, `skipped` and `error` have no click the
 *    advertiser could attribute a conversion to, and a link carrying a token
 *    for one would report conversions against nothing.
 * 2. `conversion_token` must be the SIGNED bfcid, not Accept's opaque `spct_`
 *    placeholder. The column holds the placeholder from Accept until
 *    settlement upgrades it (see the schema comment on `conversion_token`),
 *    and a settlement that minted no token leaves the placeholder in place.
 *    The placeholder never verifies at the postback, so handing it over would
 *    401 every conversion while every row looked settled.
 * 3. The landing URL passes the ad-serving destination gate (`sanitizeAdUrl`:
 *    absolute, https, escapes stripped). A campaign row's landing URL is
 *    advertiser-authored; this is the last hop before it becomes an `href`.
 *
 * Absent (null) on any refusal. A `charged` settlement that minted no token
 * renders no CTA and no placeholder — the card is not owed a dead link.
 */

/**
 * The signed bfcid's shape: `bfc_1.<payload>.<sig>` or `bfc_test_1.…`
 * (`mintClickToken` in `packages/internal/src/placement-tracking.ts`). Three
 * dot-separated url-safe base64 parts. Accept's `spct_<hex>` placeholder has no
 * dots and the wrong prefix, so it cannot match.
 *
 * A SHAPE test, not a signature check: the signing secret does not exist in the
 * Convex runtime that projects the row, and a token this projection mis-judged
 * would fail at the postback anyway — the cost of a wrong "yes" here is one dead
 * link, never a false conversion.
 */
const SIGNED_CONVERSION_TOKEN =
  /^bfc_(?:test_)?1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function isSignedConversionToken(token: string | undefined): boolean {
  return typeof token === 'string' && SIGNED_CONVERSION_TOKEN.test(token)
}

/** The two settlement verdicts under which a click exists to attribute to. */
export const SPONSORED_CTA_SETTLEMENT_STATUSES = [
  'charged',
  'already_clicked',
] as const

/** The query parameter the advertiser reads the click token from. */
export const SPONSORED_CTA_TOKEN_PARAM = 'bfcid'

export type SponsoredAdvertiserCtaInput = {
  /** `coalesce(creative.landing_url, campaign.landing_url)`, as settlement stored it. */
  landingUrl: string | undefined
  /** `ad_sponsored_proposal.conversion_token`, whichever producer wrote it last. */
  conversionToken: string | undefined
  /** `ad_sponsored_proposal.settlement_status`, absent if never attempted. */
  settlementStatus: string | undefined
}

/**
 * The advertiser CTA URL for a settled proposal, or null.
 *
 * Uses `URL.searchParams.set` rather than string concatenation so an existing
 * `bfcid` on the landing URL (an advertiser who pasted a tracked link as their
 * landing page) is REPLACED rather than doubled — two `bfcid` parameters would
 * leave the advertiser's page reading whichever its framework picks.
 */
export function sponsoredAdvertiserCtaUrl(
  input: SponsoredAdvertiserCtaInput,
): string | null {
  if (
    !input.settlementStatus ||
    !(SPONSORED_CTA_SETTLEMENT_STATUSES as readonly string[]).includes(
      input.settlementStatus,
    )
  ) {
    return null
  }
  if (!isSignedConversionToken(input.conversionToken)) return null
  if (!input.landingUrl) return null
  let destination: URL
  try {
    destination = new URL(sanitizeAdUrl(input.landingUrl))
  } catch {
    return null
  }
  destination.searchParams.set(
    SPONSORED_CTA_TOKEN_PARAM,
    input.conversionToken!,
  )
  return destination.toString()
}
