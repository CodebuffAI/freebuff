/**
 * The prepaid balance behind the placements rail.
 *
 * The engagement marketplace bills a fixed daily Stripe SUBSCRIPTION, where
 * the daily budget is simultaneously the price and the delivery cap. That
 * identity breaks the moment the unit is an activation: a $50/day cap can
 * deliver $50 or $3 depending on how many developers actually save the env
 * var, and billing $50 either way is charging for activations we did not
 * deliver. So placements is prepaid — the advertiser tops up, delivery draws
 * the balance down, campaigns stop serving at zero.
 *
 * Nothing here talks to Stripe. These are the values and rules both the
 * advertiser-facing form and the webhook-side parser have to agree on, which
 * is why they live in `common` rather than in either app.
 *
 * See `docs/freebuff-placements-prepaid.md` for the ledger shape and the
 * ordered list of what wiring Stripe actually changes.
 */

/**
 * Floor for a self-serve top-up.
 *
 * Below this the Stripe fee is a visible fraction of what the advertiser
 * bought, which is a bad first line on their statement.
 */
export const AD_TOP_UP_MIN_CENTS = 5_000

/**
 * Self-serve ceiling. Above this we would rather have a conversation than
 * take the card — the same shape as `AD_MAX_DAILY_BUDGET_CENTS`, a different
 * number and a different reason.
 */
export const AD_TOP_UP_MAX_CENTS = 2_000_000

/**
 * Whole dollars only. Cents inside a prepaid top-up buy nothing and produce a
 * statement line the advertiser cannot reconcile against a card statement.
 */
export const AD_TOP_UP_STEP_CENTS = 100

/** The buttons on the top-up dialog. Custom amounts still go through
 *  {@link topUpAmountError}. */
export const AD_TOP_UP_PRESET_CENTS = [
  25_000, 50_000, 100_000, 250_000,
] as const

/**
 * The line item name on Stripe's Checkout page and on the receipt.
 *
 * One definition, because it is the string an advertiser matches against
 * their card statement when they are trying to work out what we charged them
 * for.
 */
export const AD_TOP_UP_PRODUCT_NAME = 'Freebuff placements balance'
/**
 * Suffix on every one-off Freebuff card charge (placements top-ups and the
 * postpaid sweep). The Stripe account is Codebuff's, so a card line reads
 * `CODEBUFF* <suffix>`; prefix + `* ` + suffix must fit Stripe's 22 characters
 * and this fits exactly. Subscription Products carry `FREEBUFF.COM` on the
 * Product itself instead.
 */
export const AD_STATEMENT_DESCRIPTOR_SUFFIX = 'FREEBUFF.COM'

/** The only currency this rail accepts. Asserted at parse time, not assumed. */
export const AD_TOP_UP_CURRENCY = 'usd'

/** Default maximum unpaid placement spend after an advertiser saves a card. */
export const AD_POSTPAID_DEFAULT_CREDIT_LINE_CENTS = 20_000

/** Collection must start before the minimum credit line can stop delivery. */
export const AD_POSTPAID_COLLECTION_THRESHOLD_CENTS = 10_000

/**
 * Referral launch promotion: qualify only after $100 has both been collected
 * and spent on an active, reviewed campaign. Each side then receives $500.
 */
export const AD_PROMO_QUALIFY_CENTS = 10_000
export const AD_PROMO_MATCH_MILESTONES_CENTS = [AD_PROMO_QUALIFY_CENTS] as const
export const AD_PROMO_MATCH_GRANT_CENTS = 50_000

/** Promotional credit paid to the referrer after qualification. */
export const AD_PROMO_REFERRER_REWARD_CENTS = 50_000
export const AD_PROMO_REFERRER_REWARD_CAP = 10
export const AD_PROMO_CREDIT_EXPIRY_DAYS = 60
export const AD_PROMO_REFERRAL_PROGRAM = 'placements_launch_2026'

/**
 * Keep collection provenance through Stripe's refund/dispute exposure window.
 * Account deletion is blocked while a collection is pending or this recent.
 */
export const AD_PLACEMENT_COLLECTION_RETENTION_DAYS = 180

/**
 * Advertiser trust score / derived credit line (COD-268).
 *
 * The line is expressed as DAYS OF OBSERVED BURN, not as a raw multiple of a
 * 30-day total. Collection is nightly (plus a $100 threshold sweep), so the
 * only question the line has to answer is "how many days of this advertiser's
 * spend are we willing to have outstanding between sweeps". Three days covers
 * a weekend plus one failed retry; ten days is the most we extend to anybody
 * on payment history alone, and it is still an order of magnitude under the
 * global ceiling for a large spender.
 */
