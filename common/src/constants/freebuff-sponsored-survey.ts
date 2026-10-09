/**
 * Sponsored surveys (COD-834): the shared contract between the Postgres store
 * (`packages/internal/src/sponsored-survey/`), the advertiser and admin APIs,
 * and every client that renders the survey card (Desktop, Web, CLI).
 *
 * An advertiser runs a short choice-only survey on Freebuff users and pays per
 * CLEAN complete from the placements prepaid balance, at a fixed rate card (no
 * auction). Clean = no answer flagged `fast` and the response not flagged
 * `straight_lined`. Expedited campaigns pay 1.5x and the user gets a fixed
 * Freebucks reward on a clean complete.
 *
 * Everything here is pure: the price and the reward are computed the same way
 * by the advertiser console's estimate, the serve path's snapshot and the
 * settlement. Money is integer cents throughout; multipliers are basis points
 * so no float ever reaches a price.
 *
 * See docs/freebuff-sponsored-surveys.md.
 */
import { z } from 'zod/v4'

import {
  PROFILE_SURVEY_FAST_ANSWER_MS,
  PROFILE_SURVEY_SURFACES,
  profileSurveyQuestion,
} from './freebuff-profile-survey'

import type { ProfileSurveySurface } from './freebuff-profile-survey'

export const SPONSORED_SURVEY_ID = 'sponsored'

/** desktop | web | cli — the same surfaces as the profile survey. */
export type SponsoredSurveySurface = ProfileSurveySurface

// ---- length buckets and the rate card ----------------------------------

/** Hard ceiling on questions per campaign. Above `L` needs an admin price. */
export const SPONSORED_SURVEY_MAX_QUESTIONS = 40

export const SPONSORED_SURVEY_LENGTH_BUCKETS = ['S', 'M', 'L', 'custom'] as const
export type SponsoredSurveyLengthBucket =
  (typeof SPONSORED_SURVEY_LENGTH_BUCKETS)[number]

/** Inclusive question-count ranges per bucket. */
export const SPONSORED_SURVEY_BUCKET_RANGES: Readonly<
  Record<SponsoredSurveyLengthBucket, { min: number; max: number }>
> = Object.freeze({
  S: { min: 1, max: 5 },
  M: { min: 6, max: 10 },
  L: { min: 11, max: 20 },
  custom: { min: 21, max: SPONSORED_SURVEY_MAX_QUESTIONS },
})

/** Base price per clean complete, tier-1 Standard, in cents. `custom` has no
 *  list price: an admin sets `custom_price_cents` before it can go live. */
export const SPONSORED_SURVEY_BASE_PRICE_CENTS: Readonly<
  Record<Exclude<SponsoredSurveyLengthBucket, 'custom'>, number>
> = Object.freeze({ S: 500, M: 800, L: 1200 })

export const SPONSORED_SURVEY_COUNTRY_TIERS = [
  'tier1',
  'tier2',
  'tier3',
  'tier4',
  'tier5',
] as const

/**
 * The respondent's country tier. Mirrors `SponsoredSurveyCountryTier` in
 * `freebuff-freebucks.ts`, which is export-excluded and so cannot be imported
 * here; `packages/internal/src/sponsored-survey/types.ts` asserts the two match.
 */
export type SponsoredSurveyCountryTier =
  (typeof SPONSORED_SURVEY_COUNTRY_TIERS)[number]

/** Price multiplier by the respondent's country tier, in basis points
 *  (10000 = 1x). Mirrors measured ad value per account (~1 / 0.52 / 0.23 /
 *  0.08 of the US, `FREEBUCKS_FREE_DAILY_BY_COUNTRY_TIER`'s note). */
export const SPONSORED_SURVEY_TIER_MULTIPLIER_BPS: Readonly<
  Record<SponsoredSurveyCountryTier, number>
> = Object.freeze({
  tier1: 10_000,
  tier2: 5_500,
  tier3: 2_500,
  tier4: 1_000,
  tier5: 1_000,
})

