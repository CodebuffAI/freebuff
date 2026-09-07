/**
 * Per-account daily spend ceilings for free mode.
 *
 * These replace the flat `FREEBUFF_DAILY_SPEND_LIMIT_USD = 50` that every
 * account shared. The 1x ceiling is the settled provider cost, since midnight
 * Pacific, at or above which no fresh or legacy-queued external session is
 * admitted. Ordinary single-session CLI/Web live reclaims avoid the spend
 * read; restricted-risk cohorts instead enforce a second 2x hard cap on those
 * reclaims and on new prompts. Desktop reclaim admission skips the spend gate,
 * but restricted Desktop tabs still meet the same hard cap at prompt time.
 * Internal accounts are exempt before callers aggregate spend.
 *
 * ## Why a ceiling and not a ban
 *
 * Everything here is a spend cap, and that is deliberate. A cap is reversible,
 * proportionate, self-limiting, and wrong-in-a-cheap-way: a real user who hits
 * one loses the ability to start a new session today, not their account.
 * `docs/freebuff-abuse-detection.md` records what the other kind of error
 * costs — 659 accounts wrongly banned on 2026-08-03, reversed by hand — and
 * its evidence standard names region, domain, cost and volume as **weak**
 * signals that must never carry a ban alone. Every cohort below is built from
 * exactly those weak signals, so every cohort below gets a cap.
 *
 * Bans still happen. They happen through the sweeps, on the strong evidence
 * those sweeps re-derive (proxy fanout, honeypot hits), and a low ceiling is
 * what bounds the damage in the meantime.
 *
 * ## The ceilings compose by MINIMUM
 *
 * An account can be in several cohorts at once — a limited-region account on a
 * disposable domain running a third-party client. Rather than ordering the
 * rules and picking the first match, every applicable ceiling is computed and
 * the lowest wins. That makes the outcome independent of rule order, which is
 * the property that stops this file rotting as cohorts are added.
 *
 * It also means these can only ever LOWER a limit. The trust-level matrix
 * (`freebuff-trust.ts`) participates in the same minimum when it is enforcing,
 * so shipping these ceilings cannot accidentally raise anyone's budget while
 * that rollout is still in `observe`.
 */

import { type FreebuffAccessTier } from './freebuff-models'

/**
 * Region ceilings, replacing the flat $50.
 *
 * Sized against the measured per-user daily distribution rather than picked:
 * ordinary use sits far below these, and the accounts they bind are the tail
 * that made the flat cap meaningless. The limited region is lower because it
 * cannot reach a premium model at all, so the same dollar figure buys far more
 * requests there — an identical cap would not be an identical constraint.
 */
export const FREEBUFF_REGION_DAILY_SPEND_USD: Record<
  FreebuffAccessTier,
  number
> = {
  full: 15,
  limited: 5,
}

/**
 * The restricted-cohort ceiling.
 *
 * Deliberately not zero. A zero ceiling is a block, and a block tells the
 * operator instantly which signal caught them — at which point they rotate it
 * and we lose both the account and the detection. Fifty cents a day keeps them
 * visible, keeps their traffic flowing through the honeypot models and the
 * fanout counters that produce ban-grade evidence, and costs about as much as
 * finding out would have.
 *
 * Note what this does and does not bound. The 1x gate decides whether a fresh
 * session may start, so an account at $0.49 can still open one and spend past
 * the ceiling inside it. Restricted-risk accounts then meet a separate 2x hard
 * cap on single-session live reclaims and new prompts; Desktop reclaim POSTs
 * skip admission gating, while their new prompts still enforce that cap. Thus
 * $0.50 is roughly one admitted session before the 1x gate closes, and $1 is
 * the live/prompt backstop until the Pacific-midnight reset.
 *
 * This is the same reasoning `docs/freebuff-honeypot-models.md` gives for
 * separating detection from enforcement in time.
 */
export const FREEBUFF_RESTRICTED_DAILY_SPEND_USD = 0.5

