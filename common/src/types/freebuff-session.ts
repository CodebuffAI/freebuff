import type { FreebuffAccessTier } from '../constants/freebuff-models'
import type { FreebuffStandingInfo } from '../constants/freebuff-standing'
import { applyFreebucksPriceChanges } from '../util/freebuff-price-changes'

/**
 * Wire-level shapes returned by `/api/v1/freebuff/session`. Source of truth
 * for the CLI (which deserializes these) and the server (which serializes
 * them) — keep both in sync by importing this module from either side.
 *
 * The CLI uses these shapes directly; there are no client-only states.
 */

/**
 * Usage counter surfaced to the CLI so the UI can render
 * "N of M sessions used" alongside active state. Present when the
 * joined model consumes Freebuff sessions. `recentCount` is usage since the
 * current quota period began: fractional units normally, or session starts
 * when `countsAdmissions` is set.
 */
export interface FreebuffSessionEntitlementBreakdown {
  /** Sessions included without earning a referral or streak reward. */
  base: number
  /** Sessions earned from the referral program for this quota period. */
  referral: number
  /** Sessions earned from the active streak reward for this quota period. */
  streak: number
  /** Sessions added by a temporary promotion, for a user who already earned
   *  their way in (a qualified referral or a bounty grant). Omitted while no
   *  promo runs, which is the default — an older client that never reads it
   *  still sums to the right `limit`, because the server sends the total. */
  promo?: number
  /**
   * Sessions added by the account's earned LEVEL
   * (`common/constants/freebuff-levels.ts`). Omitted at level 0, which is
   * where every account starts, so the field is absent for most callers and an
   * older client that never reads it still sums to the right `limit` — the
   * server always sends the total.
   *
   * Distinct from `base` on purpose. `base` is what we give you; this is what
   * you earned, and a user looking at "1 + 4" needs to be able to see which
   * half goes away if they stop engaging.
   */
  level?: number
  /**
   * Sessions included by the account's PAID subscription tier
   * (`common/constants/freebuff-subscriptions.ts`).
   *
   * An ADDITION to `base`, not a replacement for it — since 2026-08-26, when
   * the plan started topping the free pools up rather than replacing them.
   * Free sessions burn first and the plan covers what is left, so a row reading
   * "5 base + 4 subscription" means nine sessions today and `limit` is nine.
   *
   * (It was the whole of `limit` under the older replace-semantics, with
   * `base` zeroed. A client that sums the breakdown gets the right total under
   * both, which is why the change needed no client release.)
   *
   * Omitted for everyone without a live subscription, so an older client that
   * never reads it still sums to the right `limit`.
   */
  subscription?: number
}

/**
 * A purchasable tier, as advertised to a client.
 *
 * Mirrors the catalog in `constants/freebuff-subscriptions.ts` so a client can
 * render plan cards and the paywall without its own copy of the numbers.
 */
export interface FreebuffSubscriptionTierOffer {
  id: string
  displayName: string
  priceUsd: number
  /** What this caller would actually be charged for the first period —
   *  `introPriceUsd` only while the account has never used its intro. */
  firstPeriodPriceUsd: number
  dailySessions: number
  fiveDaySessions: number
  monthlySessions: number
  /** @deprecated Legacy cap field; new servers omit it and clients ignore it. */
  monthlySpendLimitUsd?: number
  dailyPremiumSessions: number
  /** Plain-language constraints for the plan card and the paywall. */
  disclaimers: string[]
  /** True for the tier the caller currently holds. */
  current: boolean
  /** True when this tier is above the caller's current one. */
  upgrade: boolean
  /** True when it is below. A downgrade is SCHEDULED for the next renewal
   *  rather than applied now, so clients must not word it as immediate. */
  downgrade: boolean
}

/**
 * A subscriber's live usage against their tier, for the circular indicators.
 *
 * All four figures come from ONE server-side scan and are sent together, so a
 * client never has to compute a ring from a partial picture or issue a second
 * request to draw one.
 */
export interface FreebuffSubscriptionUsage {
  dayUsed: number
  dayLimit: number
  fiveDayUsed: number
  fiveDayLimit: number
  monthUsed: number
  monthLimit: number
  /** Sessions spent today on Luna / DeepSeek V4 Pro, and the daily sub-cap. */
  dayPremiumUsed: number
  dayPremiumLimit: number
  /** ISO instant the DAILY window resets. */
  dayResetAt: string
  /** ISO instant the billing period ends, i.e. when the monthly cap resets. */
  periodEndsAt: string
  /** @deprecated Legacy dollar usage; new servers omit it. */
  monthSpendUsd?: number
  monthSpendLimitUsd?: number
  /**
   * The caller's FREE premium-session pool for today, which the plan tops up.
   *
   * Sent because a client cannot derive it: `rateLimitsByModel` carries one row
   * per model — whichever pool the next admission will charge — so once the
   * free pool is spent the free figures are simply not on the wire, and a
   * client trying to add "free + plan" from it double-counts the plan row.
   *
   * Reported for quota-exempt accounts (god/admin) too: their free pool is not
   * ENFORCED, but the entitlement is still the honest free half of the combined
   * figure. Absent entirely from servers older than this field.
   *
   * The same numbers back the combined `rateLimitsByModel` rows, from one
   * memoized read, so the panel and every picker header cannot disagree.
   */
  freeDayUsed?: number
  freeDayLimit?: number
}

/**
 * Everything a client needs to render subscription state, the usage rings, and
 * the paywall — in one block on the session response.
 *
 * Sent only to callers in the rollout audience, so its absence means "this
 * account has no subscriptions surface" rather than "no data".
 */