/** The same multipliers as plain numbers, for display only. */
export const SPONSORED_SURVEY_TIER_MULTIPLIERS: Readonly<
  Record<SponsoredSurveyCountryTier, number>
> = Object.freeze({
  tier1: 1,
  tier2: 0.55,
  tier3: 0.25,
  tier4: 0.1,
  tier5: 0.1,
})

export const SPONSORED_SURVEY_SPEEDS = ['standard', 'expedited'] as const
export type SponsoredSurveySpeed = (typeof SPONSORED_SURVEY_SPEEDS)[number]

export const EXPEDITED_PRICE_MULTIPLIER = 1.5
export const SPONSORED_SURVEY_SPEED_MULTIPLIER_BPS: Readonly<
  Record<SponsoredSurveySpeed, number>
> = Object.freeze({ standard: 10_000, expedited: 15_000 })

/** No complete is ever billed below this. */
export const SPONSORED_SURVEY_MIN_PRICE_CENTS = 1

/** Freebucks paid to the user on a clean EXPEDITED complete, size S, by tier.
 *  M = S x 1.6 and L = S x 2.4, rounded half up; `custom` pays L. Standard
 *  pays nothing. A test pins the M and L rows to that formula. */
export const SPONSORED_SURVEY_REWARD_FREEBUCKS: Readonly<
  Record<
    Exclude<SponsoredSurveyLengthBucket, 'custom'>,
    Readonly<Record<SponsoredSurveyCountryTier, number>>
  >
> = Object.freeze({
  S: Object.freeze({ tier1: 25, tier2: 18, tier3: 10, tier4: 5, tier5: 5 }),
  M: Object.freeze({ tier1: 40, tier2: 29, tier3: 16, tier4: 8, tier5: 8 }),
  L: Object.freeze({ tier1: 60, tier2: 43, tier3: 24, tier4: 12, tier5: 12 }),
})

/** Aggregates hide any cell (option x breakdown) with fewer respondents. */
export const SPONSORED_SURVEY_MIN_RESULT_CELL = 30

/** An answer faster than this is flagged `fast` (same bar as the profile
 *  survey) and the complete is not billed. */
export const SPONSORED_SURVEY_FAST_ANSWER_MS = PROFILE_SURVEY_FAST_ANSWER_MS

/** A response is `straight_lined` when it has at least this many
 *  single-choice answers and every one picked the same option index. Three,
 *  not the profile survey's two: two matching picks are common and honest,
 *  and here the flag withholds money. */
export const SPONSORED_SURVEY_STRAIGHT_LINE_MIN_SINGLE = 3

/** Most sponsored surveys offered to one user per Pacific day. Enforced by the
 *  unique (user_id, offer_date) on `sponsored_survey_offer`, so it is 1. */
export const SPONSORED_SURVEY_OFFERS_PER_DAY = 1

export const SPONSORED_SURVEY_QUALITY_FLAGS = ['fast', 'straight_lined'] as const
export type SponsoredSurveyQualityFlag =
  (typeof SPONSORED_SURVEY_QUALITY_FLAGS)[number]

/** Why a complete was not billed (`sponsored_survey_response.not_billed_reason`). */
export const SPONSORED_SURVEY_NOT_BILLED_REASONS = [
  /** A `fast` answer or a `straight_lined` response. */
  'quality',
  /** The campaign's budget or target was already met. */
  'campaign_cap',
  /** The advertiser's balance could not cover it. */
  'insufficient_funds',
  /** The campaign was no longer live when the complete landed. */
  'campaign_not_live',
  /** Nothing left to deliver: the user cleared their answers or deleted the
   *  account (`user_id` NULL), or a question has no answer. */
  'withdrawn',
] as const
export type SponsoredSurveyNotBilledReason =
  (typeof SPONSORED_SURVEY_NOT_BILLED_REASONS)[number]

// ---- campaign status machine -------------------------------------------

export const SPONSORED_SURVEY_STATUSES = [
  'draft',
  'in_review',
  'live',
  'paused',
  'done',
  'rejected',
] as const
export type SponsoredSurveyStatus = (typeof SPONSORED_SURVEY_STATUSES)[number]

