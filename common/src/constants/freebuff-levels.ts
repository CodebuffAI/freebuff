/**
 * Freebuff Levels — the earned half of the free-capacity story.
 *
 * ## Why this exists, next to `freebuff-trust.ts`
 *
 * `freebuff-trust.ts` ("Access Level") answers *how much do we believe this
 * account is a person*. It is a scorer over durable facts an account cannot
 * fake, it moves on the order of days, and nothing a user does on purpose
 * moves it quickly. That is exactly right for an abuse control and exactly
 * wrong for an incentive.
 *
 * This file is the other half: **Trust**, a spendable, earnable currency, and
 * the **Level** it buys. It moves in seconds, it is denominated in something a
 * user can go and do right now (engage with a promoted post), and it is
 * *supposed* to be gamed — that is what an incentive is.
 *
 * The two multiply the same way the region tier and the access level do:
 *
 * ```
 * sessions = accessLevelBase(tier, accessLevel)   // can this account be trusted
 *          + levelBonus(level)                    // what has this account earned
 *          + referral + streak + operator grants  // untouched
 * ```
 *
 * A Level never *subtracts* — it only ever adds to the base an Access Level
 * selected. That invariant is the same one `freebuff-trust.ts` documents, and
 * it exists for the same reason: two systems that can each take capacity away
 * produce a user who cannot be told why they have less than yesterday.
 *
 * ## The base moved a LITTLE at the same time
 *
 * Premium went 5 → 4 and the limited-region pool 6 → 3 in the same change that
 * added this file. Two rules shaped those numbers, and they pull against each
 * other:
 *
 *   - A ladder bolted onto a floor that already gives you everything is
 *     decoration. There has to be something above the floor to climb toward.
 *   - A floor that COLLAPSES is a regression every existing user feels on the
 *     same afternoon, and no amount of "you can earn it back" reads as
 *     anything other than a takeaway. An earlier draft dropped both bases to
 *     1; this comment exists to warn against putting that back.
 *
 * So: one session off premium, and a real cut only where the pool is genuinely
 * being drained (see `FREEBUFF_LIMITED_SESSION_LIMIT`). Everything above that
 * is earned, and the ceiling is HIGHER than any base ever was — 7 on both
 * pools, against bases of 4 and 3.
 *
 * ## Both halves move together, or not at all
 *
 * `FREEBUFF_LEVEL_SESSIONS=off` reverts the reduced bases AND suppresses the
 * bonus, as one lever. A reduced base with the ladder switched off is a pure
 * takeaway — the one configuration this feature must never be able to land in
 * — so the switch deliberately cannot express it.
 *
 * ## Full-access standard models are not on this ladder at all
 *
 * They are not metered at all, on any surface — the browser-only standard pool
 * was removed in the same week (see the note on `FREEBUFF_STANDARD_MODEL_IDS`).
 * That is the floor of the product, the thing we mean when we say Freebuff is
 * free, and putting it on a ladder would make Levels read as a paywall on the
 * base product rather than as a way up from it. Levels only ever touch the two
 * pools that are genuinely scarce.
 *
 * ## Everything here is a dial, and it will be turned
 *
 * The rates below are the opening position of an economy, not a constant like
 * a timezone. They are expected to move — weekly at first — as we learn what
 * an engagement is really worth and how fast people climb. So:
 *
 *   - every number lives in ONE table (`FREEBUFF_LEVELS`) rather than being
 *     spread across the call sites that consume it;
 *   - nothing is derived from a formula that would have to be reverse-engineered
 *     before it could be adjusted;
 *   - the thresholds are CUMULATIVE totals, not per-level deltas, so a user's
 *     stored balance keeps its meaning when the table changes underneath it.
 *     Re-tuning a delta silently re-levels everybody; re-tuning a threshold
 *     re-levels only the people who cross it.
 *
 * The last point is the load-bearing one. `trust_points` in the database is a
 * running balance and never a level, and the level is recomputed from the
 * balance on every read (`levelForTrust`). There is no migration to write when
 * a threshold moves.
 */

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export interface FreebuffLevelTier {
  /** 0-based. Level 0 is where every account starts, having earned nothing. */
  level: number
  /** User-facing name. Short enough for a progress-bar caption. */
  name: string
  /**
   * CUMULATIVE lifetime-net Trust required to hold this level. Level 0 is 0 by
   * construction; every other entry is strictly greater than the one before
   * it, which `levelForTrust` relies on for its scan.
   */
  trustRequired: number
  /**
   * Trust paid for one approved engagement while holding this level.
   *
   * Rises with level on purpose. A flat rate makes the ladder feel *longer*
   * the higher you climb (thresholds grow, the payment does not), which is the
   * exact shape of a ladder people quit halfway up. Rising payment against
   * rising cost keeps the number of engagements between levels roughly flat
   * while the reward per level keeps growing.
   */
  trustPerEngagement: number
  /**
   * Total LIMITED-REGION sessions per Pacific day at this level, INCLUDING the
   * base every account has. The bonus actually added to the pool is this minus
   * `FREEBUFF_LEVEL_0.freeSessionsPerDay`.
   *
   * Named `free` rather than `limited` because that is what the user-facing
   * copy calls it — "free sessions" — and the one place the two vocabularies
   * meet should be here rather than in every component.
   *
   * Full-access standard models are NOT this pool and are not level-scaled at
   * all; see the note at the top of this file.
   */
  freeSessionsPerDay: number
  /** Same shape, for the premium-model daily pool. */
  premiumSessionsPerDay: number
}

