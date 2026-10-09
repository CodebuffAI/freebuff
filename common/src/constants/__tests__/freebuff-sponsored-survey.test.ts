import { describe, expect, it } from 'bun:test'

import {
  canTransition,
  isCleanSponsoredSurveyResponse,
  isStraightLinedSponsoredResponse,
  isValidSponsoredSurveyAnswer,
  SPONSORED_SURVEY_COUNTRY_TIERS,
  SPONSORED_SURVEY_MAX_QUESTIONS,
  SPONSORED_SURVEY_REWARD_FREEBUCKS,
  SPONSORED_SURVEY_STATUSES,
  SPONSORED_SURVEY_TIER_MULTIPLIER_BPS,
  SPONSORED_SURVEY_TIER_MULTIPLIERS,
  normalizeSponsoredSurveyTierMix,
  SPONSORED_SURVEY_DEFAULT_TIER_MIX,
  sponsoredSurveyAdminTargetingSchema,
  sponsoredSurveyAdvertiserTargetingSchema,
  sponsoredSurveyCampaignInputSchema,
  sponsoredSurveyLengthBucket,
  sponsoredSurveyPriceCents,
  sponsoredSurveyQuote,
  sponsoredSurveyRewardFreebucks,
  sponsoredSurveyTargetingSchema,
  surveyEventBatchSchema,
  type SponsoredSurveyQuestionInput,
} from '../freebuff-sponsored-survey'

const single = (n = 3): SponsoredSurveyQuestionInput => ({
  prompt: 'Pick one',
  kind: 'single',
  options: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `O${i}` })),
})

describe('sponsoredSurveyLengthBucket', () => {
  it('maps counts to buckets at every boundary', () => {
    expect(sponsoredSurveyLengthBucket(0)).toBeNull()
    expect(sponsoredSurveyLengthBucket(1)).toBe('S')
    expect(sponsoredSurveyLengthBucket(5)).toBe('S')
    expect(sponsoredSurveyLengthBucket(6)).toBe('M')
    expect(sponsoredSurveyLengthBucket(10)).toBe('M')
    expect(sponsoredSurveyLengthBucket(11)).toBe('L')
    expect(sponsoredSurveyLengthBucket(20)).toBe('L')
    expect(sponsoredSurveyLengthBucket(21)).toBe('custom')
    expect(sponsoredSurveyLengthBucket(SPONSORED_SURVEY_MAX_QUESTIONS)).toBe(
      'custom',
    )
    expect(
      sponsoredSurveyLengthBucket(SPONSORED_SURVEY_MAX_QUESTIONS + 1),
    ).toBeNull()
    expect(sponsoredSurveyLengthBucket(2.5)).toBeNull()
  })
})

describe('sponsoredSurveyPriceCents', () => {
  it('pins the standard rate card', () => {
    const card = (['S', 'M', 'L'] as const).map((bucket) =>
      SPONSORED_SURVEY_COUNTRY_TIERS.map((tier) =>
        sponsoredSurveyPriceCents({ bucket, tier, speed: 'standard' }),
      ),
    )
    expect(card).toEqual([
      [500, 275, 125, 50, 50],
      [800, 440, 200, 80, 80],
      [1200, 660, 300, 120, 120],
    ])
  })

  it('pins the expedited rate card (x1.5, rounded half up)', () => {
    const card = (['S', 'M', 'L'] as const).map((bucket) =>
      SPONSORED_SURVEY_COUNTRY_TIERS.map((tier) =>
        sponsoredSurveyPriceCents({ bucket, tier, speed: 'expedited' }),
      ),
    )
    expect(card).toEqual([
      [750, 413, 188, 75, 75], // 412.5 -> 413, 187.5 -> 188
      [1200, 660, 300, 120, 120],
      [1800, 990, 450, 180, 180],
    ])
  })

  it('requires an override on custom and applies tier and speed on top', () => {
    expect(
      sponsoredSurveyPriceCents({ bucket: 'custom', tier: 'tier1', speed: 'standard' }),
    ).toBeNull()
    expect(
      sponsoredSurveyPriceCents({
        bucket: 'custom',
        tier: 'tier2',
        speed: 'expedited',
        customPriceCents: 2000,
      }),
    ).toBe(1650)
    expect(
      sponsoredSurveyPriceCents({
        bucket: 'S',
        tier: 'tier1',
        speed: 'standard',
        customPriceCents: 333,
      }),
    ).toBe(333)
  })

  it('never prices below 1 cent and rejects a bad override', () => {
    expect(
      sponsoredSurveyPriceCents({
        bucket: 'S',
        tier: 'tier4',
        speed: 'standard',
        customPriceCents: 1,
      }),
    ).toBe(1)
    expect(() =>
      sponsoredSurveyPriceCents({
        bucket: 'S',
        tier: 'tier1',
        speed: 'standard',
        customPriceCents: 0,
      }),
    ).toThrow()
    expect(() =>
      sponsoredSurveyPriceCents({
        bucket: 'S',
        tier: 'tier1',
        speed: 'standard',
        customPriceCents: 1.5,
      }),
    ).toThrow()
  })

  it('keeps the display multipliers in step with the bps', () => {
    for (const tier of SPONSORED_SURVEY_COUNTRY_TIERS) {
      expect(SPONSORED_SURVEY_TIER_MULTIPLIER_BPS[tier] / 10_000).toBe(
        SPONSORED_SURVEY_TIER_MULTIPLIERS[tier],
      )
    }
  })
})