/**
 * Allowed transitions. Only `live` serves. Questions, speed and targeting are
 * editable only in `draft` (and `rejected`, which returns to draft to edit);
 * review approves exactly what it saw. `done` is terminal.
 */
export const SPONSORED_SURVEY_TRANSITIONS: Readonly<
  Record<SponsoredSurveyStatus, readonly SponsoredSurveyStatus[]>
> = Object.freeze({
  draft: ['in_review'],
  // Admin approves or rejects; the advertiser may withdraw to draft.
  in_review: ['live', 'rejected', 'draft'],
  live: ['paused', 'done'],
  paused: ['live', 'done'],
  done: [],
  rejected: ['draft'],
})

export function canTransition(
  from: SponsoredSurveyStatus,
  to: SponsoredSurveyStatus,
): boolean {
  return SPONSORED_SURVEY_TRANSITIONS[from]?.includes(to) ?? false
}

// ---- pure helpers -------------------------------------------------------

/** The bucket for a question count, or null when it is outside 1..MAX. */
export function sponsoredSurveyLengthBucket(
  questionCount: number,
): SponsoredSurveyLengthBucket | null {
  if (!Number.isInteger(questionCount)) return null
  for (const bucket of SPONSORED_SURVEY_LENGTH_BUCKETS) {
    const r = SPONSORED_SURVEY_BUCKET_RANGES[bucket]
    if (questionCount >= r.min && questionCount <= r.max) return bucket
  }
  return null
}

/**
 * Price of one clean complete, in integer cents:
 * `base x tier multiplier x speed multiplier`, rounded half up, never below
 * `SPONSORED_SURVEY_MIN_PRICE_CENTS`.
 *
 * `base` is `customPriceCents` when set (an admin override, allowed on any
 * bucket and REQUIRED on `custom`), else the bucket's list price. The override
 * is a tier-1 Standard price: tier and speed still apply on top. Returns null
 * for a `custom` bucket with no override, which must not go live.
 */
export function sponsoredSurveyPriceCents(params: {
  bucket: SponsoredSurveyLengthBucket
  tier: SponsoredSurveyCountryTier
  speed: SponsoredSurveySpeed
  customPriceCents?: number | null
}): number | null {
  const base =
    params.customPriceCents != null
      ? params.customPriceCents
      : params.bucket === 'custom'
        ? null
        : SPONSORED_SURVEY_BASE_PRICE_CENTS[params.bucket]
  if (base == null) return null
  if (!Number.isInteger(base) || base < SPONSORED_SURVEY_MIN_PRICE_CENTS) {
    throw new RangeError(`invalid sponsored survey base price: ${base}`)
  }
  const numerator =
    base *
    SPONSORED_SURVEY_TIER_MULTIPLIER_BPS[params.tier] *
    SPONSORED_SURVEY_SPEED_MULTIPLIER_BPS[params.speed]
  // Integer half-up rounding of numerator / 1e8 (both bps factors).
  const cents = Math.floor((numerator + 50_000_000) / 100_000_000)
  return Math.max(SPONSORED_SURVEY_MIN_PRICE_CENTS, cents)
}

/** Freebucks the user earns on a clean complete: 0 for Standard; the reward
 *  table for Expedited (`custom` pays L). */
export function sponsoredSurveyRewardFreebucks(params: {
  bucket: SponsoredSurveyLengthBucket
  tier: SponsoredSurveyCountryTier
  speed: SponsoredSurveySpeed
}): number {
  if (params.speed !== 'expedited') return 0
  const row = params.bucket === 'custom' ? 'L' : params.bucket
  return SPONSORED_SURVEY_REWARD_FREEBUCKS[row][params.tier]
}

/** The wallet credit idempotency key: one reward per user per campaign. */
export function sponsoredSurveyRewardKey(userId: string, campaignId: string) {
  return `survey:${SPONSORED_SURVEY_ID}:${campaignId}:${userId}`
}

/** The `ad_spend_ledger` operation id (its primary key) for a billed
 *  complete: one charge per response, ever. */