/**
 * The ceiling a Level can lift either pool to.
 *
 * Not enforced by a clamp — the table simply stops here — but stated as a
 * constant because it is a promise the copy makes ("earn up to 7 a day") and a
 * silent table edit that broke it would be hard to notice. The test asserts
 * the table honours it.
 *
 * Why a ceiling exists at all: a Level is a reward, not an exemption. An
 * account that climbs to the top and is later sold or compromised must still
 * cost a bounded amount — the same reasoning `freebuff-trust.ts` gives for
 * `core` being ~1.6x `established` rather than unbounded.
 */
export const FREEBUFF_LEVEL_SESSION_CEILING = 7

/**
 * The table. Eleven rungs from a base of 6 free / 4 premium to a ceiling of 7
 * on both.
 *
 * ## How the numbers were picked
 *
 * One engagement is one real like + comment + repost on someone else's post,
 * proven with a screenshot. That is a couple of minutes of genuine attention,
 * and we sell it for $0.50 — so the ladder has to be worth a couple of minutes
 * and cannot be worth so much that buying the engagement is cheaper than
 * buying the compute.
 *
 * At level 0 an engagement pays 50 and level 1 costs 100: **two engagements to
 * the first rung**, which is the number that decides whether anybody starts.
 * From there the engagements-per-level count drifts from 3 up to about 9 at
 * the top, so the ladder gets meaningfully harder without ever crossing into
 * the range where a user does the arithmetic and stops.
 *
 * ## Sessions arrive on alternating rungs, and stop at 7
 *
 * A session is a chunky reward — one is a visible fraction of a day's capacity
 * — so the two columns step up on alternating levels rather than every level.
 * That keeps every rung worth something without inflating the ceiling, and it
 * leaves seven meaningful steps between the base and the top.
 *
 * Level 0 is exactly the base (6 limited / 4 premium), which is what makes
 * `levelSessionBonus` a pure delta. The limited column was 3 at launch and
 * was restored to 6 on 2026-09-02 — it meters MiMo, the only model a
 * limited-access account has without a plan, and that pool was never meant
 * to be the premium cut — so the limited ladder now adds its one session at
 * the top rungs only. The ceiling on both pools is above every base this
 * product has ever had.
 *
 * The top rungs grant no further sessions and are deliberately not dead:
 * `trustPerEngagement` keeps climbing (200 at Architect, four times the base),
 * so a high-level account rebuilds its balance far faster against the
 * per-prompt drain — which is what actually keeps a heavy user at the ceiling
 * rather than sliding off it.
 */