/**
 * Countries whose free-mode accounts are held at the restricted ceiling.
 *
 * **This is a spend cap on a region, not a judgement about people in it, and
 * it is worth being precise about what it can and cannot do.** Both of these
 * are among the largest VPN and datacenter exit geographies in the world, so a
 * meaningful share of traffic resolving here is not physically here — which
 * cuts both ways: it catches operators routing through these countries, and it
 * catches residents who are exactly who they appear to be. The second group is
 * the cost, and the cap rather than a ban is what keeps that cost survivable.
 *
 * Kept as an env-overridable list because the right answer moves with where
 * the traffic is, and a code deploy is the wrong latency for that.
 */
export const FREEBUFF_RESTRICTED_COUNTRIES: readonly string[] = ['CN']

/**
 * The middle ceiling, for countries that are heavy anonymizing-egress
 * geographies AND have a large population of ordinary users.
 *
 * Exists because the two-value scheme above forced a false choice for
 * Singapore. SG is in `FREE_MODE_ALLOWED_COUNTRIES` — we call it a full-access
 * country and give it the $15 region ceiling — while simultaneously sitting on
 * the restricted list at $0.50. An account was told it had full access and
 * then priced at a thirtieth of the full budget.
 *
 * Measured over 24h on 2026-08-15, that resolved to: 341 of 1,491 active SG
 * users (22.9%) refused, against 3.5% in the US and 0.2% in India. 75% of the
 * refused cohort carried no abuse signal of any kind, and 71% of those were on
 * gmail/qq/163/outlook/hotmail. The honeypot hit rate — the strongest
 * country-attributable signal we have — was 2.5% in SG against 2.1% in the US
 * and 3.2% in Indonesia, which is no support at all for a 30x lower cap.
 *
 * The abuse in SG was real, but it was a *domain* farm rather than a country:
 * ~160 accounts on dhisy/dewaa/sendang/yotube/gusil, now priced by
 * `flaggedEmailDomain` instead. Catching it there is what makes this tier
 * affordable.
 *
 * $1 as of 2026-08-31 (operator decision; was $5 from 2026-08-15): the tail
 * kept growing and the farm-domain pricing did not shrink it enough. One
 * dollar still buys a normal day of ordinary sessions, and unlike the
 * restricted tier it now carries the live-session leeway multiplier below —
 * at this size, letting an open session run to 1.25x and then cutting is the
 * bound that matters, exactly the reasoning the restricted ceilings use.
 */
export const FREEBUFF_ELEVATED_DAILY_SPEND_USD = 1

/**
 * Countries held at the elevated ceiling.
 *
 * Env-overridable for the same reason the restricted list is: where the
 * traffic is moves faster than a deploy. CN is deliberately NOT here — it is
 * not in `FREE_MODE_ALLOWED_COUNTRIES`, so its accounts already resolve to the
 * limited tier's $5 region ceiling, and moving it here would remove its
 * restricted ceiling entirely rather than soften it. That is a separate
 * decision from this one, on separate evidence.
 */
export const FREEBUFF_ELEVATED_COUNTRIES: readonly string[] = ['SG']