export function sponsoredSurveySpendOperationId(responseId: string) {
  return `survey_spend_${responseId}`
}

/** Clean = no `fast` answer and not `straight_lined`. Only clean completes
 *  are billed or rewarded. */
export function isCleanSponsoredSurveyResponse(params: {
  responseFlags: readonly string[] | null | undefined
  answerFlags: ReadonlyArray<readonly string[] | null | undefined>
}): boolean {
  if (params.responseFlags?.includes('straight_lined')) return false
  if (params.responseFlags?.includes('fast')) return false
  return !params.answerFlags.some((f) => f?.includes('fast'))
}

/** Same option index on every single-choice question, with at least
 *  `SPONSORED_SURVEY_STRAIGHT_LINE_MIN_SINGLE` of them answered. */
export function isStraightLinedSponsoredResponse(
  questions: readonly SponsoredSurveyQuestionInput[],
  answers: readonly { questionIndex: number; optionIds: readonly string[] }[],
): boolean {
  const indexes: number[] = []
  for (const a of answers) {
    const q = questions[a.questionIndex]
    if (!q || q.kind !== 'single') continue
    indexes.push(q.options.findIndex((o) => o.id === a.optionIds[0]))
  }
  return (
    indexes.length >= SPONSORED_SURVEY_STRAIGHT_LINE_MIN_SINGLE &&
    indexes.every((i) => i === indexes[0])
  )
}

/** Known option ids, no duplicates, single has exactly one, an exclusive
 *  option stands alone. */
export function isValidSponsoredSurveyAnswer(
  question: SponsoredSurveyQuestionInput,
  optionIds: readonly string[],
): boolean {
  if (optionIds.length === 0) return false
  if (new Set(optionIds).size !== optionIds.length) return false
  if (question.kind === 'single' && optionIds.length !== 1) return false
  const byId = new Map(question.options.map((o) => [o.id, o]))
  if (!optionIds.every((id) => byId.has(id))) return false
  if (optionIds.length > 1 && optionIds.some((id) => byId.get(id)?.exclusive))
    return false
  return true
}

// ---- the advertiser quote -------------------------------------------------

/** Share of respondents by country tier: non-negative, summing to about 1. */
export type SponsoredSurveyTierMix = Partial<
  Record<SponsoredSurveyCountryTier, number>
>

/**
 * The audience mix to quote with when no live measurement is available.
 * Source: weekly active Freebuff users by `freebuff_activity_day.country_tier`
 * over the 7 complete Pacific days to 2026-10-09 (the same read
 * `getSponsoredSurveyTierMix` makes). Refresh it when the mix moves.
 */
export const SPONSORED_SURVEY_DEFAULT_TIER_MIX: Readonly<
  Record<SponsoredSurveyCountryTier, number>
> = Object.freeze({
  tier1: 0.073,
  tier2: 0.06,
  tier3: 0.085,
  tier4: 0.76,
  tier5: 0.022,
})

/**
 * `mix` scaled to sum to exactly 1 over every tier. Missing, negative or
 * non-finite shares count as 0; a mix with nothing left falls back to
 * `SPONSORED_SURVEY_DEFAULT_TIER_MIX`.
 */
export function normalizeSponsoredSurveyTierMix(
  mix: SponsoredSurveyTierMix | null | undefined,
): Record<SponsoredSurveyCountryTier, number> {
  const clean = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  const sumOf = (m: SponsoredSurveyTierMix | null | undefined) =>
    SPONSORED_SURVEY_COUNTRY_TIERS.reduce((sum, t) => sum + clean(m?.[t]), 0)
  let source: SponsoredSurveyTierMix = mix ?? {}
  let sum = sumOf(source)
  if (!(sum > 0)) {
    source = SPONSORED_SURVEY_DEFAULT_TIER_MIX
    sum = sumOf(source)
  }
  const out = {} as Record<SponsoredSurveyCountryTier, number>
  for (const t of SPONSORED_SURVEY_COUNTRY_TIERS) out[t] = clean(source[t]) / sum
  return out
}