/** The daily Freebucks pool, as the client should render it. */
export interface FreebuffFreebucksWindow {
  /** Freebucks granted for the Pacific day: the access tier's free pool, or
   *  the plan's daily pool for a subscriber (the plan REPLACES the free
   *  figure rather than stacking on it). */
  limit: number
  /** Freebucks already spent from the daily pool today. */
  spent: number
  /** `limit - spent`, floored at zero so a lowered allowance reads as 0. */
  remaining: number
  /** ISO instant the pool refills. */
  resetAt: string
}

/**
 * The wallet: what is left once the daily pool is spent. Holds two kinds of
 * Freebucks that behave differently and are deliberately shown as ONE number,
 * because the distinction is ours to keep rather than the user's to track:
 * EARNED ones (bounties, referrals, grants) stay until they are spent, while a
 * plan's monthly bonus is an allowance for its period and any of it left over
 * is retired when another period’s bonus is credited, including on upgrade
 * (`FREEBUCKS_BONUS_EXPIRY_REASON`). Subscription end alone does not retire it.
 * Wallet spending is attributed to the expiring half first, so a user who spends is always
 * treated as having spent the money that was about to go.
 *
 * Drawn on only once the daily pool
 * is spent, so a session costing more than what is left in the pool takes the
 * remainder from here.
 */
export interface FreebuffFreebucksWallet {
  /** Spendable wallet balance right now. */
  balance: number
  /** Freebucks the plan credits here once per billing period (0 on free). */
  monthlyBonus: number
  /** Current period end: the next bonus is available then IF the plan renews.
   * Still present when cancellation is scheduled; absent without a live plan. */
  nextBonusAt?: string
}

/**
 * The hard daily dollar ceiling behind the Freebucks meter.
 *
 * NOT SHOWN ANYWHERE, and that is the point: it is an abuse backstop sized to
 * catch only the heaviest days, while the meter a user plans against is their
 * Freebucks. Rendering a second, smaller-looking limit beside the pool invited
 * the reading that the dollars run out first. It stays on the wire because a
 * refusal names it and an operator surface may want it, and it deliberately
 * carries no running total — computing one cost an extra spend aggregate on
 * every session response for a number nothing draws.
 */
export interface FreebuffFreebucksSpendCeiling {
  /** Settled provider spend since midnight Pacific at which fresh sessions
   *  stop being admitted, for this account's tier and access tier. */
  limitUsd: number
  /** ISO instant the day rolls. */
  resetAt: string
}

/**
 * The MONTHLY dollar allowance: what this account may draw in provider spend
 * over the period, what it has drawn, and what is left.
 *
 * Unlike the daily ceiling above, this one IS shown — as "$N left" beside the
 * Freebucks balances — because the two answer different questions. The daily
 * figure is an abuse backstop nobody should ever meet, and showing it invited
 * the reading that the dollars run out before the Freebucks do. This one is
 * the honest size of the gift: it is what the plan card advertises, it is what
 * the server enforces, and a user who wants to know how much they are being
 * given can read it directly instead of inferring it from a session price.
 *
 * `spentUsd` lags live traffic by up to an hour: it is summed from the hourly
 * spend rollup rather than the hot `message` table, deliberately, because a
 * SUM over that table on every session response is the shape of the
 * 2026-08-17 saturation. For a monthly bound an hour of lag is noise.
 */
export interface FreebuffFreebucksMonthlyAllowance {
  /** Provider spend for the period at which fresh sessions stop. */
  limitUsd: number
  /** Settled spend so far this period, from the hourly rollup. */
  spentUsd: number
  /** `limitUsd - spentUsd`, floored at zero so an overshoot reads as spent
   *  rather than as a negative allowance. */
  remainingUsd: number
  /** ISO instant the period rolls: the Stripe period end for a subscriber,
   *  else the first of next month. */
  resetAt: string
}

/**
 * The caller's Freebucks position, present on every authenticated session
 * response inside the rollout audience. Distinct from Trust: Freebucks are a
 * granted budget that buys sessions, Trust is earned standing that buys
 * Levels.
 *
 * For models in `prices`, this balance takes precedence over legacy
 * `rateLimitsByModel` and referral balances when starting a new session.
 *
 * Two balances and one ceiling — deliberately nothing else. The 2026-08-31
 * shape carried day/week/month windows beside the session pools' own rings;
 * this one is the whole indicator set for an account on the meter.
 */
export interface FreebuffFreebucksInfo {
  /** Server-authorized quota exemption: new sessions remain usable at zero balance. */
  quotaExempt?: boolean
  /** Spendable right now: `daily.remaining + wallet.balance`. */
  balance: number
  daily: FreebuffFreebucksWindow
  wallet: FreebuffFreebucksWallet
  /** @deprecated Provider-spend caps are no longer enforced or displayed. */
  spend?: FreebuffFreebucksSpendCeiling
  /** @deprecated Legacy cap field; new servers omit it and clients ignore it. */
  monthly?: FreebuffFreebucksMonthlyAllowance
  /** The plan the daily pool and bonus were sized from; null on free. */
  planId: string | null
  /** Session price per model id. Only models on the meter appear here. */
  prices: Record<string, number>
  /** Copy resolved with the price, overriding the static model tagline.
   *  A client that renders `peak` as a badge should ignore the entry for a
   *  model in `peak.modelIds` — that entry is the same fact as prose, kept
   *  for builds that predate the badge. */
  priceNotices?: Record<string, string>
  /** The rows whose price carries the peak surcharge RIGHT NOW, and until
   *  when. Absent off peak. Clients render it as a badge with a tooltip in
   *  the reader's own time zone (`freebucksPeakCopy`). */
  peak?: FreebuffFreebucksPeak
  /** Scheduled changes announced by the server; do not reprice admitted sessions. */
  priceChanges?: readonly FreebuffPriceChange[]
}

