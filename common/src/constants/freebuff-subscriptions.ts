import { FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID } from './freebuff-model-ids'
import {
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS,
  FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS,
  getFreebuffWebModel,
} from './freebuff-models'
import {
  formatDeepSeekExpensiveWindowLocal,
  formatDeepSeekOffPeakWindowLocal,
  isDeepSeekExpensiveWindow,
} from './freebuff-peak-hours'

/**
 * Paid Freebuff subscription tiers.
 *
 * **One subscription per account, not per model.** A tier grants a single
 * pooled session allowance that every subscribable model draws from, so a user
 * picks a plan rather than assembling one. Upgrading swaps the tier on the same
 * subscription; there is exactly one row per user either way.
 *
 * **This file is published.** `common` ships wholesale to the public mirror
 * (docs/public-repo-sync.md), so everything here is world-readable — limits and
 * prices are product facts we would put on a pricing page anyway. Stripe price
 * ids are deliberately NOT here; they live in server env keyed by tier id, so
 * the catalog can be read by a client without handing anyone the objects that
 * mint a checkout.
 */

/** Models a subscription's pooled allowance can be spent on. */
// DeepSeek V4 Pro left this set on 2026-08-26 with its withdrawal from free
// mode (FREEBUFF_PAUSED_FREE_MODEL_IDS). A subscribable model has to be a model
// admission will actually open a session on, or the plan sells a row whose
// first send fails; GLM 5.3 Flash takes its place in the same slot.
export const FREEBUFF_SUBSCRIPTION_MODEL_IDS: readonly string[] =
  FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS

/**
 * The expensive half of the pool, sub-capped within each day.
 *
 * Measured 2026-08-21: Luna and DeepSeek V4 Pro each cost roughly 4-5x Flash
 * per hour-session (dollar figures live in the internal cost notes, not in
 * this exported file). Without a sub-cap a subscriber
 * spending every daily session on Luna costs 5x one spending them on Flash, at
 * the same price, so the daily allowance would have to be priced for the worst
 * case and would be small for everyone.
 *
 * Kimi K3 Eco is deliberately NOT here. It is one of the god-only models in
 * `GOD_ONLY_BAIT_MODEL_IDS` (web/src/llm-api/honeypot-models.ts) reached
 * mostly by API probers, so its measured cost describes short aborted
 * sessions rather than real use and cannot be priced against. Revisit once it
 * carries genuine client traffic.
 */
export const FREEBUFF_SUBSCRIPTION_PREMIUM_MODEL_IDS: readonly string[] =
  Object.freeze([
    // GLM 5.3 Flash is cheap enough to be unmetered for ordinary full-access
    // users. It remains in this subscription-only classification because that
    // list controls the plan's daily sub-cap, not free-tier entitlement.
    FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    // Gemini 3.8 Flash is the dearest row in the catalog per message, so it
    // belongs in the sub-capped half for exactly the reason this list exists:
    // without the cap, a subscriber spending every daily session here would
    // have to be priced for, and the allowance would shrink for everyone.
    FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  ])

export function isFreebuffSubscriptionPremiumModelId(modelId: string): boolean {
  return FREEBUFF_SUBSCRIPTION_PREMIUM_MODEL_IDS.includes(modelId)
}

/**
 * The DeepSeek models a plan's peak-hours pause applies to.
 *
 * Named explicitly rather than matched on an id prefix: a prefix would sweep in
 * any future `deepseek/*` id automatically, and silently pausing a model nobody
 * decided to pause is the kind of change that should require an edit here.
 *
 * EMPTY since 2026-08-28, when the peak pause was removed along with Flash's
 * own peak closure. Emptied rather than deleted: the pause is a lever we may
 * want again if a provider reprices, and the list is the whole of it.
 *
 * Flash had to leave for a reason worth recording. While it was `off_peak_only`
 * this membership was INVISIBLE -- the row was already shut at peak, so the
 * plan-pause label suppressed itself and nothing rendered. Reopening the row
 * un-suppressed it, and the label immediately began advertising "Plan paused
 * 5:00 PM - 3:00 AM PDT" for a pause whose enforcement had just been deleted.
 * A test caught it; nothing else would have, because the string had never been
 * reachable before.
 *
 * The general shape: removing one gate can expose copy that a second gate was
 * silently hiding. Two suppressions on one string means neither is load-bearing
 * until the other goes.
 */