export type SponsoredSurveyQuoteRange = {
  /** The cheapest tier's price (tiers 4-5 on the v1 card). */
  minCents: number
  /** The dearest tier's price (tier 1). */
  maxCents: number
  /** The price weighted by the audience mix, rounded half up. */
  likelyCents: number
}

export type SponsoredSurveyQuote = {
  bucket: SponsoredSurveyLengthBucket
  speed: SponsoredSurveySpeed
  targetCompletes: number
  perComplete: SponsoredSurveyQuoteRange
  /** `perComplete` x `targetCompletes`, each bound. */
  total: SponsoredSurveyQuoteRange
  /** The normalised mix the likely price used. */
  tierMix: Record<SponsoredSurveyCountryTier, number>
}

/**
 * What an advertiser can expect to pay, now that Freebuff (not the
 * advertiser) controls the audience's country mix. The per-complete range runs
 * from the cheapest tier's price to tier 1's, for this bucket and speed
 * (`sponsoredSurveyPriceCents`, so Expedited x1.5 applies); "likely" weights
 * each tier's price by `tierMix` (normalised; empty -> the default mix). The
 * total is each per-complete figure times `targetCompletes`, so the three
 * numbers an advertiser sees always multiply out.
 *
 * Returns null when there is no list price: a `custom` bucket (21+ questions)
 * without an admin `customPriceCents` is quoted after review, and a question
 * count outside 1..MAX has no bucket. Throws on a non-positive or
 * non-integer `targetCompletes`.
 */
export function sponsoredSurveyQuote(
  params: (
    | { questionCount: number; bucket?: never }
    | { bucket: SponsoredSurveyLengthBucket; questionCount?: never }
  ) & {
    speed: SponsoredSurveySpeed
    targetCompletes: number
    tierMix?: SponsoredSurveyTierMix | null
    customPriceCents?: number | null
  },
): SponsoredSurveyQuote | null {
  const bucket =
    params.bucket ?? sponsoredSurveyLengthBucket(params.questionCount ?? NaN)
  if (!bucket) return null
  const completes = params.targetCompletes
  if (!Number.isInteger(completes) || completes < 1) {
    throw new RangeError(`invalid sponsored survey targetCompletes: ${completes}`)
  }
  const prices = {} as Record<SponsoredSurveyCountryTier, number>
  for (const tier of SPONSORED_SURVEY_COUNTRY_TIERS) {
    const price = sponsoredSurveyPriceCents({
      bucket,
      tier,
      speed: params.speed,
      customPriceCents: params.customPriceCents,
    })
    if (price === null) return null
    prices[tier] = price
  }
  const tierMix = normalizeSponsoredSurveyTierMix(params.tierMix)
  const values = SPONSORED_SURVEY_COUNTRY_TIERS.map((t) => prices[t])
  const minCents = Math.min(...values)
  const maxCents = Math.max(...values)
  const weighted = SPONSORED_SURVEY_COUNTRY_TIERS.reduce(
    (sum, t) => sum + prices[t] * tierMix[t],
    0,
  )
  // A weighted mean of integers lies within [min, max]; clamp away float dust.
  const likelyCents = Math.min(
    maxCents,
    Math.max(minCents, Math.round(weighted)),
  )
  return {
    bucket,
    speed: params.speed,
    targetCompletes: completes,
    perComplete: { minCents, maxCents, likelyCents },
    total: {
      minCents: minCents * completes,
      maxCents: maxCents * completes,
      likelyCents: likelyCents * completes,
    },
    tierMix,
  }
}

// ---- zod: campaign input ------------------------------------------------

export const SPONSORED_SURVEY_LIMITS = Object.freeze({
  nameMax: 120,
  sponsorNameMax: 80,
  promptMax: 300,
  optionLabelMax: 120,
  optionsMin: 2,
  optionsMax: 12,
  targetCompletesMax: 100_000,
  /** $100,000. */
  budgetCentsMax: 10_000_000,
  countriesMax: 250,
  profileAnswerFiltersMax: 10,
})

const OPTION_ID = /^[a-z0-9_]{1,32}$/