export interface FreebuffFreebucksPeak {
  /** Model ids priced at base + `surcharge` at the moment of the response. */
  modelIds: string[]
  /** Freebucks added to each of those rows' session price. */
  surcharge: number
  /** ISO instant the surcharge lifts (the end of the expensive window). */
  endsAt: string
}

export interface FreebuffPriceChange {
  at: string
  modelId: string
  price: number
  tagline: string
}

export interface FreebuffSubscriptionInfo {
  /** The caller's tier id, or null when they have no live subscription. */
  tierId: string | null
  /** Present only while subscribed. */
  usage?: FreebuffSubscriptionUsage
  /** Raw Stripe status, so a client can surface a failed payment. */
  status?: string
  /** True when the subscription lapses at period end. */
  cancelAtPeriodEnd?: boolean
  /** Tier this drops to at the next renewal, when a downgrade is scheduled.
   *  Absent in the ordinary case — every subscription not mid-downgrade. */
  pendingTierId?: string
  /** The full catalog, current tier flagged. Drives every upgrade CTA. */
  tiers: FreebuffSubscriptionTierOffer[]
  /**
   * Which limit the caller is currently up against, if any. What turns the
   * dropdown into a paywall rather than a usage display.
   *
   * `premium_daily` means only the expensive models are blocked — the cheaper
   * ones are still usable today, and the client should say so rather than
   * implying the whole plan is spent.
   */
  blockedBy?:
    | 'daily'
    | 'five_day'
    | 'monthly'
    | 'premium_daily'
    /** The tier's dollar ceiling for the period is spent. */
    | 'monthly_spend'
}

/**
 * The FREE tier's windows, for every full-access account (2026-09-01).
 *
 * `today` is the live premium pool — the same number the picker's daily ring
 * has always drawn, base + level + referral bonus. `week` and `month` are the
 * MARKETED free allowance (`FREEBUFF_FREE_TIER_ALLOWANCE`) with the account's
 * real usage against them, so free users see the same three rings a
 * subscriber sees. DISPLAY-ONLY for now: nothing refuses on the week or month
 * yet (operator decision — enforcement is a later change), so `weekUsed` can
 * legitimately exceed `weekLimit` until it lands.
 *
 * Absent for quota-exempt accounts (they hold no pools), for limited access
 * (whose one regional pool is already the picker's ring), and from servers
 * older than this field.
 */
export interface FreebuffFreeWindowsInfo {
  dayUsed: number
  dayLimit: number
  weekUsed: number
  weekLimit: number
  monthUsed: number
  monthLimit: number
  /** ISO instant the daily pool resets. */
  dayResetAt: string
  /** ISO instant the calendar month (Pacific) rolls. The week is rolling. */
  monthResetAt: string
}

/**
 * What to offer someone a refusal just stopped.
 *
 * Attached to `rate_limited` and `spend_limited` so the answer to "you are out
 * of sessions" carries the way out, instead of leaving every client to invent
 * its own copy and its own URL. Absent when there is nothing to sell — outside
 * the rollout audience, or already on the largest plan.
 *
 * `url` is absolute so a terminal can print something clickable.
 */
export interface FreebuffUpgradeHint {
  url: string
  message: string
}

export interface FreebuffSessionRateLimit {
  model: string
  /**
   * Which quota POOL this row draws on, and what to call it.
   *
   * Both omitted by older servers, and both exist so the shape of the quota
   * system can change without shipping a client. Until 2026-08-19 every row in
   * a picker section shared one pool, so a client could read any single entry
   * and label the whole section from it — the CLI literally took
   * `Object.values(...)[0]`. DeepSeek's one-a-day ceiling ended that: two pools
   * now appear inside the Premium section, and a client with no way to tell
   * them apart shows "1 of 5 used" next to a row that is already spent.
   *
   * `pool` is an opaque token — clients must GROUP by it and never match on its
   * value, or the next pool needs a release. `poolLabel` is the display string,
   * authored server-side for the same reason: adding a pool, renaming one, or
   * changing a limit is then a server edit that installed clients pick up on
   * their next poll.
   */
  pool?: string
  poolLabel?: string
  /** `recentCount` counts starts rather than fractional session units. */
  countsAdmissions?: true
  /** Additive detail for `limit`; omitted by older servers. New servers emit it
   * for session quotas with `limit = base + referral + streak + promo`. */
  entitlementBreakdown?: FreebuffSessionEntitlementBreakdown
  limit: number
  /** 'pacific_day' for the daily pools (premium/limited, and the reward
   *  referral pool since 2026-07-29). 'pacific_week' is kept for wire compat
   *  with servers from when the GLM pool reset weekly.
   *
   *  'pacific_month' arrived with the monthly dollar allowance. EVERY RELEASED
   *  CLIENT renders an unrecognised value as "today" (`period === 'pacific_week'
   *  ? 'this week' : 'today'`), which is wrong copy rather than a crash — it
   *  invites a user to retry in the morning for an allowance that returns on
   *  the 1st. Harmless today because only Freebuff Web is on the meter and its
   *  copy is updated in step; a widening of the Freebucks audience has to
   *  carry a client release with it, or accept that wording. `resetAt` is
   *  correct on every client either way, so anything reading THAT is safe. */
  period: 'pacific_day' | 'pacific_week' | 'pacific_month'
  resetTimeZone: string
  resetAt: string
  /** Deprecated wire field kept for older clients. Session usage now follows
   * the explicit Pacific day/week period and `resetAt`. */
  windowHours: number
  recentCount: number
}

export type FreebuffSessionRateLimitByModel = Record<
  string,
  FreebuffSessionRateLimit
>

/** Timing needed by multi-session clients to show the active session window. */
export interface FreebuffActiveSessionInfo {
  model: string
  admittedAt: string
  expiresAt: string
}