/**
 * The cause-blind capacity refusal.
 *
 * ## What it still covers
 *
 * Free-mode RATE limits (prompt windows, premium-model caps) and the one spend
 * cohort that must stay unnamed, `third_party_client`. It was originally the
 * single sentence EVERY refusal shared; two cohorts have since been split off
 * it — `FREEBUFF_RESTRICTED_NOTICE` on 2026-08-14 and `FREEBUFF_BUDGET_NOTICE`
 * on 2026-08-15 — each on an explicit operator decision recorded below.
 *
 * ## Why it was one string
 *
 * A restricted account (restricted country, flagged domain, observed foreign
 * toolset) hits its ceiling far sooner than anyone else, and if the message it
 * saw were different it would be telling the operator which signal caught
 * them — the exact leak `docs/freebuff-honeypot-models.md` separates detection
 * from enforcement to avoid. That argument still holds for anything that names
 * a DETECTOR, which is why `third_party_client` never got its own copy. It
 * does not hold for a whole-population allowance, where there is no detector
 * to leak — hence the budget split.
 *
 * ## Why it names abuse
 *
 * Because it is true, and because a limit without a reason reads as a product
 * that broke or a user who did something wrong. Naming the cause puts it
 * somewhere other than the reader: "sustained automated abuse" is plainly
 * about someone else, while still explaining why the rules changed under
 * someone who did nothing differently.
 *
 * ## What it deliberately omits
 *
 * Any number. The caps stay server-side for the reason
 * `docs/freebuff-abuse-detection.md` gives — the abuse pattern here is
 * sustained pacing just under the caps, so a published cap is a published
 * pacing instruction. And the surrounding copy on each surface already
 * supplies the concrete part a user actually needs: when it resets.
 *
 * It deliberately does not open with "Free", either: three of the four places
 * it is used already begin with "Free mode…" or "Free premium-model…", and the
 * repetition reads as a copy bug.
 */
export const FREEBUFF_CAPACITY_NOTICE =
  'Capacity is now limited per account — sustained automated abuse forced us to cap how much any one account can use.'

/**
 * The refusal copy for the RESTRICTED cohorts — VPN/proxy egress, restricted
 * country, flagged email domain.
 *
 * This deliberately weakens the original cohort-blind stance, on an explicit
 * operator decision (2026-08-14): real full-region developers on VPNs were
 * hitting a fifty-cent wall with a message that told them nothing, and the
 * support cost of that silence outweighed the signal leak. What it names is
 * the SET of causes, never which one applied — an operator learns their
 * account tripped one of three broad detectors, not which request or which
 * signal, and the honeypot/foreign-toolset detectors stay entirely unnamed.
 * The VPN clause doubles as the remedy: it is the one cause a legitimate user
 * can fix in a minute, and the whole point of naming it is that they do.
 */
export const FREEBUFF_RESTRICTED_NOTICE =
  'This account has reduced capacity: it was flagged for VPN or proxy usage, a restricted location, or an email domain commonly used by bot farms. If you are on a VPN, connecting directly restores normal limits.'

/** The reasons that show `FREEBUFF_RESTRICTED_NOTICE`. `third_party_client`
 *  stays on the cause-blind `FREEBUFF_CAPACITY_NOTICE` on purpose: it is a
 *  detector worth not naming. */
export const FREEBUFF_RESTRICTED_NOTICE_REASONS: ReadonlySet<string> = new Set([
  'privacy_egress',
  'restricted_country',
  'flagged_email_domain',
  'unverified_egress',
])

/**
 * The plain daily-budget refusals — no cohort, no detector, no suspicion.
 *
 * Split out of `FREEBUFF_CAPACITY_NOTICE` on 2026-08-15. Every one of these is
 * a whole-population allowance, and the abuse sentence was landing on people
 * it did not describe: over 24h, 17 of the 18 accounts refused by the
 * limited-region $5 ceiling carried no abuse signal of any kind, and were told
 * that "sustained automated abuse forced us to cap" their account. That reads
 * as an accusation to someone who just did a day's work, and it is the phrasing
 * support tickets come back quoting.
 */
export const FREEBUFF_BUDGET_NOTICE_REASONS: ReadonlySet<string> = new Set([
  'region',
  'elevated_country',
  'trust_level',
])

/**
 * The refusal copy for the Freebucks catalog's per-tier hard ceiling.
 *
 * Its own sentence rather than `FREEBUFF_BUDGET_NOTICE`, which says "free
 * usage": a Plus subscriber who hits their $5 day was not using free usage,
 * and the catalog's ceilings are the one limit that IS published next to the
 * plan (so there is no pacing instruction to withhold). Like its siblings it
 * carries no reset time — every surface appends its own. Deliberately NOT in
 * `FREEBUFF_BUDGET_NOTICE_REASONS`: that set is also what the plan's
 * spend-ceiling BYPASS reads, and the plan must never bypass the one ceiling
 * the plan itself sets.
 */