export const FREEBUFF_SUBSCRIPTION_PEAK_PAUSED_MODEL_IDS: readonly string[] =
  Object.freeze([])

export function isFreebuffSubscriptionPeakPausedModelId(
  modelId: string,
): boolean {
  return FREEBUFF_SUBSCRIPTION_PEAK_PAUSED_MODEL_IDS.includes(modelId)
}

export function isFreebuffSubscriptionModelId(modelId: string): boolean {
  return FREEBUFF_SUBSCRIPTION_MODEL_IDS.includes(modelId)
}

/** Tier identifiers. Ordered: a higher index is a strictly larger plan. */
export const FREEBUFF_SUBSCRIPTION_TIER_IDS = [
  'starter',
  'plus',
  // Restored 2026-08-31 with the marketed-totals retune. Its Stripe price
  // already existed from the withheld launch, so restoring it was this edit.
  'pro',
] as const
export type FreebuffSubscriptionTierId =
  (typeof FREEBUFF_SUBSCRIPTION_TIER_IDS)[number]

export interface FreebuffSubscriptionTier {
  id: FreebuffSubscriptionTierId
  displayName: string
  /** Every period after the first, in USD. */
  priceUsd: number
  /**
   * First billing period, in USD.
   *
   * **Proportional, not flat, since 2026-09-03**: $3 / $6 / $15 off, so the
   * discount grows with the tier instead of vanishing into it. A flat $3 was
   * 38% off Starter and 5% off Pro — the tier with the most to prove got the
   * least reason to try. The earlier $2.50/$12 intros went the other way and
   * discounted most of the entry price, which anchored the product at the
   * discount rather than at $8/mo.
   *
   * **This number is DISPLAY ONLY — the charge is a Stripe coupon**
   * (`FREEBUFF_SUBSCRIPTION_INTRO_COUPON_IDS`, resolved in
   * `web/src/server/model-subscriptions/pricing.ts`). Nothing in code can
   * reconcile the two, so changing a figure here without minting the matching
   * coupon advertises a price we do not charge. The coupon ids encode their
   * own amount in cents (`freebuff_intro_pro_1500c`) precisely so the
   * mismatch is visible in the env var.
   *
   * Charged at most once per ACCOUNT. Whichever tier a user starts on consumes
   * it, so upgrading later pays full price — which is why `intro_used` lives
   * on the user's single subscription row rather than per tier.
   */
  introPriceUsd: number
  /** Pooled sessions per Pacific day. One session is one hour. */
  dailySessions: number
  /**
   * Pooled sessions per rolling 5-day window.
   *
   * Sits between the daily and monthly caps so one intense week cannot eat the
   * month. Rolling rather than a fixed period: a fixed one has a reset cliff
   * that rewards waiting for it, and the counting query is identical either way.
   */
  fiveDaySessions: number
  /** Pooled sessions per billing period. */
  monthlySessions: number
  /**
   * How many of the DAILY sessions may be spent on premium models
   * (Luna / GLM 5.3 Flash). The rest must go to the cheaper pool.
   */
  dailyPremiumSessions: number
  /**
   * Whether DeepSeek models are withheld during their double-priced peak
   * windows (common/constants/freebuff-peak-hours.ts). Surfaced to clients as
   * a disclaimer on the plan.
   */
}

/**
 * The FREE tier's marketed allowance (2026-08-31) — the baseline every plan
 * card's TOTALS are built on, and the numbers the free-tier windows enforce.
 *
 * One definition on purpose: the plans page renders `free + plan` totals from
 * this, and the admission windows meter against it, so the advertised number
 * and the enforced number cannot drift. Limited-access accounts have no free
 * premium allowance — their surfaces show plan-only figures and their MiMo
 * pool is metered (and displayed) separately.
 */