/** Live per-user Freebuff Desktop sessions, counted server-side across every
 * Desktop process. Holder identities stay client-local; these totals make the
 * picker honest when another project or device is using capacity. */
export interface FreebuffDesktopSessionCounts {
  premium: number
  unlimited: number
  /** Earliest capacity-release time. Premium rows include their drain grace;
   * unlimited rows release at normal expiry. */
  nextExpiryAt?: string
}

/**
 * Referral status surfaced to the CLI model-selector so it can render an
 * "invite friends" banner. The reward depends on the session's access tier:
 *
 *   - full tier    → one extra daily PREMIUM session (`weeklySessionsRemaining`
 *     and `resetAt` carry the live balance / next reset; the field name
 *     predates the weekly→daily cadence change and is kept for wire compat).
 *   - limited tier → earn a daily free-session bonus (+1/day per qualified
 *     referral, capped); the GLM-only fields are omitted, and `qualifiedCount`
 *     carries the bonus sessions/day already earned (capped).
 *
 * Present on the pre-join (`none`) response. The CLI branches on the session's
 * `accessTier` to pick the right copy; both variants share the share code,
 * inviter name, and GitHub-linked flag.
 */
export interface FreebuffReferralInfo {
  /** The user's referral code (`user.referral_code`), used to build the share
   *  link. */
  code: string
  /** The inviter's display name (`user.name`), used to personalize the invite
   *  landing page ("X invited you to try Freebuff!"). Null when the user has no
   *  name set. */
  referrerName: string | null
  /** Qualified-referral count for the tier's reward, ALREADY CAPPED on both
   *  branches: full tier = extra premium sessions per day, clamped to
   *  FREEBUFF_REWARD_MAX_DAILY_SESSIONS (uncapped between 2026-07-30 and
   *  2026-08-25); limited tier = daily-session bonus earned, capped at
   *  REFERRAL_CLI_DAILY_SESSION_BONUS_CAP. The CLI knows both constants
   *  locally and renders "(N/cap)" progress copy off them, so a value that
   *  arrived un-clamped would advertise sessions the gate refuses. */
  qualifiedCount: number
  /** Reward-bearing sessions still available in the current reset window
   *  (entitlement − used, ≥ 0). Daily since 2026-07-29; the "weekly" name is
   *  kept for wire compat. Reads the pool the tier's reward is actually paid
   *  into — premium at full access, the reward pool at limited. */
  weeklySessionsRemaining?: number
  /** ISO timestamp of the next reward-pool reset. Both pools share a window,
   *  so this is the same instant at either tier. */
  resetAt?: string
  /** Whether the current user has a GitHub account linked. Referrals only
   *  qualify with a connected, sufficiently-old GitHub, so the CLI prompts
   *  Google-only users to connect one. */
  githubLinked: boolean
}

/**
 * A live bounty-spend promotion, as advertised to every surface.
 *
 * One block drives the CLI banner, the desktop footer, the web picker, the Earn
 * page and the landing eyebrow, so their copy cannot disagree about the size of
 * the promo or when it ends. Present ONLY while the promo is running: absent
 * means every surface renders exactly what it rendered before promos existed,
 * which is what makes closing one an env change rather than a release.
 */
export interface FreebuffGlmPromo {
  /** Sessions per Pacific day an earned user may run while this runs. */
  dailySessions: number
  /** ISO timestamp the promo closes. Surfaces count down to it rather than
   *  hardcoding a date, so the copy can never outlive the server's window. */
  endsAt: string
}

/** Pull the promo block off whichever session status carries it. Same loose
 *  parameter type as `getReferralInfo`, for the same reason. */
export const getGlmPromo = (
  session: { status: string } | null | undefined,
): FreebuffGlmPromo | undefined =>
  session && 'glmPromo' in session
    ? ((session as { glmPromo?: FreebuffGlmPromo }).glmPromo ?? undefined)
    : undefined

/** Pull the referral block off whichever session status carries it. Loose
 *  parameter type for the same reason as `getRateLimitsByModel`. */
export const getReferralInfo = (
  session: { status: string } | null | undefined,
): FreebuffReferralInfo | undefined =>
  session && 'referral' in session
    ? (session as { referral?: FreebuffReferralInfo }).referral
    : undefined

/** Pull the per-model shared session-quota snapshot off whichever statuses
 *  carry it (active, ended, none). Returns undefined for terminal /
 *  pre-join states that have no quota field. The parameter is intentionally
 *  loose so the CLI can pass its `FreebuffSessionResponse` (which adds the
 *  client-only `takeover_prompt` variant) without a discriminated-union
 *  ceremony at every call site. */
export const getRateLimitsByModel = (
  session: { status: string } | null | undefined,
): FreebuffSessionRateLimitByModel | undefined =>
  session && 'rateLimitsByModel' in session
    ? (session as { rateLimitsByModel?: FreebuffSessionRateLimitByModel })
        .rateLimitsByModel
    : undefined

/** Pull the per-model subscription offers off whichever statuses carry them
 *  (none, active, ended). Loose parameter type for the same reason as
 *  `getRateLimitsByModel`. Undefined from a server that predates
 *  subscriptions, so callers render nothing rather than an empty upsell. */
/** The caller's Freebucks block, wherever it rides the response. */
export const getFreebucksInfo = (
  session: { status: string } | null | undefined,
): FreebuffFreebucksInfo | undefined => {
  const info = session && 'freebucks' in session
    ? (session as { freebucks?: FreebuffFreebucksInfo }).freebucks
    : undefined
  return info ? applyFreebucksPriceChanges(info) : undefined
}