export const FREEBUFF_LEVELS: readonly FreebuffLevelTier[] = [
  {
    level: 0,
    name: 'Newcomer',
    trustRequired: 0,
    trustPerEngagement: 50,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 5,
  },
  {
    level: 1,
    name: 'Contributor',
    trustRequired: 100,
    trustPerEngagement: 55,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 5,
  },
  {
    level: 2,
    name: 'Builder',
    trustRequired: 275,
    trustPerEngagement: 60,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 5,
  },
  {
    level: 3,
    name: 'Maker',
    trustRequired: 525,
    trustPerEngagement: 70,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 5,
  },
  {
    level: 4,
    name: 'Shipper',
    trustRequired: 875,
    trustPerEngagement: 80,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 6,
  },
  {
    level: 5,
    name: 'Operator',
    trustRequired: 1_350,
    trustPerEngagement: 95,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 6,
  },
  {
    level: 6,
    name: 'Veteran',
    trustRequired: 2_000,
    trustPerEngagement: 110,
    freeSessionsPerDay: 6,
    premiumSessionsPerDay: 6,
  },
  {
    level: 7,
    name: 'Principal',
    trustRequired: 2_900,
    trustPerEngagement: 130,
    freeSessionsPerDay: 7,
    premiumSessionsPerDay: 7,
  },
  {
    level: 8,
    name: 'Staff',
    trustRequired: 4_100,
    trustPerEngagement: 150,
    freeSessionsPerDay: 7,
    premiumSessionsPerDay: 7,
  },
  {
    level: 9,
    name: 'Distinguished',
    trustRequired: 5_700,
    trustPerEngagement: 175,
    freeSessionsPerDay: 7,
    premiumSessionsPerDay: 7,
  },
  {
    level: 10,
    name: 'Architect',
    trustRequired: 7_800,
    trustPerEngagement: 200,
    freeSessionsPerDay: 7,
    premiumSessionsPerDay: 7,
  },
]

/** The rung every account starts on, and the subtrahend for every bonus. */
export const FREEBUFF_LEVEL_0 = FREEBUFF_LEVELS[0]!
export const FREEBUFF_MAX_LEVEL = FREEBUFF_LEVELS[FREEBUFF_LEVELS.length - 1]!

/**
 * The level a balance buys.
 *
 * A linear scan over eleven entries, called on read paths that already do
 * database I/O — a binary search here would be a micro-optimization with a
 * correctness risk (the table is hand-edited and a mis-ordered row breaks a
 * search silently but not a scan).
 *
 * Negative balances clamp to level 0 rather than throwing. A user can spend
 * below zero — see `FREEBUFF_TRUST_ALLOW_NEGATIVE` — and "you are level −1" is
 * not a state any surface should have to render.
 */
export function levelForTrust(trust: number): FreebuffLevelTier {
  let held = FREEBUFF_LEVEL_0
  for (const tier of FREEBUFF_LEVELS) {
    if (trust >= tier.trustRequired) held = tier
    else break
  }
  return held
}

/** The next rung, or null at the top. */
export function nextLevelAfter(level: number): FreebuffLevelTier | null {
  return FREEBUFF_LEVELS.find((tier) => tier.level === level + 1) ?? null
}

/**
 * Everything a progress bar needs, computed once so three surfaces cannot
 * disagree about how full it is.
 *
 * `progress` is the fraction of the way from the CURRENT level's threshold to
 * the next one — not the fraction of the next threshold, which is the bug
 * every progress bar of this shape ships with first (it makes the bar jump
 * backwards on level-up).
 */