export const FREEBUFF_FREEBUCKS_CEILING_NOTICE =
  'This account hit today’s hard usage cap. Freebucks pay for sessions, but the compute a day can draw is capped at four times what its Freebucks are worth, to protect the service from runaway usage.'

/**
 * The refusal copy for a plain daily allowance.
 *
 * Deliberately says nothing about the account. It names the thing that ran out
 * (today's free usage), not a property of the person, and it does not use
 * "limited", "restricted" or "blocked" — those read as a verdict, and they are
 * the words that generate "is my account restricted?" tickets.
 *
 * Carries no number, for the same reason the other two do not: a published cap
 * is a published pacing instruction. It also carries no reset time, because
 * every surface appends its own ("resets at midnight Pacific", "come back in
 * X") and the duplication reads as a copy bug.
 */
export const FREEBUFF_BUDGET_NOTICE =
  'You have used all of today’s free usage on this account.'

/** Pick the refusal sentence for a resolved ceiling reason. */
export function freebuffSpendNoticeFor(reason: string): string {
  if (FREEBUFF_RESTRICTED_NOTICE_REASONS.has(reason)) {
    return FREEBUFF_RESTRICTED_NOTICE
  }
  if (FREEBUFF_BUDGET_NOTICE_REASONS.has(reason)) return FREEBUFF_BUDGET_NOTICE
  if (reason === 'freebucks_plan') return FREEBUFF_FREEBUCKS_CEILING_NOTICE
  return FREEBUFF_CAPACITY_NOTICE
}

/** The refusal sentence when one session reaches a model-specific ceiling. */
export function freebuffSessionSpendNotice(verdict: {
  modelLabel: string
  experimental: boolean
}): string {
  return verdict.experimental
    ? `${verdict.modelLabel} is an experimental model we are trialling, so each session with it is much shorter than usual. Pick another model to keep going now, or start a new session to use it again.`
    : `This session has used all of its ${verdict.modelLabel} usage. Pick another model to keep going now, or start a new session to use it again.`
}

/**
 * How far past its ceiling an account may get before a LIVE session is cut.
 *
 * The 1x ceiling above gates fresh admission only. For a $15 account, allowing
 * an already-open session to continue is the right trade: the overshoot is
 * bounded by one ordinary session and interrupting real work to save cents is
 * the worse error. At $0.50 the same rule is not the same rule.
 * Measured over 24h on 2026-08-13, against a $0.50 ceiling:
 *
 *   restricted_country   p50 3.6x   worst 12.6x   ($6.32)
 *   privacy_egress       p50 4.7x   worst 23.2x   ($11.59)
 *   flagged_email_domain p50 1.8x   worst 38.2x   ($19.10)
 *
 * A cap that is exceeded 38-fold is not a cap. This multiplier is the second,
 * hard bound: crossing `ceiling x multiplier` refuses the request even mid
 * session. Two, not one, deliberately — a session admitted at $0.49 must be
 * able to finish the turn it started, or the gate becomes a coin flip on
 * whether a legitimate reply is truncated. Two bounds the worst case at
 * roughly one session's spend past the ceiling, which is what the fresh-
 * admission gate was always assumed to cost.
 *
 * It does NOT apply to the region ceilings. Those are already large enough
 * that overshoot is proportionally small (worst observed 1.3x), and cutting a
 * live session at $15 buys little for a real user's interruption.
 */
export const FREEBUFF_SPEND_CEILING_HARD_MULTIPLIER = 2