/**
 * The access tier the SERVER decided, wherever it rides the response.
 *
 * Not the same thing as the tier a client resolved for itself, and the
 * difference is the point: this is the tier that set the allowance in the same
 * payload, so anything explaining that allowance has to read it here. A client
 * that derives the tier separately can disagree with the number it is
 * labelling — and does, for accounts whose client-side resolution is
 * short-circuited — leaving a menu that claims one thing beside a balance
 * computed from another.
 *
 * Undefined on the variants that do not carry it, so callers fall back rather
 * than assert.
 */
export const getFreebuffServerAccessTier = (
  session: { status: string } | null | undefined,
): FreebuffAccessTier | undefined =>
  session && 'accessTier' in session
    ? (session as { accessTier?: FreebuffAccessTier }).accessTier
    : undefined

/** The free tier's windows off whichever statuses carry them; undefined from
 *  a server that predates the field, for a quota-exempt account, or at
 *  limited access — callers render the daily ring alone in every such case. */
export const getFreeWindowsInfo = (
  session: { status: string } | null | undefined,
): FreebuffFreeWindowsInfo | undefined =>
  session && 'freeWindows' in session
    ? (session as { freeWindows?: FreebuffFreeWindowsInfo }).freeWindows
    : undefined

export const getSubscriptionInfo = (
  session: { status: string } | null | undefined,
): FreebuffSubscriptionInfo | undefined =>
  session && 'subscription' in session
    ? (session as { subscription?: FreebuffSubscriptionInfo }).subscription
    : undefined

/**
 * A capacity-limited model the server is offering RIGHT NOW, beyond whatever
 * the client's own catalog contains.
 *
 * The server is the only thing that knows whether the wave's shared pool still
 * has sessions in it, so it — not the client — decides whether the row exists
 * at all. The field is optional and clients must render nothing when it is
 * absent or empty: that is what makes an exhausted, disabled or not-yet-shipped
 * offer invisible instead of a broken-looking greyed-out row.
 *
 * `remaining`/`total` describe the GLOBAL pool shared by every user, while
 * `userRemaining` describes the caller's own daily ceiling. A row is joinable
 * only while both are non-zero, and the client must treat `userRemaining === 0`
 * as "not now" rather than hiding the row — the user has already had their
 * session and the reset time explains when they get another.
 *
 * The ceiling itself is not on the wire: it is fixed by construction
 * (FREEBUFF_LIMITED_OFFER_SESSION_LIMIT, which no streak or referral can
 * raise), so a client that ever needs "N of M used" reads the shared constant
 * rather than a field the server has to keep consistent.
 */
export interface FreebuffLimitedModelOffer {
  /** Model id; always a member of SUPPORTED_FREEBUFF_MODELS, so the client can
   *  resolve its display name from the shared catalog. */
  model: string
  /** Sessions left in the shared global pool for the current wave. Always > 0
   *  — an exhausted offer is omitted rather than sent as zero. */
  remaining: number
  /** Pool size for the current wave, for "N of M left" copy. */
  total: number
  /** Sessions this user may still start today. May be 0. */
  userRemaining: number
  /** ISO timestamp at which `userRemaining` refills. */
  userResetAt: string
}

/** Pull the limited-model offers off whichever session status carries them.
 *  Loose parameter type for the same reason as `getRateLimitsByModel`. Always
 *  returns an array so callers can map without a presence check. */
export const getLimitedModelOffers = (
  session: { status: string } | null | undefined,
): FreebuffLimitedModelOffer[] =>
  session && 'limitedModelOffers' in session
    ? ((session as { limitedModelOffers?: FreebuffLimitedModelOffer[] })
        .limitedModelOffers ?? [])
    : []

export type FreebuffCountryBlockReason =
  | 'country_not_allowed'
  | 'anonymized_or_unknown_country'
  | 'anonymous_network'
  | 'missing_client_ip'
  | 'unresolved_client_ip'
  | 'ip_privacy_lookup_failed'

export type FreebuffIpPrivacySignal =
  | 'anonymous'
  | 'vpn'
  | 'proxy'
  | 'tor'
  | 'relay'
  | 'res_proxy'
  | 'hosting'
  | 'service'

export type FreebuffSpurStatus =
  | 'not_checked'
  | 'clean'
  | 'suspicious'
  | 'failed'
  /**
   * Deliberately not consulted: the provider is switched off, or its balance
   * is exhausted and the breaker is open.
   *
   * Distinct from `failed` on purpose. `failed` means "we asked and got
   * nothing", which is a signal about the IP's luck and is worth a risk-score
   * floor. `skipped` means "we chose not to ask", which says nothing about the
   * IP at all — scoring it would penalise every request in the world the
   * moment we turn a vendor off. What it does instead is leave the escalation
   * UNRESOLVED when no other provider answered, which the spend ceiling reads
   * as `unverified_egress`.
   */
  | 'skipped'

export type FreebuffScamalyticsStatus =
  | 'not_checked'
  | 'clean'
  | 'suspicious'
  | 'failed'
  /** Deliberately not consulted — switched off, or balance exhausted and the
   *  breaker is open. Same meaning and same reasoning as the Spur variant. */
  | 'skipped'

export type FreebuffPrivacyDecision =
  | 'allowed_clean'
  | 'ipinfo_suspicious_spur_clean'
  | 'corroborated_block'
  | 'cloudflare_tor_block'
  | 'spur_failed_limited'
  /** ipinfo flagged the egress and no second opinion was obtainable at all —
   *  every provider disabled, exhausted, or erroring. Carries the restricted
   *  spend ceiling so a vendor outage cannot widen anyone's budget. */
  | 'unverified_egress_limited'
  | 'scamalytics_failed_limited'
  | 'scamalytics_suspicious_limited'
  | 'ipinfo_failed_limited'
  | 'limited_other'

export type FreebuffPrivacyProviderDecision =
  | 'not_checked'
  | 'cloudflare_tor'
  | 'ipinfo_clean'
  | 'ipinfo_failed'
  | 'ipinfo_only'
  | 'spur_failed'
  | 'scamalytics_failed'
  | 'scamalytics_only'
  | 'corroborated_soft'
  | 'corroborated_hard'