export const sponsoredSurveyOptionSchema = z.strictObject({
  /** Stable, stored verbatim on every answer. */
  id: z.string().regex(OPTION_ID),
  label: z.string().trim().min(1).max(SPONSORED_SURVEY_LIMITS.optionLabelMax),
  /** Choosing it clears every other option (multi only). */
  exclusive: z.boolean().optional(),
})
export type SponsoredSurveyOption = z.infer<typeof sponsoredSurveyOptionSchema>

export const SPONSORED_SURVEY_QUESTION_KINDS = ['single', 'multi'] as const
export type SponsoredSurveyQuestionKind =
  (typeof SPONSORED_SURVEY_QUESTION_KINDS)[number]

export const sponsoredSurveyQuestionSchema = z
  .strictObject({
    prompt: z.string().trim().min(1).max(SPONSORED_SURVEY_LIMITS.promptMax),
    kind: z.enum(SPONSORED_SURVEY_QUESTION_KINDS),
    options: z
      .array(sponsoredSurveyOptionSchema)
      .min(SPONSORED_SURVEY_LIMITS.optionsMin)
      .max(SPONSORED_SURVEY_LIMITS.optionsMax),
  })
  .refine(
    (q) => new Set(q.options.map((o) => o.id)).size === q.options.length,
    { message: 'option ids must be unique within a question', path: ['options'] },
  )
export type SponsoredSurveyQuestionInput = z.infer<
  typeof sponsoredSurveyQuestionSchema
>

export const SPONSORED_SURVEY_PLANS = ['free', 'paid'] as const
export type SponsoredSurveyPlan = (typeof SPONSORED_SURVEY_PLANS)[number]

const countryTiersField = z
  .array(z.enum(SPONSORED_SURVEY_COUNTRY_TIERS))
  .min(1)
  .max(SPONSORED_SURVEY_COUNTRY_TIERS.length)
  .optional()

/** ISO 3166-1 alpha-2, upper case. */
const countriesField = z
  .array(z.string().regex(/^[A-Z]{2}$/))
  .min(1)
  .max(SPONSORED_SURVEY_LIMITS.countriesMax)
  .optional()

const plansField = z.array(z.enum(SPONSORED_SURVEY_PLANS)).min(1).max(2).optional()

/** Profile-survey segments: the user's current answer to `questionId`
 *  includes at least one of `optionIds`. Flagged answers do not match
 *  (`listTargetableAnswers`). */
const profileAnswersField = z
  .array(
    z
      .strictObject({
        questionId: z.string().min(1).max(64),
        optionIds: z.array(z.string().min(1).max(64)).min(1).max(20),
      })
      .refine(
        (f) => {
          const q = profileSurveyQuestion(f.questionId)
          return (
            !!q && f.optionIds.every((id) => q.options.some((o) => o.id === id))
          )
        },
        { message: 'unknown profile survey question or option' },
      ),
  )
  .min(1)
  .max(SPONSORED_SURVEY_LIMITS.profileAnswerFiltersMax)
  .optional()

/**
 * What an ADVERTISER may target. Freebuff controls the audience mix, so there
 * is no country tier or country here: the advertiser sees a quote range
 * (`sponsoredSurveyQuote`) instead, and an advertiser campaign reaches every
 * tier. Strict, so a body that still sends `countryTiers` or `countries` is
 * refused rather than silently stored.
 */
export const sponsoredSurveyAdvertiserTargetingSchema = z.strictObject({
  plans: plansField,
  profileAnswers: profileAnswersField,
})
export type SponsoredSurveyAdvertiserTargeting = z.infer<
  typeof sponsoredSurveyAdvertiserTargetingSchema
>

/** The geography an ADMIN may add when approving (`reviewCampaign`). */
export const sponsoredSurveyAdminTargetingSchema = z.strictObject({
  countryTiers: countryTiersField,
  countries: countriesField,
})
export type SponsoredSurveyAdminTargeting = z.infer<
  typeof sponsoredSurveyAdminTargetingSchema
>