export interface FreebuffLevelProgress {
  trust: number
  level: number
  levelName: string
  trustPerEngagement: number
  freeSessionsPerDay: number
  premiumSessionsPerDay: number
  /** Cumulative trust at which the current level began. */
  levelFloor: number
  /** Cumulative trust that buys the next level; null at the top. */
  nextLevelAt: number | null
  nextLevelName: string | null
  /** How much more trust is needed; null at the top. */
  trustToNextLevel: number | null
  /** 0..1 through the current level. 1 at the top rung. */
  progress: number
  /** Engagements still needed for the next level; null at the top. */
  engagementsToNextLevel: number | null
}

export function levelProgress(trust: number): FreebuffLevelProgress {
  const tier = levelForTrust(trust)
  const next = nextLevelAfter(tier.level)
  const clamped = Math.max(0, trust)
  const span = next ? next.trustRequired - tier.trustRequired : 0
  const into = clamped - tier.trustRequired
  const remaining = next ? Math.max(0, next.trustRequired - clamped) : null
  return {
    trust: clamped,
    level: tier.level,
    levelName: tier.name,
    trustPerEngagement: tier.trustPerEngagement,
    freeSessionsPerDay: tier.freeSessionsPerDay,
    premiumSessionsPerDay: tier.premiumSessionsPerDay,
    levelFloor: tier.trustRequired,
    nextLevelAt: next?.trustRequired ?? null,
    nextLevelName: next?.name ?? null,
    trustToNextLevel: remaining,
    progress: next && span > 0 ? Math.min(1, Math.max(0, into / span)) : 1,
    engagementsToNextLevel:
      remaining === null ? null : Math.ceil(remaining / tier.trustPerEngagement),
  }
}

// ---------------------------------------------------------------------------
// Session bonuses
// ---------------------------------------------------------------------------

/**
 * Extra standard/premium sessions this level adds ON TOP of the base the
 * Access Level matrix selected.
 *
 * Expressed as a delta against level 0 rather than as an absolute, because the
 * base is not ours to overwrite: a `core` account in a supported region gets a
 * bigger base than a `new` one, and a level must not flatten that difference.
 * Level 0 therefore adds exactly nothing, which is what makes this safe to
 * wire into a pool whose entitlement is otherwise unchanged.
 */
export function levelSessionBonus(level: number): {
  free: number
  premium: number
} {
  const tier =
    FREEBUFF_LEVELS.find((entry) => entry.level === level) ?? FREEBUFF_LEVEL_0
  return {
    free: Math.max(0, tier.freeSessionsPerDay - FREEBUFF_LEVEL_0.freeSessionsPerDay),
    premium: Math.max(
      0,
      tier.premiumSessionsPerDay - FREEBUFF_LEVEL_0.premiumSessionsPerDay,
    ),
  }
}

// ---------------------------------------------------------------------------
// Trust spent on inference
// ---------------------------------------------------------------------------

/**
 * What one prompt costs, by how expensive the model behind it is.
 *
 * ## Why a prompt and not a request
 *
 * Charged once per *root run* (`isNewPromptWindow`), exactly like
 * `userMessagesPerDay`. An agentic turn that fans out into fifty subagent
 * calls costs one prompt's Trust, because charging per LLM request would price
 * "use the agent properly" at ten times "ask it a question" and teach people
 * to avoid the product's best feature.
 *
 * ## Standard prompts are free, and the rest are cheap
 *
 * The first version charged 1 / 2 / 3 / 5 and allowed a balance to run to
 * -500. Measured a few days in: **17,993 of 18,013 accounts held a negative
 * balance**, the median was -102, 2,125 were pinned at the floor, and 48 —
 * forty-eight — had ever earned anything at all.
 *
 * So it was not a slow tide. It was a meter that only ran one way, and what a
 * user saw was a "Trust score" of -75 next to their name. People read that as
 * an abuse finding and wrote in asking which fraud signal had flagged them,
 * which is the worst possible reading of a currency meant to reward them.
 *
 * Two things were wrong. The rates were too high for how much people actually
 * send, and earning barely worked — the engagement feed was serving nothing,
 * so the only reachable direction was down.
 *
 * A message now costs 1, whatever it was sent to. Flat.
 *
 * The tiering was the part that made the number unpredictable: the same
 * afternoon's work cost wildly different amounts depending on which model
 * happened to be selected, and nobody could form an expectation of how fast
 * their score moved. One is a rate a person can reason about — an engagement
 * pays 50, so it covers 50 messages — and it is the smallest debit that keeps
 * the mechanic real at all.
 *
 * ## A balance never goes below zero
 *
 * Zero is the floor. A user with no Trust still sends messages — they simply
 * hold no level, and their sessions fall back to the base. Refusing a message
 * for want of Trust would turn a gamification currency into an accidental
 * paywall, and the paywall we actually want is the subscription: priced,
 * disclosed, and not denominated in points.
 */