export interface FreebuffLimitedModeReason {
  /** Present for limited access so the model picker can explain why the
   *  reduced model set is shown without re-running geo/IP logic locally. */
  countryCode?: string | null
  countryBlockReason?: FreebuffCountryBlockReason | null
  ipPrivacySignals?: FreebuffIpPrivacySignal[] | null
}

export type FreebuffSessionAdmissionResponse = (
  | ({
      /** User has no session row. CLI must POST to start a session. Also
       *  returned when `getSessionState` notices the user has been swept past
       *  the grace window. */
      status: 'none'
      accessTier?: FreebuffAccessTier
      message?: string
      /** Current quota snapshots for free models, keyed by model id. Lets
       *  the picker show today's session usage before the user commits
       *  to a model. */
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
      /** Referral status for the "invite friends" banner. Full tier advertises
       *  an extra premium session; limited tier advertises a daily
       *  free-session bonus. */
      referral?: FreebuffReferralInfo
      /** Capacity-limited models the picker may additionally offer right now.
       *  Only sent on the pre-join response, which is the only state that
       *  renders a picker. Absent whenever the pool is spent or the offer is
       *  off — see FreebuffLimitedModelOffer. */
      limitedModelOffers?: FreebuffLimitedModelOffer[]
      /**
       * The account's Access Level and the limits it currently selects.
       *
       * Sent on the pre-join response only, which is the state that renders a
       * picker and therefore the one place a client can explain the numbers
       * next to the models they apply to. Absent when the feature is off, so
       * a client renders it only when there is something true to render.
       */
      standing?: FreebuffStandingInfo
      /**
       * Purchasable per-model subscriptions and the caller's state on each.
       *
       * Sent on the pre-join response because that is the state that renders a
       * picker, and the picker is where "subscribe" belongs. Absent when the
       * catalog is empty or the server predates subscriptions.
       */
      subscription?: FreebuffSubscriptionInfo
      /** See FreebuffFreeWindowsInfo. */
      freeWindows?: FreebuffFreeWindowsInfo
      /** Spendable Freebucks and the per-model session prices. Rides
       *  every state for the same reason `subscription` does: the
       *  balance is shown in the picker, mid-session and after it. */
      freebucks?: FreebuffFreebucksInfo
    } & FreebuffLimitedModeReason)
  | ({
      status: 'active'
      accessTier: FreebuffAccessTier
      instanceId: string
      /** Model the active session is bound to — cannot change mid-session. */
      model: string
      admittedAt: string
      expiresAt: string
      remainingMs: number
      /** Shared free-session quota for this model. */
      rateLimit?: FreebuffSessionRateLimit
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
      /** Included for Web/Cloud picker reads that request full quota details. */
      referral?: FreebuffReferralInfo
      /** Subscription offers and state, so an in-session picker can still
       *  render "subscribed" badges and an upgrade CTA. */
      subscription?: FreebuffSubscriptionInfo
      /** See FreebuffFreeWindowsInfo. */
      freeWindows?: FreebuffFreeWindowsInfo
      /** Spendable Freebucks and the per-model session prices. Rides
       *  every state for the same reason `subscription` does: the
       *  balance is shown in the picker, mid-session and after it. */
      freebucks?: FreebuffFreebucksInfo
    } & FreebuffLimitedModeReason)
  | ({
      /** Session is over. While `instanceId` is present we're inside the
       *  server-side grace window — chat requests still go through so the
       *  agent can finish, but the CLI must not accept new prompts. Once
       *  `instanceId` is absent the session is fully gone and the user must
       *  rejoin via POST.
       *
       *  Server-supplied form (in-grace) carries the timing fields; the
       *  client may also synthesize a no-grace `{ status: 'ended' }` when a
       *  poll reveals the row was swept. Both render the same UI. */
      status: 'ended'
      /** Final early-end refund receipt, including zero; retries return the same amount. */
      freebucksRefund?: number
      /** Final usage is still outstanding; replay DELETE with the same instance for its receipt. */
      freebucksRefundPending?: boolean
      accessTier?: FreebuffAccessTier
      instanceId?: string
      admittedAt?: string
      expiresAt?: string
      gracePeriodEndsAt?: string
      gracePeriodRemainingMs?: number
      /** Snapshot of the user's free-session quota at the moment the
       *  session ended. Lets the post-session banner show "N of M sessions
       *  used today" without an extra round-trip. */
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
      /** Included for Web/Cloud picker reads that request full quota details. */
      referral?: FreebuffReferralInfo
      /** Carried like `rateLimitsByModel`: the post-session banner and picker
       *  keep the plan rings without a round-trip. */
      subscription?: FreebuffSubscriptionInfo
      /** See FreebuffFreeWindowsInfo. */
      freeWindows?: FreebuffFreeWindowsInfo
      /** Spendable Freebucks and the per-model session prices. Rides
       *  every state for the same reason `subscription` does: the
       *  balance is shown in the picker, mid-session and after it. */
      freebucks?: FreebuffFreebucksInfo
    } & FreebuffLimitedModeReason)
  | {
      /** Request originated outside the free-mode allowlist, or from an
       *  unknown/anonymized location that cannot be trusted for free mode.
       *  Returned before a session is started so users aren't rejected on
       *  their first chat request. Terminal —
       *  CLI stops polling and shows a "not available in your country"
       *  screen. `countryCode` is the resolved country, or UNKNOWN. */
      status: 'country_blocked'
      message?: string
      countryCode: string
      countryBlockReason?: FreebuffCountryBlockReason
      ipPrivacySignals?: FreebuffIpPrivacySignal[]
    }
  | {
      /** User has an active session bound to a different model. Returned
       *  from POST /session when they pick a new model without ending their
       *  current session first. The CLI shows a confirmation prompt: "End
       *  your active DeepSeek session to switch?" → on confirm, DELETE then
       *  re-POST with the new model. */
      status: 'model_locked'
      accessTier?: FreebuffAccessTier
      currentModel: string
      requestedModel: string
    }
  | {
      /** Requested model is valid but not selectable right now. */
      status: 'model_unavailable'
      accessTier?: FreebuffAccessTier
      requestedModel: string
      /**
       * Prose, and quoted in UTC with the zone NAMED — the server cannot know
       * where the reader is, and the container it runs in is not a guess worth
       * making. Every client still renders this when `availableAt` is absent.
       */
      availableHours: string
      /**
       * When the model comes back, as an ISO instant — present only for a
       * closure with a computable return time (today, the DeepSeek peak
       * window). An instant rather than a rendered time because the ONLY
       * process that knows the reader's timezone is the client: this is what
       * lets Desktop say "12:00 PM GMT+2" to a user in Berlin for the same
       * moment the server calls 10:00 AM UTC. Absent on older servers, so
       * `availableHours` stays the floor rather than the fallback.
       */
      availableAt?: string
      /**
       * The model is PRO-ONLY and this account has no paid plan — a different
       * refusal from the deployment-hours one, and the only one an upgrade
       * fixes. Older clients ignore it and still render `availableHours`,
       * which carries the same sentence in prose.
       */
      requiresSubscription?: boolean
      /**
       * The model is WITHDRAWN from free mode (FREEBUFF_PAUSED_FREE_MODEL_IDS)
       * rather than merely closed for the hour — permanent, so retrying later
       * is not the advice. Set at ADMISSION, so no row is minted and no session
       * unit is spent on a pick that cannot run a turn.
       *
       * Older clients ignore it and still render `availableHours`, which
       * carries the same sentence in prose — the same arrangement
       * `requiresSubscription` uses above, and for the same reason: every
       * released binary keeps this id in its compiled-in catalog and keeps
       * sending it, so the refusal has to read correctly on builds that predate
       * the field.
       */
      withdrawn?: boolean
    }
  | {
      /** Account is banned. Returned from every endpoint so banned bots can't
       *  start a session at all. Terminal — CLI stops polling and shows a
       *  banned message. */
      status: 'banned'
    }
  | {
      /** Too many DISTINCT users already hold an active free session on this
       *  egress IP. Admission-only: existing sessions on the IP keep running,
       *  and the request succeeds once one of them ends, so unlike
       *  `rate_limited` this is not tied to a quota reset. Sent as 429 so
       *  older CLIs that don't know the status still back off rather than
       *  tight-poll a 200 they can't parse. */
      status: 'ip_capped'
      accessTier?: FreebuffAccessTier
      model: string
      /** Distinct users currently active on the IP (excluding the caller). */
      activeUsersForIp: number
      /** The configured ceiling (FREEBUFF_IP_USER_CAP). */
      limit: number
      retryAfterMs: number
    }
  | {
      /** User has used up their shared free-session quota for the current
       * Pacific day or week. Returned from POST /session before a session is
       * started. `retryAfterMs` is the time until that period resets. Terminal
       * for the CLI's current poll session; the user can exit and return later. */
      status: 'rate_limited'
      accessTier?: FreebuffAccessTier
      /** The way out of this refusal, when there is one to sell. */
      upgrade?: FreebuffUpgradeHint
      /** Not sent by the server on a refusal; a client may CARRY the block it
       *  was holding so the refusal is still rendered in the meter's words. */
      freebucks?: FreebuffFreebucksInfo
      /** The freebuff model the user tried to join. */
      model: string
      /** The pool that refused, as on `FreebuffSessionRateLimit` — opaque. */
      pool?: string
      poolLabel?: string
      /**
       * Present when the FREEBUCKS METER refused (2026-09-02): the model's
       * session price against what the account could spend. A client that
       * knows the currency says "N Freebucks short"; older clients read the
       * daily figures above as an ordinary pool.
       */
      freebucksShortfall?: { price: number; balance: number }
      /** Max session units permitted per period (e.g. the configured daily
       * premium allowance, including the earned reward on top of it — or, at
       * limited access, the reward balance plus streak entitlement). */
      limit: number
      /** Additive detail for `limit`; absent on older servers. */
      entitlementBreakdown?: FreebuffSessionEntitlementBreakdown
      period: 'pacific_day' | 'pacific_week' | 'pacific_month'
      resetTimeZone: string
      resetAt: string
      /** Deprecated wire field kept for older clients. */
      windowHours: number
      /** Session units since the current Pacific period began — will be ≥ limit. */
      recentCount: number
      /** Milliseconds from now until the next Pacific period reset. */
      retryAfterMs: number
    }
  | {
      /** The user has reached today's cross-model Freebuff provider-spend
       *  budget. This only blocks a fresh session admission: sessions already
       *  running, including a reconnect to the same live session, continue. */
      status: 'spend_limited'
      accessTier?: FreebuffAccessTier
      /** See `rate_limited`: carried by the client, never sent. */
      freebucks?: FreebuffFreebucksInfo
      message: string
      resetAt: string
      retryAfterMs: number
      /** The way out of this refusal, when there is one to sell. */
      upgrade?: FreebuffUpgradeHint
    }
  | {
      /** Retired single-use Desktop claim; persist a new id before retrying. */
      status: 'purchase_claim_released'
      accessTier?: FreebuffAccessTier
    }
  | {
      status: 'purchase_in_use' | 'purchase_capacity'
      accessTier?: FreebuffAccessTier
      requestedModel: string
      currentInstanceId: string
    }
  | {
      /** Freebuff Desktop only: every slot-bound session is occupied. Free
       *  accounts get one slot-bound and three multi-tab sessions; subscribers
       *  get three and eight. Limited free access makes every model slot-bound.
       *
       *  The desktop client surfaces this and steers the tab to an unlimited
       *  model (or closes the holding tab). Never returned to CLI/web, which
       *  run one session per user. */
      status: 'premium_slot_taken'
      accessTier?: FreebuffAccessTier
      /** Model this tab tried to start. */
      requestedModel: string
      /** Model of the premium-bucket session already running. */
      currentModel: string
      /** Instance id of the existing premium-bucket session, so the client can
       *  offer "switch to / close that one". */
      currentInstanceId: string
    }
) & {
  /** Unexpired Desktop purchases, including occupied hours. Picker metadata;
   * admission still checks ownership, liveness, and capacity atomically. */
  desktopPurchases?: FreebuffDesktopPurchaseInfo[]
  desktopRefunds?: FreebuffDesktopRefundInfo[]
  /** Multi-session Desktop responses only. Counts live, unexpired rows across
   * all Desktop processes for this user. */
  desktopSessionCounts?: FreebuffDesktopSessionCounts
}