/**
 * The STORED targeting (`sponsored_survey_campaign.targeting`): the
 * advertiser's fields plus the admin-only geography. Every present field must
 * match (AND); the values within a field are alternatives (OR). An empty
 * object targets everyone who has finished (completed or stopped) the profile
 * survey.
 */
export const sponsoredSurveyTargetingSchema = z.strictObject({
  countryTiers: countryTiersField,
  countries: countriesField,
  plans: plansField,
  profileAnswers: profileAnswersField,
})
export type SponsoredSurveyTargeting = z.infer<
  typeof sponsoredSurveyTargetingSchema
>

/** The advertiser's create / edit-draft body. */
export const sponsoredSurveyCampaignInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(SPONSORED_SURVEY_LIMITS.nameMax),
  /** Shown to users on the card ("Survey from <sponsorName>"). */
  sponsorName: z
    .string()
    .trim()
    .min(1)
    .max(SPONSORED_SURVEY_LIMITS.sponsorNameMax),
  speed: z.enum(SPONSORED_SURVEY_SPEEDS),
  /** No country tiers or countries: see `sponsoredSurveyAdvertiserTargetingSchema`. */
  targeting: sponsoredSurveyAdvertiserTargetingSchema,
  targetCompletes: z
    .number()
    .int()
    .min(1)
    .max(SPONSORED_SURVEY_LIMITS.targetCompletesMax),
  budgetCents: z
    .number()
    .int()
    .min(SPONSORED_SURVEY_MIN_PRICE_CENTS)
    .max(SPONSORED_SURVEY_LIMITS.budgetCentsMax),
  questions: z
    .array(sponsoredSurveyQuestionSchema)
    .min(1)
    .max(SPONSORED_SURVEY_MAX_QUESTIONS),
})
export type SponsoredSurveyCampaignInput = z.infer<
  typeof sponsoredSurveyCampaignInputSchema
>

// ---- zod: survey event log ----------------------------------------------

/** `profile` stays valid (the table's CHECK allows it) but no client sends
 *  it: profile-survey engagement is `profile_survey_event` (#6278), and
 *  `survey_event` carries the sponsored card only. */
export const SURVEY_EVENT_KINDS = ['profile', 'sponsored'] as const
export type SurveyEventKind = (typeof SURVEY_EVENT_KINDS)[number]

export const SURVEY_EVENT_TYPES = [
  'card_rendered',
  'question_viewed',
  'answered',
  'dismissed',
  'abandoned',
] as const
export type SurveyEventType = (typeof SURVEY_EVENT_TYPES)[number]

export const SURVEY_EVENT_BATCH_MAX = 20
/** An hour. Longer dwell is a tab left open, not reading. */
export const SURVEY_EVENT_DWELL_MS_MAX = 60 * 60 * 1000

export const surveyEventSchema = z.strictObject({
  surveyKind: z.enum(SURVEY_EVENT_KINDS),
  /** Profile: the version as a string ("2"). Sponsored: the campaign id. */
  surveyRef: z.string().min(1).max(64),
  eventType: z.enum(SURVEY_EVENT_TYPES),
  questionId: z.string().min(1).max(64).optional(),
  questionIndex: z
    .number()
    .int()
    .min(0)
    .max(SPONSORED_SURVEY_MAX_QUESTIONS - 1)
    .optional(),
  dwellMs: z.number().int().min(0).max(SURVEY_EVENT_DWELL_MS_MAX).optional(),
  surface: z.enum(PROFILE_SURVEY_SURFACES).optional(),
  /** Client clock, ISO 8601. Stored for ordering within a session only;
   *  `created_at` (server) is the authority. */
  clientTs: z.iso.datetime({ offset: true }).optional(),
})
export type SurveyEventInput = z.infer<typeof surveyEventSchema>

/** POST body of the event endpoint. */
export const surveyEventBatchSchema = z.strictObject({
  events: z.array(surveyEventSchema).min(1).max(SURVEY_EVENT_BATCH_MAX),
})
export type SurveyEventBatch = z.infer<typeof surveyEventBatchSchema>