/**
 * Daily-spend FLOORS for accounts holding a live paid plan (2026-08-31).
 *
 * The cohort ceilings above were sized for free usage, and until this floor a
 * paying customer inherited them unchanged: measured over the 48h before it
 * shipped, 11 live subscribers were spend-refused — six limited-region
 * Starters at the $3 region ceiling they had paid to escape, three in a
 * restricted country at thirty cents a day against an $8/month plan.
 *
 * A floor, not an exemption: the plan's own monthly spend cap remains the
 * money bound, and a stolen card should still not buy unbounded daily burn.
 * Composed as max() AFTER the cohort minimum, so it can only ever RAISE a
 * paying account's ceiling, never lower one — a full-region paid account whose
 * cohort maths already exceeds the floor keeps the higher number.
 *
 * Full access floors higher than everyone else ($7 vs $3) on the operator's
 * explicit split: paid limited-region and paid suspicious-cohort accounts go
 * to $3. `third_party_client` is deliberately NOT floored — an account
 * observed sending a foreign toolset while paying is the reseller pattern
 * (see freebuff2api), and the one cohort where a card is evidence of a
 * business model rather than a person.
 */
export const FREEBUFF_PAID_DAILY_SPEND_FLOOR_USD: Record<
  FreebuffAccessTier,
  number
> = {
  full: 7,
  limited: 3,
}

/** The reasons a paid floor may override. Everything except the reseller
 *  cohort — see FREEBUFF_PAID_DAILY_SPEND_FLOOR_USD. */
const PAID_FLOOR_REASONS: ReadonlySet<string> = new Set([
  'region',
  'elevated_country',
  'restricted_country',
  'privacy_egress',
  'flagged_email_domain',
  'unverified_egress',
  'trust_level',
])

/**
 * Reasons whose ceiling is small enough that the hard multiplier applies.
 *
 * `region` and `trust_level` are excluded: whole-population limits where the
 * fresh-admission gate is proportionate, and applying a hard cut there would
 * interrupt ordinary paying-in-attention users mid-thought.
 *
 * `elevated_country` JOINED this set on 2026-08-31 when its ceiling dropped
 * $5 → $1: at one dollar, overshoot is no longer proportionally small, and
 * the multiplier is what grants an open session leeway to finish before the
 * hard cut — the same trade the restricted ceilings make.
 */
const HARD_CAPPED_REASONS: ReadonlySet<string> = new Set([
  // The Freebucks ceilings are small ($0.50–$8) and sized to catch only the
  // sessions that ran far past their price, so the same trade the restricted
  // ceilings make applies: admit under the line, let the open session finish
  // up to the multiplier, then cut. That multiplier IS the "leeway" the
  // catalog promises next to each dollar figure.
  'freebucks_plan',
  'restricted_country',
  'elevated_country',
  'privacy_egress',
  'flagged_email_domain',
  'third_party_client',
  'unverified_egress',
])

export type FreebuffSpendCeilingReason =
  | 'region'
  | 'elevated_country'
  | 'restricted_country'
  | 'privacy_egress'
  | 'flagged_email_domain'
  | 'third_party_client'
  | 'unverified_egress'
  | 'trust_level'
  /** The Freebucks catalog's per-tier hard daily ceiling (2026-09-02). */
  | 'freebucks_plan'

export interface FreebuffSpendCeiling {
  usd: number
  /** Which rule produced the winning (lowest) ceiling. Logged so a support
   *  question has a one-word answer. */
  reason: FreebuffSpendCeilingReason
  /** Every rule that applied, for the admin view — the winner is the lowest of
   *  these, and the rest are what the admin page needs to show why. */
  applied: { reason: FreebuffSpendCeilingReason; usd: number }[]
}