export const FREEBUFF_FREE_TIER_ALLOWANCE = Object.freeze({
  dailySessions: 4,
  weeklySessions: 14,
  monthlySessions: 40,
})

export const FREEBUFF_SUBSCRIPTION_TIERS: readonly FreebuffSubscriptionTier[] =
  Object.freeze([
    // Retuned 2026-08-31 to the MARKETED-TOTALS model. The numbers users see
    // are per-tier TOTALS (free allowance + plan): Free 4/14/40/$20, Starter
    // 7/24/70/$35, Plus 11/40/140/$70, Pro 15/80/250/$200. Each plan window
    // here is total − free, because free pools burn first and the plan only
    // meters what they did not absorb. The weekly figures ride the (renamed)
    // rolling window, which widened 5 → 7 days in the same retune — the wire
    // field keeps its `fiveDay` name so released clients keep parsing.
    {
      id: 'starter',
      displayName: 'Starter',
      priceUsd: 8,
      introPriceUsd: 5,
      dailySessions: 3,
      fiveDaySessions: 10,
      monthlySessions: 30,
      // Equal to dailySessions: the Luna/Pro sub-cap was LIFTED (2026-08-26).
      // Kept as a field rather than deleted so the wire shape and the
      // enforcement stay in place — set it lower again to reinstate the cap
      // without touching code.
      dailyPremiumSessions: 3,
    },
    {
      id: 'plus',
      displayName: 'Plus',
      priceUsd: 25,
      introPriceUsd: 19,
      dailySessions: 7,
      fiveDaySessions: 26,
      monthlySessions: 100,
      // Equal to dailySessions — sub-cap lifted; see the starter tier note.
      dailyPremiumSessions: 7,
    },
    {
      id: 'pro',
      displayName: 'Pro',
      priceUsd: 60,
      introPriceUsd: 45,
      dailySessions: 11,
      fiveDaySessions: 66,
      monthlySessions: 210,
      // Sub-cap lifted, like the others.
      dailyPremiumSessions: 11,
    },
  ] satisfies FreebuffSubscriptionTier[])

const TIERS_BY_ID = new Map(FREEBUFF_SUBSCRIPTION_TIERS.map((t) => [t.id, t]))

export function freebuffSubscriptionTier(
  id: string | null | undefined,
): FreebuffSubscriptionTier | undefined {
  return id ? TIERS_BY_ID.get(id as FreebuffSubscriptionTierId) : undefined
}

/** The next tier up, or undefined at the top. Drives every upgrade CTA. */
export function nextFreebuffSubscriptionTier(
  id: string | null | undefined,
): FreebuffSubscriptionTier | undefined {
  if (!id) return FREEBUFF_SUBSCRIPTION_TIERS[0]
  const index = FREEBUFF_SUBSCRIPTION_TIERS.findIndex((t) => t.id === id)
  return index === -1 ? undefined : FREEBUFF_SUBSCRIPTION_TIERS[index + 1]
}

/** Rank for comparing tiers. -1 when unknown, so callers can treat it as none. */
export function freebuffSubscriptionTierRank(id: string | null | undefined) {
  return FREEBUFF_SUBSCRIPTION_TIERS.findIndex((t) => t.id === id)
}

/**
 * Human-readable constraints for a tier, for the plan card and the paywall.
 *
 * Built here rather than in each client so the CLI, the Web dropdown and the
 * settings page cannot describe the same plan three different ways.
 */