export type FreebuffSessionServerResponse =
  | FreebuffSessionAdmissionResponse
  | {
      /** Another CLI on the same account rotated our instance id. Polling
       *  stops and the UI shows a "close the other CLI" screen. The server
       *  returns this from GET /session when the caller's instance id
       *  doesn't match the stored one; the chat-completions gate also
       *  surfaces it as a 409 for fast in-flight feedback. */
      status: 'superseded'
      desktopSessionCounts?: FreebuffDesktopSessionCounts
      desktopPurchases?: FreebuffDesktopPurchaseInfo[]
      desktopRefunds?: FreebuffDesktopRefundInfo[]
    }

/** Emitted only after the reversal ledger entry and purchase marker commit. */
export interface FreebuffDesktopRefundInfo {
  /** Durable execution claims belonging to this purchase; omitted by older APIs. */
  claimInstanceIds?: string[]
  purchaseId: string
  model: string
  amount: number
  walletAmount: number
  /** Refunded bonus retired in the same settlement; absent on older APIs. */
  expiredBonusAmount?: number
  refundedAt: string
  /** Original debit's accounting instant; identifies the daily pool restored. */
  poolDate: string
}

export interface FreebuffDesktopPurchaseInfo {
  model: string
  expiresAt: string
  holderInstanceId?: string
}