export interface FreebuffSpendCeilingInput {
  accessTier: FreebuffAccessTier
  /** Resolved country of the request, when known. */
  countryCode?: string | null
  /**
   * True when the request arrived over an anonymizing egress — VPN, proxy,
   * Tor, or a residential-proxy exit.
   *
   * Callers should derive this from `isFreebuffHardBlockedPrivacySignal`
   * rather than by listing signals themselves. That list deliberately excludes
   * `relay`: Apple iCloud Private Relay is a default consumer feature shipped
   * to ordinary people, and the whole privacy pipeline treats it as a green
   * flag. Pricing it as anonymizing egress would put a restricted ceiling on
   * every iPhone user who left a checkbox alone.
   *
   * `hosting` is excluded for a softer reason: it is already the coarse signal
   * that ipinfo over-reports on ISP and business networks, which is why
   * `isFreebuffBenignAsType` exists to walk it back.
   */
  privacyEgress?: boolean
  /** True when the account's email domain is disposable or a privacy relay. */
  flaggedEmailDomain?: boolean
  /** True when the account has been observed sending a non-Freebuff tool
   *  schema. See docs/freebuff-abuse-detection.md. */
  thirdPartyClient?: boolean
  /**
   * True when ipinfo flagged the egress and NO second opinion could be
   * obtained — every configured privacy provider was disabled, exhausted, or
   * erroring.
   *
   * This exists so a provider outage cannot buy an operator a larger budget.
   * Before it, an unreachable Spur produced `spur_failed_limited`, which set a
   * limited tier but no ceiling — so the cheapest way to widen a cap was to
   * exhaust our own vendor quota. On 2026-08-13 Spur was dead for two days and
   * 354,715 lookups in 24h returned nothing; the fail-open path was live that
   * whole time.
   *
   * It is the restricted ceiling and not a block for the usual reason: an
   * unresolved verdict is not evidence, and the accounts it catches include
   * ordinary users behind a business network ipinfo called `hosting`.
   */
  unverifiedEgress?: boolean
  /** The trust matrix's ceiling, when that rollout is enforcing. */
  trustLevelCeilingUsd?: number | null
  /**
   * The Freebucks catalog's hard daily ceiling for this account's plan and
   * access tier (`freebucksPlan(...).dailySpendLimitUsd`), when the account is
   * on the Freebucks meter. Null/absent otherwise. REPLACES the region entry
   * rather than composing with it (see the resolver), still composes by
   * minimum with the restricted cohorts, and is deliberately NOT eligible for
   * the paid floor below — the catalog already priced the paid tiers, so a
   * floor that lifted a Starter's $3 to $7 would undo the one number the tier
   * sets.
   */
  freebucksPlanUsd?: number | null
  /** Overrides, all optional so a missing env var changes nothing. */
  /**
   * True when the account holds a live paid plan (Postgres-entitling row —
   * never a mirror; see the coercion rule in triggerGates). Resolved LAZILY
   * by the caller, only when the cohort ceiling would refuse: the ordinary
   * request must not pay a subscription read to learn a ceiling it is under.
   */
  hasPaidSubscription?: boolean
  overrides?: {
    regionUsd?: Partial<Record<FreebuffAccessTier, number>>
    restrictedUsd?: number
    restrictedCountries?: readonly string[]
    elevatedUsd?: number
    elevatedCountries?: readonly string[]
    paidFloorUsd?: Partial<Record<FreebuffAccessTier, number>>
  }
}

/**
 * The one place a free-mode daily spend ceiling is decided.
 *
 * Pure, so the policy is testable without a database and so the admin page can
 * show exactly what an account would get without re-deriving it.
 */