export function freebuffSubscriptionTierDisclaimers(
  tier: FreebuffSubscriptionTier,
): string[] {
  // Deliberately does NOT restate the day/5-day/month figures: every surface
  // that shows these also shows those three numbers, and repeating them reads
  // as three different rules rather than one.
  const out = [
    // The Luna/Pro sub-cap line is emitted only while a cap actually binds —
    // with the cap lifted (dailyPremiumSessions === dailySessions) the
    // sentence would describe a restriction that does not exist.
    ...(tier.dailyPremiumSessions < tier.dailySessions
      ? [
          `${tier.dailyPremiumSessions} of your ${tier.dailySessions} daily sessions can be GPT 5.6 Luna or GLM 5.3 Flash; the rest use DeepSeek V4 Flash or Kimi K3 Eco`,
        ]
      : []),
    // Says "weekly" and takes the length from the constant: the window widened
    // 5 -> 7 days on 2026-08-31 and only the `fiveDay*` WIRE fields were meant
    // to keep the old name, but this sentence and two account-page labels were
    // left describing a five-day rule that no longer exists.
    `The weekly limit is a rolling ${FREEBUFF_SUBSCRIPTION_FIVE_DAY_WINDOW_DAYS}-day window — it frees up as your oldest sessions age out, rather than resetting on a fixed day`,
    'Daily hours reset at midnight Pacific; unused ones do not carry over',
    'Adds to your free sessions rather than replacing them',
  ]
  out.push('Limits are subject to change')
  return out
}

/**
 * Subscription period reset zone. Deliberately the same Pacific day boundary
 * the free pools reset on: a subscriber must not see two different "resets at"
 * times in one picker.
 */
export const FREEBUFF_SUBSCRIPTION_RESET_TIMEZONE = 'America/Los_Angeles'

/** Length of the rolling mid-window, in days. */
// 7 since 2026-08-31 (was 5): the marketed windows are per WEEK. The name and
// every `fiveDay*` wire field survive so released clients keep parsing; only
// the labels changed.
export const FREEBUFF_SUBSCRIPTION_FIVE_DAY_WINDOW_DAYS = 7

/**
 * Models that ONLY a paid session may open — the "Pro" rows.
 *
 * Distinct from `FREEBUFF_SUBSCRIPTION_MODEL_IDS`, which lists models a plan
 * meters. Those are available to everyone and the plan merely adds sessions;
 * these are available to subscribers ONLY, so a free account cannot start one
 * at all. Every id here must ALSO be in that list, or the paywall sells a row
 * the plan it sells cannot open.
 *
 * The rows are still LISTED to a free account, without a price, and selecting
 * one opens the plans page. That is deliberate and is the same call
 * `LIMITED_TIER_PLAN_LOCKED_MODELS` documents: a row the user cannot start is
 * worth drawing when the only thing in the way is a plan we sell. The price is
 * suppressed because a Freebucks figure beside a row Freebucks cannot buy
 * reads as the way in, and sends the user to spend a balance that will not
 * open it.
 *
 * ## Why Gemini 3.8 Flash
 *
 * Gemini 3.8 Flash was withdrawn outright the day it shipped and restored as
 * a Web-only paid row. GPT-5.6 Luna is deliberately NOT in this set: it stays
 * plan-locked at limited access, but full-access users may spend their shared
 * premium allowance on it just as CLI and Desktop users can.
 *
 * ## Scope
 *
 * Enforced on FREEBUFF WEB ONLY — see FREEBUFF_PRO_ENFORCED_SURFACES. Gemini is
 * absent from the CLI/Desktop catalog, so the Web-only listing and Web-only
 * gate stay paired. Widening is one edit to that constant, and should be made
 * with a client release rather than ahead of one.
 *
 * Withdrawn history: V4 Pro was the one entry for a few hours (#2254) and left
 * on 2026-08-26 with its withdrawal from free mode — a row nothing may admit
 * cannot be sold. Nothing here is reachable without a deploy either way; the
 * `FREEBUFF_PRO_ONLY_MODEL_IDS` env list adds ids without one.
 */
export const FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS: readonly string[] =
  FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS

/**
 * The Pro rows are enforced on **Freebuff Web only**, for now.
 *
 * The current Pro row, Gemini 3.8 Flash, is Web-only too. A future native
 * rollout must add the surface here before adding the row to the shared
 * CLI/Desktop catalog, and must ship clients that understand the refusal
 * before the server can take a model away from them.
 *
 * Luna is deliberately outside this policy: it is available from the shared
 * premium pool on every full-access surface.
 *
 * Web is identified server-side by the Freebuff Web SERVICE ACCOUNT key, never
 * by a client-supplied header, so a CLI cannot claim to be Web to dodge the
 * paywall — nor claim to be Desktop to reach the paid lane for free.
 */
export const FREEBUFF_PRO_ENFORCED_SURFACES = ['freebuff-web'] as const

/**
 * V4 Pro on Web is served by **DeepSeek direct**, whose card DOUBLES inside the
 * peak windows — which is exactly why the row is closed there rather than sold
 * at twice the cost. Distinct from the plan-level pause: this row is shut
 * outright on Web, for subscribers too.
 *
 * SCOPED TO THE DEEPSEEK ROW BY ID, not to "whatever is Pro-only". It tested
 * the Pro list while that list held exactly one entry and that entry was this
 * model, so the two readings coincided and the narrower one was never written
 * down. They stopped coinciding on 2026-09-04, when Luna and Gemini 3.8 Flash
 * became the Pro rows: both are served by lanes that have no peak window at
 * all, and the old predicate would have shut them for fourteen hours a day
 * with an explanation about DeepSeek's card that is not true of either.
 *
 * The closure belongs to the LANE, so it names the model whose lane it is. A
 * future Pro row on DeepSeek direct joins the list below; one on any other
 * provider must not.
 */
const FREEBUFF_WEB_PEAK_CLOSED_PRO_MODEL_IDS: readonly string[] = Object.freeze(
  [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID],
)

export function isFreebuffWebProClosedNow(
  id: string,
  now: Date = new Date(),
): boolean {
  if (!isFreebuffWebPeakClosedProModelId(id)) return false
  return isDeepSeekExpensiveWindow(now)
}

/**
 * Whether the peak closure applies to this row AT ALL, independent of the hour.
 *
 * Separate from `isFreebuffWebProClosedNow` because a PICKER asks a different
 * question than an admission gate does. Admission asks "is it shut right now";
 * the picker has to decide whether to draw an hours badge at every hour,
 * including the hours the row is open — a badge that appeared only once the
 * door was already shut would be useless for planning around.
 *
 * The picker used to derive that badge from `isFreebuffSubscriptionProModelId`,
 * which was indistinguishable from this while V4 Pro was the only Pro row. It
 * stopped being true on 2026-09-04, and the result was Luna and Gemini 3.8
 * Flash both advertising `Open 3:00 AM - 5:00 PM PDT` — hours neither of them
 * has, taken from a third model's provider.
 */
export function isFreebuffWebPeakClosedProModelId(id: string): boolean {
  return FREEBUFF_WEB_PEAK_CLOSED_PRO_MODEL_IDS.includes(id)
}

/** "3:00 AM – 5:00 PM" — when the Web Pro row is open, in the reader's zone. */
export function freebuffWebProOpenWindowLabel(
  now: Date = new Date(),
  timeZone?: string,
): string {
  return formatDeepSeekOffPeakWindowLocal(now, timeZone)
}

/** Whether `model` may only be opened on a paid session. Suffix-tolerant, like
 *  the other model predicates, so a dated provider snapshot cannot dodge it. */
export function isFreebuffSubscriptionProModelId(
  model: string | null | undefined,
  /** Extra ids from the server-side env knob; ignored on the client. */
  extra: readonly string[] = [],
): boolean {
  if (!model) return false
  const ids = [...FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS, ...extra]
  return ids.some((id) => model === id || model.startsWith(`${id}-`))
}

/**
 * When a PLAN's sessions on this model pause, for a subscriber.
 *
 * Deliberately separate from a model's own availability, because the two
 * differ: DeepSeek V4 Pro is open to everyone at every hour, but PLAN sessions
 * on it pause inside the expensive window — they fall back to the free pools,
 * paused rather than cut off. Only a subscriber sees this, and only on rows
 * where it is true.
 *
 * Lives here rather than beside the availability label because that module is
 * imported by this one; the reverse would be a cycle.
 */