export const AD_CREDIT_LINE_WINDOW_DAYS = 30
export const AD_CREDIT_LINE_MIN_DAYS = 3
export const AD_CREDIT_LINE_MAX_DAYS = 10

/**
 * The absolute per-advertiser cap on a DERIVED line. An operator may hand-set
 * a higher floor; nothing computed here may exceed this on its own.
 */
export const AD_CREDIT_LINE_CEILING_CENTS = 500_000

/** No growth at all before the account has this much settled history. */
export const AD_CREDIT_LINE_MIN_ACCOUNT_AGE_DAYS = 14
export const AD_CREDIT_LINE_MIN_SUCCESSFUL_COLLECTIONS = 3

/**
 * Per-run move limits. Growth may at most double the live line (or add $100,
 * whichever is larger, so a $0 line is not permanently stuck at
 * zero); a decrease may take at most 25% in one run, matching the repricer's
 * clamp. The dispute cut is deliberately EXEMPT from the decrease clamp.
 */
export const AD_CREDIT_LINE_MAX_GROWTH_BPS = 10_000
export const AD_CREDIT_LINE_MIN_GROWTH_STEP_CENTS = 10_000
export const AD_CREDIT_LINE_MAX_DECREASE_BPS = 2_500

/** Direct placements never sell below one dollar per billable click. */
export const AD_PLACEMENT_CPC_FLOOR_CENTS = 100

/**
 * An operator-set floor exemption for ONE campaign
 * (`ad_placement_campaign.cpc_floor_override_cents`). It may only lower the
 * rate-card floor, and never to zero -- a zero price looks like a working
 * integration while billing nothing.
 */
export function isValidPlacementCpcFloorOverride(
  value: unknown,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= AD_PLACEMENT_CPC_FLOOR_CENTS
  )
}

/**
 * The floor that actually binds a campaign.
 *
 * Anything other than a valid exemption resolves to the global floor, so an
 * out-of-range or malformed value fails SAFE (it raises the floor back to $1)
 * rather than opening it.
 *
 * This lives beside the constant, and not next to any one of its callers,
 * because four separate layers have to agree on it -- the admission
 * validators, the `/r/` click-recording guard, the reprice clamp, and the
 * table CHECK. Two of those are in `packages/internal` and two in
 * `freebuff/web`, and a second copy of this predicate is exactly how the
 * price a campaign serves at drifts from the price an automatic run will
 * clamp it to.
 */
export function effectivePlacementCpcFloorCents(
  overrideCents: unknown,
): number {
  return isValidPlacementCpcFloorOverride(overrideCents)
    ? overrideCents
    : AD_PLACEMENT_CPC_FLOOR_CENTS
}

/** Safe self-serve ceiling when an operator has not supplied a tighter one. */
export const AD_PLACEMENT_CPC_SELF_SERVE_CEILING_CENTS = 1_000

/** The advertiser's editable band; operator terms can only make it narrower. */
export function advertiserPlacementCpcBand(params: {
  floorOverrideCents: unknown
  ceilingCents: unknown
}): { floorCents: number; ceilingCents: number } {
  return {
    floorCents: effectivePlacementCpcFloorCents(params.floorOverrideCents),
    ceilingCents:
      Number.isInteger(params.ceilingCents) &&
      (params.ceilingCents as number) >= 1
        ? (params.ceilingCents as number)
        : AD_PLACEMENT_CPC_SELF_SERVE_CEILING_CENTS,
  }
}

/** A single automatic reprice may move at most 25% in either direction. */
export const AD_PLACEMENT_CPC_REPRICE_MAX_MOVE_BPS = 2_500

/** Thin samples are reported, but never allowed to move money automatically. */
export const AD_PLACEMENT_CPC_REPRICE_MIN_CLICKS = 50

/**
 * The lowest price a single geo-adjusted click may bill, after the country
 * multiplier is applied.
 *
 * DISTINCT from `AD_PLACEMENT_CPC_FLOOR_CENTS`, and the two are not
 * interchangeable. That one is the minimum a CAMPAIGN may be priced at -- the
 * rate-card minimum an operator sets and the repricer clamps to. This one is
 * the minimum a single CLICK may bill at once the campaign's base rate has
 * been scaled down for a low-conversion country. A campaign based at $0.50
 * can therefore bill a limited-tier click here. Ten cents is the commercial
 * floor for inventory that would otherwise fall through unmonetized; the
 * conversion-rate multiplier resolves above it for higher base rates.
 *
 * Keeping them separate is why geo pricing needs no migration:
 * `ck_ad_placement_campaign_cpc_floor` still guards the base rate, unchanged.
 */
export const AD_PLACEMENT_CPC_GEO_FLOOR_CENTS = 10