export const FREEBUFF_TRUST_COST_PER_PROMPT = {
  /** Full-access standard models and the limited-tier catalog.
   *  Non-zero, so this is the class that puts a debit on every prompt in the
   *  product — which is why the write is buffered and batched rather than done
   *  inline; see `freebuff-trust-buffer.ts`. `enqueuePromptTrustCharge` still
   *  returns early on a zero cost, so setting any class here to 0 takes it out
   *  of the write path entirely. */
  standard: 1,
  /** GLM 5.2 and the referral-earned pools. */
  glm: 1,
  /** The shared premium daily pool. */
  premium: 1,
  /** Limited-offer frontier waves (Claude Fable 5). Costs us the most by far,
   *  and still 1 — the classes are kept as a seam so a future rate change has
   *  somewhere to land, not because they currently differ. */
  frontier: 1,
} as const

export type FreebuffTrustCostClass = keyof typeof FREEBUFF_TRUST_COST_PER_PROMPT

/**
 * Whether a balance may fall below zero.
 *
 * False. A negative score is unreadable as anything but a punishment — see
 * the note above for what users concluded when they saw one — and there is
 * nothing a debt buys us that a floor at zero does not.
 */
export const FREEBUFF_TRUST_ALLOW_NEGATIVE = false

/**
 * Floor for a balance.
 *
 * Enforced on WRITE (`GREATEST` in the upsert) and again on READ, because
 * 17,993 rows were already negative when this changed and a write-side floor
 * alone would have left them that way until each account happened to spend
 * again. Clamping the read fixes every one of them on the next page load with
 * no backfill, and the stored value corrects itself on the next debit.
 */
export const FREEBUFF_TRUST_MIN_BALANCE = 0

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const FREEBUFF_TRUST_CURRENCY_NAME = 'Trust'

// The Earn path and prompts moved to `freebuff-earn.ts` on 2026-09-07: the
// page outlived the currency, so its constants should not die with it.

/** Shown under the progress bar. Indexed by level, falling back to the last. */
export const FREEBUFF_LEVEL_BLURBS: Record<number, string> = {
  0: 'Engage with a promoted post to earn your first Trust. Two engagements gets you to level 1.',
  1: 'You are on the ladder. Each level you hold adds sessions for as long as you hold it.',
  2: 'A fifth premium session a day. Keep engaging to hold your level as you work.',
  3: 'Solid standing. Your Trust now buys noticeably more per engagement.',
  4: 'Six premium sessions a day, and every engagement is worth more than it was.',
  5: 'Operator tier: the free limits here are what other products charge for.',
  6: 'Veteran standing. Every engagement is worth more than double a newcomer’s.',
  7: 'Principal — the session ceiling, seven a day on both pools. From here Trust is about HOLDING it.',
  8: 'Staff. Engagements pay three times what they did at the bottom, so the daily drain barely registers.',
  9: 'Distinguished. Very few accounts hold this level for long.',
  10: 'Architect — the top of the ladder. Nothing above this, and nothing to prove.',
}

export function levelBlurb(level: number): string {
  return FREEBUFF_LEVEL_BLURBS[level] ?? FREEBUFF_LEVEL_BLURBS[10]!
}