export function getFreebuffPlanPauseWindowLabel(
  id: string,
  now: Date = new Date(),
  timeZone?: string,
): string | undefined {
  if (!FREEBUFF_SUBSCRIPTION_PEAK_PAUSED_MODEL_IDS.includes(id))
    return undefined
  // A model already closed outright at peak needs no second sentence about it —
  // its availability label already names the same window.
  if (getFreebuffWebModel(id)?.availability === 'off_peak_only')
    return undefined
  return `Plan paused ${formatDeepSeekExpensiveWindowLocal(now, timeZone)}`
}

/**
 * The offboarding question, asked once at cancellation.
 *
 * A short fixed list plus `other`, because a free-text-only box produces
 * answers nobody can count. The server validates against these ids, so a
 * client cannot invent a reason that would then have to be cleaned up in
 * reporting.
 */
export const FREEBUFF_CANCELLATION_REASONS = [
  { id: 'too_expensive', label: 'Too expensive' },
  { id: 'not_enough_usage', label: "I didn't use it enough" },
  { id: 'missing_models', label: 'Missing models or features' },
  { id: 'quality', label: 'Quality or reliability' },
  { id: 'other', label: 'Other' },
] as const

export type FreebuffCancellationReasonId =
  (typeof FREEBUFF_CANCELLATION_REASONS)[number]['id']

export function isFreebuffCancellationReason(
  value: unknown,
): value is FreebuffCancellationReasonId {
  return (
    typeof value === 'string' &&
    FREEBUFF_CANCELLATION_REASONS.some((reason) => reason.id === value)
  )
}

/**
 * What a subscriber gives up by cancelling, in the one term that matters:
 * today's beta pricing is not the standing price, and it is not held for an
 * account that leaves.
 *
 * Stated as a multiple rather than a future dollar figure because no future
 * price has been set — promising "$24" would be inventing one. Keep this the
 * single source for the wording so the settings page, the cancel dialog and
 * any email cannot drift into three different promises.
 */
export const FREEBUFF_BETA_RATE_LOCK_MULTIPLIER = 3

/**
 * Plan allowances, in HOURS.
 *
 * "3/day" left people guessing at the unit — 3 what? Every allowance here is
 * counted in one-hour sessions, so the copy says hours and the ambiguity goes
 * away. One helper rather than a string per surface, because the settings
 * list, the plans page, the welcome page and the dropdown were each spelling
 * it their own way.
 */
export function freebuffPlanHours(count: number): string {
  return `${count} ${count === 1 ? 'hour' : 'hours'}`
}

/** "24 hrs" — the abbreviated form for secondary lines (bullets, strips),
 *  where the full word crowds a card. Headlines keep `freebuffPlanHours`. */
export function freebuffPlanHrs(count: number): string {
  return `${count} ${count === 1 ? 'hr' : 'hrs'}`
}

/**
 * "3 hours/day · 10 hours/5 days · 50 hours/month"
 *
 * Takes the three fields structurally rather than the catalog type, so the
 * CATALOG tier and the wire `FreebuffSubscriptionTierOffer` both satisfy it —
 * the settings page renders the wire shape, and requiring the catalog type
 * there would mean either a cast or a second copy of this string.
 */
export function freebuffPlanHoursSummary(tier: {
  dailySessions: number
  fiveDaySessions: number
  monthlySessions: number
}): string {
  return [
    `${freebuffPlanHours(tier.dailySessions)}/day`,
    `${freebuffPlanHours(tier.fiveDaySessions)}/5 days`,
    `${freebuffPlanHours(tier.monthlySessions)}/month`,
  ].join(' · ')
}

/** Token label used by the plans page's value explanation. */
export const FREEBUFF_SPEND_UNIT_LABEL = 'tokens'