export function resolveFreebuffSpendCeiling(
  input: FreebuffSpendCeilingInput,
): FreebuffSpendCeiling {
  const restrictedUsd =
    input.overrides?.restrictedUsd ?? FREEBUFF_RESTRICTED_DAILY_SPEND_USD
  const restrictedCountries =
    input.overrides?.restrictedCountries ?? FREEBUFF_RESTRICTED_COUNTRIES
  const elevatedUsd =
    input.overrides?.elevatedUsd ?? FREEBUFF_ELEVATED_DAILY_SPEND_USD
  const elevatedCountries =
    input.overrides?.elevatedCountries ?? FREEBUFF_ELEVATED_COUNTRIES

  // The base entry: the region ceiling — or, for an account on the Freebucks
  // meter, the catalog's per-tier ceiling IN ITS PLACE. Both are whole-
  // population budgets sized for the same job, and the catalog one is the
  // published number a user planned against, so the two must not compose
  // (a $5 limited-region ceiling would silently undercut a limited Pro's
  // advertised $7). The restricted cohorts below still compose by minimum.
  const onFreebucksMeter =
    typeof input.freebucksPlanUsd === 'number' &&
    Number.isFinite(input.freebucksPlanUsd)
  const applied: { reason: FreebuffSpendCeilingReason; usd: number }[] = [
    onFreebucksMeter
      ? { reason: 'freebucks_plan', usd: input.freebucksPlanUsd as number }
      : {
          reason: 'region',
          usd:
            input.overrides?.regionUsd?.[input.accessTier] ??
            FREEBUFF_REGION_DAILY_SPEND_USD[input.accessTier],
        },
  ]

  const country = input.countryCode?.toUpperCase() ?? null
  // ON THE METER the plan ceiling IS the whole-population budget, so the two
  // other BUDGET cohorts do not compose under it: `elevated_country` and
  // `trust_level` were sized for the session era and sit BELOW the plan's
  // figure (SG's $1 under the free plan's $3), which refused accounts with
  // Freebucks in hand and told them they had "used all of today's free
  // usage" — 57 accounts on 2026-09-05. The ABUSE cohorts (restricted
  // country, anonymising or unverified egress, flagged domain, third-party
  // client) still compose by minimum: they are fences, not budgets.
  if (country && elevatedCountries.includes(country) && !onFreebucksMeter) {
    applied.push({ reason: 'elevated_country', usd: elevatedUsd })
  }
  if (country && restrictedCountries.includes(country)) {
    applied.push({ reason: 'restricted_country', usd: restrictedUsd })
  }
  if (input.privacyEgress) {
    applied.push({ reason: 'privacy_egress', usd: restrictedUsd })
  }
  if (input.flaggedEmailDomain) {
    applied.push({ reason: 'flagged_email_domain', usd: restrictedUsd })
  }
  if (input.unverifiedEgress) {
    applied.push({ reason: 'unverified_egress', usd: restrictedUsd })
  }
  if (input.thirdPartyClient) {
    applied.push({ reason: 'third_party_client', usd: restrictedUsd })
  }
  if (
    typeof input.trustLevelCeilingUsd === 'number' &&
    Number.isFinite(input.trustLevelCeilingUsd) &&
    !onFreebucksMeter
  ) {
    applied.push({ reason: 'trust_level', usd: input.trustLevelCeilingUsd })
  }

  // Lowest wins, and ties resolve to the EARLIER entry — which is `region`,
  // the least accusatory reason. When a restricted cohort and the region
  // ceiling happen to agree, "region" is both true and the one that does not
  // imply we think something about the account.
  let winner = applied[0]!
  for (const candidate of applied.slice(1)) {
    if (candidate.usd < winner.usd) winner = candidate
  }

  // The paid floor, AFTER the minimum: it may only raise. The reason keeps
  // naming the cohort that was floored — a support question about a paid
  // account still deserves the one-word answer for why it isn't higher.
  if (input.hasPaidSubscription && PAID_FLOOR_REASONS.has(winner.reason)) {
    const floor =
      input.overrides?.paidFloorUsd?.[input.accessTier] ??
      FREEBUFF_PAID_DAILY_SPEND_FLOOR_USD[input.accessTier]
    if (typeof floor === 'number' && floor > winner.usd) {
      return { usd: floor, reason: winner.reason, applied }
    }
  }

  return { usd: winner.usd, reason: winner.reason, applied }
}

/**
 * The spend at which even a LIVE session is refused, or `null` when the
 * winning ceiling is one the hard cap deliberately does not apply to.
 *
 * `null` means "fresh-admission gating only" — the behaviour every ceiling had
 * before this existed. Callers must treat `null` as no hard cap rather than as
 * zero; getting that backwards would cut every region-limited session the
 * moment it opened.
 */
export function resolveFreebuffHardSpendCeiling(
  ceiling: Pick<FreebuffSpendCeiling, 'usd' | 'reason'>,
  multiplier: number = FREEBUFF_SPEND_CEILING_HARD_MULTIPLIER,
): number | null {
  if (!HARD_CAPPED_REASONS.has(ceiling.reason)) return null
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null
  return ceiling.usd * multiplier
}