describe('sponsoredSurveyRewardFreebucks', () => {
  it('M and L rows are S x 1.6 and S x 2.4, rounded half up', () => {
    for (const tier of SPONSORED_SURVEY_COUNTRY_TIERS) {
      const s = SPONSORED_SURVEY_REWARD_FREEBUCKS.S[tier]
      expect(SPONSORED_SURVEY_REWARD_FREEBUCKS.M[tier]).toBe(
        Math.floor((s * 16 + 5) / 10),
      )
      expect(SPONSORED_SURVEY_REWARD_FREEBUCKS.L[tier]).toBe(
        Math.floor((s * 24 + 5) / 10),
      )
    }
  })

  it('pays nothing on standard, the table on expedited, L for custom', () => {
    expect(
      sponsoredSurveyRewardFreebucks({ bucket: 'S', tier: 'tier1', speed: 'standard' }),
    ).toBe(0)
    expect(
      sponsoredSurveyRewardFreebucks({ bucket: 'S', tier: 'tier2', speed: 'expedited' }),
    ).toBe(18)
    expect(
      sponsoredSurveyRewardFreebucks({ bucket: 'custom', tier: 'tier1', speed: 'expedited' }),
    ).toBe(60)
  })
})

describe('canTransition', () => {
  it('allows exactly the documented edges', () => {
    const allowed = new Set([
      'draft>in_review',
      'in_review>live',
      'in_review>rejected',
      'in_review>draft',
      'live>paused',
      'live>done',
      'paused>live',
      'paused>done',
      'rejected>draft',
    ])
    for (const from of SPONSORED_SURVEY_STATUSES) {
      for (const to of SPONSORED_SURVEY_STATUSES) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`))
      }
    }
  })
})

describe('quality', () => {
  it('a fast answer or straight-lining makes a response unclean', () => {
    expect(
      isCleanSponsoredSurveyResponse({ responseFlags: null, answerFlags: [null, []] }),
    ).toBe(true)
    expect(
      isCleanSponsoredSurveyResponse({ responseFlags: [], answerFlags: [['fast']] }),
    ).toBe(false)
    expect(
      isCleanSponsoredSurveyResponse({
        responseFlags: ['straight_lined'],
        answerFlags: [],
      }),
    ).toBe(false)
  })

  it('straight-lining needs three single-choice answers at one index', () => {
    const qs = [single(), single(), single(), { ...single(), kind: 'multi' as const }]
    const at = (i: number, opt: string) => ({ questionIndex: i, optionIds: [opt] })
    expect(isStraightLinedSponsoredResponse(qs, [at(0, 'o0'), at(1, 'o0')])).toBe(
      false,
    )
    expect(
      isStraightLinedSponsoredResponse(qs, [at(0, 'o1'), at(1, 'o1'), at(2, 'o1')]),
    ).toBe(true)
    expect(
      isStraightLinedSponsoredResponse(qs, [at(0, 'o1'), at(1, 'o2'), at(2, 'o1')]),
    ).toBe(false)
  })

  it('validates answers like the profile survey', () => {
    const multi: SponsoredSurveyQuestionInput = {
      prompt: 'Pick any',
      kind: 'multi',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'none', label: 'None', exclusive: true },
      ],
    }
    expect(isValidSponsoredSurveyAnswer(single(), ['o0'])).toBe(true)
    expect(isValidSponsoredSurveyAnswer(single(), ['o0', 'o1'])).toBe(false)
    expect(isValidSponsoredSurveyAnswer(single(), [])).toBe(false)
    expect(isValidSponsoredSurveyAnswer(single(), ['zz'])).toBe(false)
    expect(isValidSponsoredSurveyAnswer(multi, ['a', 'b'])).toBe(true)
    expect(isValidSponsoredSurveyAnswer(multi, ['a', 'a'])).toBe(false)
    expect(isValidSponsoredSurveyAnswer(multi, ['a', 'none'])).toBe(false)
  })
})

describe('zod schemas', () => {
  const campaign = {
    name: 'Q4 DB survey',
    sponsorName: 'Acme',
    speed: 'expedited',
    targeting: { plans: ['free'] },
    targetCompletes: 500,
    budgetCents: 500_000,
    questions: [single()],
  }

  it('accepts a valid campaign', () => {
    expect(sponsoredSurveyCampaignInputSchema.safeParse(campaign).success).toBe(true)
  })

  it('rejects unknown keys, duplicate option ids and too many questions', () => {
    expect(
      sponsoredSurveyCampaignInputSchema.safeParse({ ...campaign, extra: 1 }).success,
    ).toBe(false)
    expect(
      sponsoredSurveyCampaignInputSchema.safeParse({
        ...campaign,
        questions: [
          {
            prompt: 'x',
            kind: 'single',
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      sponsoredSurveyCampaignInputSchema.safeParse({
        ...campaign,
        questions: Array.from({ length: SPONSORED_SURVEY_MAX_QUESTIONS + 1 }, () =>
          single(),
        ),
      }).success,
    ).toBe(false)
  })

  it('advertisers cannot target country tiers or countries; the stored shape can', () => {
    for (const geo of [{ countryTiers: ['tier1'] }, { countries: ['US'] }]) {
      expect(
        sponsoredSurveyCampaignInputSchema.safeParse({
          ...campaign,
          targeting: { ...campaign.targeting, ...geo },
        }).success,
      ).toBe(false)
      expect(sponsoredSurveyAdvertiserTargetingSchema.safeParse(geo).success).toBe(false)
      expect(sponsoredSurveyAdminTargetingSchema.safeParse(geo).success).toBe(true)
      expect(
        sponsoredSurveyTargetingSchema.safeParse({ plans: ['paid'], ...geo }).success,
      ).toBe(true)
    }
    // The admin schema is geography only.
    expect(sponsoredSurveyAdminTargetingSchema.safeParse({ plans: ['paid'] }).success).toBe(
      false,
    )
    // An advertiser targeting value is always a valid stored one.
    expect(
      sponsoredSurveyTargetingSchema.safeParse(campaign.targeting).success,
    ).toBe(true)
  })

  it('checks profile-answer targeting against the profile bank', () => {
    expect(
      sponsoredSurveyTargetingSchema.safeParse({
        profileAnswers: [{ questionId: 'team_size', optionIds: ['solo'] }],
      }).success,
    ).toBe(true)
    expect(
      sponsoredSurveyTargetingSchema.safeParse({
        profileAnswers: [{ questionId: 'team_size', optionIds: ['nope'] }],
      }).success,
    ).toBe(false)
    expect(
      sponsoredSurveyTargetingSchema.safeParse({
        profileAnswers: [{ questionId: 'nope', optionIds: ['solo'] }],
      }).success,
    ).toBe(false)
    expect(
      sponsoredSurveyTargetingSchema.safeParse({ countries: ['us'] }).success,
    ).toBe(false)
  })

  it('caps the event batch at 20 and bounds each field', () => {
    const event = {
      surveyKind: 'sponsored',
      surveyRef: 'c1',
      eventType: 'question_viewed',
      questionIndex: 0,
      dwellMs: 1200,
      surface: 'desktop',
      clientTs: '2026-10-09T10:00:00.000-07:00',
    }
    expect(surveyEventBatchSchema.safeParse({ events: [event] }).success).toBe(true)
    expect(
      surveyEventBatchSchema.safeParse({
        events: Array.from({ length: 21 }, () => event),
      }).success,
    ).toBe(false)
    expect(surveyEventBatchSchema.safeParse({ events: [] }).success).toBe(false)
    expect(
      surveyEventBatchSchema.safeParse({
        events: [{ ...event, dwellMs: 4 * 60 * 60 * 1000 }],
      }).success,
    ).toBe(false)
    expect(
      surveyEventBatchSchema.safeParse({ events: [{ ...event, eventType: 'x' }] })
        .success,
    ).toBe(false)
  })
})

describe('sponsoredSurveyQuote', () => {
  it('the default mix is the 2026-10-09 WAU measurement and sums to 1', () => {
    expect(SPONSORED_SURVEY_DEFAULT_TIER_MIX).toEqual({
      tier1: 0.073,
      tier2: 0.06,
      tier3: 0.085,
      tier4: 0.76,
      tier5: 0.022,
    })
    const sum = Object.values(SPONSORED_SURVEY_DEFAULT_TIER_MIX).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 9)
  })

  it('normalises a mix, and falls back to the default when empty', () => {
    const m = normalizeSponsoredSurveyTierMix({ tier1: 2, tier4: 6 })
    expect(m).toEqual({ tier1: 0.25, tier2: 0, tier3: 0, tier4: 0.75, tier5: 0 })
    const bad = normalizeSponsoredSurveyTierMix({
      tier1: -1,
      tier2: Number.NaN,
      tier3: Number.POSITIVE_INFINITY,
      tier5: 1,
    })
    expect(bad).toEqual({ tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 1 })
    for (const empty of [null, undefined, {}, { tier1: 0 }]) {
      const d = normalizeSponsoredSurveyTierMix(empty)
      for (const t of SPONSORED_SURVEY_COUNTRY_TIERS)
        expect(d[t]).toBeCloseTo(SPONSORED_SURVEY_DEFAULT_TIER_MIX[t], 12)
    }
  })

  it('4 questions at 400 completes, default mix: Standard and Expedited', () => {
    const standard = sponsoredSurveyQuote({
      questionCount: 4,
      speed: 'standard',
      targetCompletes: 400,
    })
    // 500*.073 + 275*.06 + 125*.085 + 50*.76 + 50*.022 = 102.725
    expect(standard?.bucket).toBe('S')
    expect(standard?.perComplete).toEqual({ minCents: 50, maxCents: 500, likelyCents: 103 })
    expect(standard?.total).toEqual({
      minCents: 20_000,
      maxCents: 200_000,
      likelyCents: 41_200,
    })
    const expedited = sponsoredSurveyQuote({
      questionCount: 4,
      speed: 'expedited',
      targetCompletes: 400,
    })
    // 750*.073 + 413*.06 + 188*.085 + 75*.76 + 75*.022 = 154.16
    expect(expedited?.perComplete).toEqual({ minCents: 75, maxCents: 750, likelyCents: 154 })
    expect(expedited?.total).toEqual({
      minCents: 30_000,
      maxCents: 300_000,
      likelyCents: 61_600,
    })
  })

  it('the range is the card: tier 4-5 price to tier 1 price, for every bucket and speed', () => {
    for (const bucket of ['S', 'M', 'L'] as const)
      for (const speed of ['standard', 'expedited'] as const) {
        const q = sponsoredSurveyQuote({ bucket, speed, targetCompletes: 1 })!
        expect(q.perComplete.minCents).toBe(
          sponsoredSurveyPriceCents({ bucket, tier: 'tier4', speed })!,
        )
        expect(q.perComplete.maxCents).toBe(
          sponsoredSurveyPriceCents({ bucket, tier: 'tier1', speed })!,
        )
        expect(q.perComplete.likelyCents).toBeGreaterThanOrEqual(q.perComplete.minCents)
        expect(q.perComplete.likelyCents).toBeLessThanOrEqual(q.perComplete.maxCents)
      }
  })

  it('likely follows the mix', () => {
    const allTier1 = sponsoredSurveyQuote({
      bucket: 'M',
      speed: 'standard',
      targetCompletes: 10,
      tierMix: { tier1: 1 },
    })
    expect(allTier1?.perComplete.likelyCents).toBe(800)
    expect(allTier1?.total.likelyCents).toBe(8_000)
    const half = sponsoredSurveyQuote({
      bucket: 'M',
      speed: 'standard',
      targetCompletes: 10,
      tierMix: { tier1: 0.5, tier5: 0.5 },
    })
    expect(half?.perComplete.likelyCents).toBe(440)
  })

  it('custom is quoted after review; an admin price quotes it', () => {
    expect(
      sponsoredSurveyQuote({ questionCount: 25, speed: 'standard', targetCompletes: 100 }),
    ).toBeNull()
    expect(
      sponsoredSurveyQuote({ bucket: 'custom', speed: 'standard', targetCompletes: 100 }),
    ).toBeNull()
    const priced = sponsoredSurveyQuote({
      bucket: 'custom',
      speed: 'standard',
      targetCompletes: 100,
      customPriceCents: 2000,
    })
    expect(priced?.perComplete.maxCents).toBe(2000)
    expect(priced?.perComplete.minCents).toBe(200)
  })

  it('refuses counts with no bucket and bad completes', () => {
    expect(
      sponsoredSurveyQuote({ questionCount: 0, speed: 'standard', targetCompletes: 1 }),
    ).toBeNull()
    expect(
      sponsoredSurveyQuote({
        questionCount: SPONSORED_SURVEY_MAX_QUESTIONS + 1,
        speed: 'standard',
        targetCompletes: 1,
      }),
    ).toBeNull()
    expect(() =>
      sponsoredSurveyQuote({ questionCount: 4, speed: 'standard', targetCompletes: 0 }),
    ).toThrow(RangeError)
    expect(() =>
      sponsoredSurveyQuote({ questionCount: 4, speed: 'standard', targetCompletes: 1.5 }),
    ).toThrow(RangeError)
  })
})