/**
 * The session gate on `/api/v1/chat/completions`, as a wire contract.
 *
 * A rejection is identified by its `error` code paired with its HTTP status,
 * never by its `message` — the prose is written for whoever is sitting in front
 * of the client and is free to be rewritten. BOTH halves are required to match:
 * 409/410 are ordinary provider outcomes on their own, and the codes are
 * generic enough that an upstream error body can echo one, so a status-only or
 * code-only test lets an unrelated failure impersonate the gate.
 *
 * `endsTheSession` marks the codes that mean the caller's row is GONE. Every
 * one of them has the same recovery — forget the dead window and re-admit on
 * the same instance id — which is why clients collapse them into one state
 * rather than handling four. `false` is a refusal the session survives.
 *
 * Lives here because three surfaces need it and it drifted into three copies:
 * the server that emits it (chat/completions), the CLI that matches it, and
 * Desktop, which classifies it out of the SDK's relayed `AgentOutput`. See
 * docs/freebuff-session-admission.md.
 */
export const FREEBUFF_GATE_CODES = {
  waiting_room_required: { status: 428, endsTheSession: true },
  session_expired: { status: 410, endsTheSession: true },
  session_superseded: { status: 409, endsTheSession: true },
  session_model_mismatch: { status: 409, endsTheSession: true },
  /** The ACCOUNT is over its concurrent-tab budget; this tab's row is fine. */
  session_limit_reached: { status: 409, endsTheSession: false },
  /** Transient admission race — the row was caught mid-admit. */
  waiting_room_queued: { status: 429, endsTheSession: false },
  /**
   * The model has been withdrawn from free mode. Terminal for the REQUEST, and
   * deliberately NOT session-ending.
   *
   * A withdrawn model is one every released binary still has in its
   * compiled-in catalog, so the client asks again on the next send no matter
   * what we answer. `endsTheSession: true` would make each of those a fresh
   * admission — the loop that cost the limited tier 2.5x its admissions and put
   * 91% of its sessions on the 0.1-unit floor (#1801). False, the client keeps
   * its window, shows the message, and the user picks another model.
   *
   * 410 rather than 409: the resource is gone rather than in conflict, and it
   * reads correctly to a caller that has no idea what this code means.
   */
  model_unavailable: { status: 410, endsTheSession: false },
} as const satisfies Record<string, { status: number; endsTheSession: boolean }>

export type FreebuffGateCode = keyof typeof FREEBUFF_GATE_CODES

/** The gate rejection this error output describes, or null for anything else.
 *  `output` is any shape carrying the relayed `error`/`statusCode` pair.
 *
 *  `Object.hasOwn`, not `in`: the code is whatever an upstream error body put in
 *  its `error` field, so `in` would accept inherited names like `toString` —
 *  and since their `.status` is undefined, an output carrying no `statusCode`
 *  would then satisfy the status check too and be classified as a gate
 *  rejection. */
export function getFreebuffGateCode(output: {
  error?: string | undefined
  statusCode?: number | undefined
}): FreebuffGateCode | null {
  const code = output.error
  if (!code || !Object.hasOwn(FREEBUFF_GATE_CODES, code)) return null
  const gate = FREEBUFF_GATE_CODES[code as FreebuffGateCode]
  return gate.status === output.statusCode ? (code as FreebuffGateCode) : null
}