/**
 * There is deliberately NO `normalizeTopUpCents`.
 *
 * `normalizeDailyBudgetCents` snaps and then clamps, which is right for a
 * slider whose ends are the only legal values. Applied to money it silently
 * turns a $20,000 top-up into $20,000-capped-to-the-max with no error and no
 * log, and the advertiser finds out from their balance. A money validator
 * rejects; it never repairs.
 */
export function isValidTopUpCents(cents: number): boolean {
  return topUpAmountError(cents) === null
}

/**
 * Why this amount cannot be charged, or null if it can.
 *
 * The string is rendered by the form AND returned by the API route, so a
 * client-side and a server-side rejection cannot tell the advertiser two
 * different things.
 *
 * **This is an ENTRY rule.** It governs what an advertiser may ask to pay. It
 * must never be applied to an amount Stripe has already collected — see
 * {@link isPlausibleCollectedCents}.
 */
export function topUpAmountError(cents: number): string | null {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    return 'Enter a whole dollar amount.'
  }
  if (cents < AD_TOP_UP_MIN_CENTS) {
    return `The minimum top-up is ${formatWholeDollars(AD_TOP_UP_MIN_CENTS)}.`
  }
  if (cents > AD_TOP_UP_MAX_CENTS) {
    return `For more than ${formatWholeDollars(AD_TOP_UP_MAX_CENTS)}, contact us and we'll invoice you.`
  }
  if (cents % AD_TOP_UP_STEP_CENTS !== 0) {
    return 'Top up in whole dollars.'
  }
  return null
}

/**
 * Whether an amount Stripe reports as collected is plausible enough to credit.
 *
 * Deliberately far looser than {@link topUpAmountError}. By the time this runs
 * the money is already ours: a tax-inclusive presentment, a promotion code, or
 * Stripe-side rounding can all make the net a non-round number, and refusing
 * to credit it would leave an advertiser who has paid with no balance and no
 * refund. The only things worth refusing here are nonsense.
 */
export function isPlausibleCollectedCents(cents: number): boolean {
  return (
    Number.isInteger(cents) && cents > 0 && cents <= AD_TOP_UP_MAX_CENTS * 2
  )
}

export function describeTopUp(cents: number): string {
  return `${formatWholeDollars(cents)} added to your balance`
}

function formatWholeDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`
}

/**
 * Every reason money moves on the placements rail.
 *
 * Declared here rather than in the console's `StatementLine`, because the
 * ledger reason is the upstream fact and the display kind derives from it —
 * `common` cannot import the app, and the dependency runs the right way round
 * this way.
 */
export const AD_SPEND_LEDGER_REASONS = [
  /** Money in, from a Stripe Checkout in payment mode. Positive. */
  'topup',
  /** One billable activation drawn down. Negative. */
  'spend',
  /** Invalid activity returned to the advertiser. Positive. */
  'refund',
  /** Operator movement, either direction. */
  'adjustment',
  /** A disputed top-up pulled back by the card network. Negative. */
  'chargeback',
  /** Card-on-file collection that pays down a negative postpaid balance. */
  'collection',
  /** A Stripe refund of a prior postpaid collection. Negative. */
  'collection_refund',
  /** A disputed postpaid collection pulled back by the network. Negative. */
  'collection_chargeback',
  /** Time-limited promotional balance with separate grant provenance. */
  'promo_credit',
  /** Unspent promotional balance removed at expiry or after a reversal. */
  'promo_reversal',
] as const
export type AdSpendLedgerReason = (typeof AD_SPEND_LEDGER_REASONS)[number]

/** What the advertiser sees on the statement. */
export const AD_STATEMENT_KINDS = [
  'topup',
  'payment',
  'spend',
  'refund',
  'adjustment',
] as const
export type AdStatementKind = (typeof AD_STATEMENT_KINDS)[number]

/**
 * A chargeback has no statement kind of its own.
 *
 * "Refunded" on this console means *we caught invalid activity and gave the
 * money back* — a trust win we show deliberately. A chargeback is the
 * opposite event and must not borrow that word. The database distinguishes
 * them because one stops serving; the statement shows it as an adjustment
 * whose description says what happened.
 */
export function statementKindForReason(
  reason: AdSpendLedgerReason,
): AdStatementKind {
  if (reason === 'collection') return 'payment'
  if (
    reason === 'chargeback' ||
    reason === 'collection_refund' ||
    reason === 'collection_chargeback' ||
    reason === 'promo_reversal'
  ) {
    return 'adjustment'
  }
  if (reason === 'promo_credit') return 'adjustment'
  return reason
}

/** Reasons that add money. Everything else subtracts. */
export function isCreditReason(reason: AdSpendLedgerReason): boolean {
  return (
    reason === 'topup' ||
    reason === 'refund' ||
    reason === 'collection' ||
    reason === 'promo_credit'
  )
}
