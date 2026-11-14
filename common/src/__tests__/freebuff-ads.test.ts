import { describe, expect, it } from 'bun:test'

import {
  AD_CAMPAIGN_STATUSES,
  AD_CAMPAIGN_STATUS_LABELS,
  AD_COMPARISON,
  AD_ENGAGEMENT_STATUSES,
  AD_ENGAGEMENT_STATUS_LABELS,
  AD_DAILY_BUDGET_STEP_CENTS,
  AD_ENGAGEMENT_PRICE_CENTS,
  AD_MAX_DAILY_BUDGET_CENTS,
  AD_MIN_DAILY_BUDGET_CENTS,
  AD_PLATFORMS,
  AD_PLATFORM_ACTIONS,
  AD_PLATFORM_LABELS,
  adEvidenceAttestation,
  engagementsForDailyBudget,
  isValidDailyBudgetCents,
  normalizeDailyBudgetCents,
  platformForUrl,
  platformRequiresComment,
} from '../constants/freebuff-ads'

describe('pricing', () => {
  it('makes the headline claim true by arithmetic', () => {
    // "$10 gets you 20 engagements" is on the landing page, in the metadata,
    // and in the FAQ. All three read this function; this pins the claim.
    expect(engagementsForDailyBudget(1_000)).toBe(20)
    expect(AD_COMPARISON.engagementsPerTenDollars).toBe(20)
    expect(AD_ENGAGEMENT_PRICE_CENTS).toBe(50)
  })

  it('never promises a fractional engagement', () => {
    for (let cents = 0; cents <= 5_000; cents += 37) {
      expect(Number.isInteger(engagementsForDailyBudget(cents))).toBe(true)
    }
  })
})

describe('normalizeDailyBudgetCents', () => {
  it('snaps a hand-rolled amount onto the ladder', () => {
    // The API is reachable directly; a crafted request must not be able to buy
    // $10.37/day and end up with a budget no slider position can express.
    expect(normalizeDailyBudgetCents(1_037)).toBe(1_000)
    expect(normalizeDailyBudgetCents(1_260)).toBe(1_500)
    expect(normalizeDailyBudgetCents(2_499)).toBe(2_500)
  })

  it('clamps to the floor and the ceiling', () => {
    expect(normalizeDailyBudgetCents(0)).toBe(AD_MIN_DAILY_BUDGET_CENTS)
    expect(normalizeDailyBudgetCents(-5_000)).toBe(AD_MIN_DAILY_BUDGET_CENTS)
    expect(normalizeDailyBudgetCents(10_000_000)).toBe(AD_MAX_DAILY_BUDGET_CENTS)
  })

  it('always produces a value its own validator accepts', () => {
    // The two functions guard different call sites (the write path normalizes,
    // the read path validates) and a disagreement between them would be a
    // campaign that cannot be saved and cannot be edited.
    for (const raw of [0, 1, 999, 1_001, 3_333, 99_999, 250_000]) {
      expect(isValidDailyBudgetCents(normalizeDailyBudgetCents(raw))).toBe(true)
    }
  })

  it('rejects amounts off the step ladder', () => {
    expect(isValidDailyBudgetCents(1_037)).toBe(false)
    expect(isValidDailyBudgetCents(AD_MIN_DAILY_BUDGET_CENTS - AD_DAILY_BUDGET_STEP_CENTS)).toBe(false)
    expect(isValidDailyBudgetCents(1_000.5)).toBe(false)
  })
})

describe('platformForUrl', () => {
  it('recognises the four platforms and their alternate hosts', () => {
    expect(platformForUrl('https://x.com/acme/status/123')).toBe('twitter')
    expect(platformForUrl('https://twitter.com/acme/status/123')).toBe('twitter')
    expect(platformForUrl('https://www.linkedin.com/posts/acme_x-activity-1')).toBe('linkedin')
    // LinkedIn's own shortener — what the share sheet hands people.
    expect(platformForUrl('https://lnkd.in/p/gJpFPcbf')).toBe('linkedin')
    expect(platformForUrl('https://www.reddit.com/r/programming/comments/abc/')).toBe('reddit')
    expect(platformForUrl('https://redd.it/abc')).toBe('reddit')
    expect(platformForUrl('https://github.com/workweave/router')).toBe('github')
  })

  it('matches subdomains but not lookalike domains', () => {
    // The lookalike case is the one that matters: `x.com.evil.example` would
    // pass a naive `includes` check, and the platform decides which
    // instructions a user is shown.
    expect(platformForUrl('https://old.reddit.com/r/x/comments/y/')).toBe('reddit')
    expect(platformForUrl('https://x.com.evil.example/a')).toBeNull()
    expect(platformForUrl('https://notx.com/a')).toBeNull()
    expect(platformForUrl('https://mylinkedin.com/a')).toBeNull()
    expect(platformForUrl('https://mygithub.com/a')).toBeNull()
  })

  it('takes a YouTube link only for the Earn chat', () => {
    // The advertiser console's forms and routes call it bare: nothing there
    // sells a single action, so a video link is no platform to them.
    expect(platformForUrl('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(platformForUrl('https://youtu.be/abc')).toBeNull()
    expect(
      platformForUrl('https://www.youtube.com/watch?v=abc', { earnChat: true }),
    ).toBe('youtube')
    expect(platformForUrl('https://youtu.be/abc', { earnChat: true })).toBe('youtube')
    expect(platformForUrl('https://x.com/acme/status/1', { earnChat: true })).toBe('twitter')
  })

  it('refuses anything that is not an http(s) URL', () => {
    expect(platformForUrl('javascript:alert(1)')).toBeNull()
    expect(platformForUrl('not a url')).toBeNull()
    expect(platformForUrl('')).toBeNull()
  })
})

describe('platform copy', () => {
  it('describes every platform it can detect', () => {
    for (const platform of AD_PLATFORMS) {
      expect(AD_PLATFORM_LABELS[platform]).toBeTruthy()
      expect(AD_PLATFORM_ACTIONS[platform].length).toBeGreaterThan(0)
    }
  })

  it('never asks a Reddit user to repost', () => {
    // Reddit has no repost, and asking for one produces instructions describing
    // an action the platform does not have — the user, not the advertiser, is
    // the one who would look foolish following them.
    const reddit = AD_PLATFORM_ACTIONS.reddit.join(' ').toLowerCase()
    expect(reddit).not.toContain('repost')
    expect(reddit).toContain('upvote')
  })

  it('asks a GitHub user only to star — no comment, no repost', () => {
    // GitHub has neither comments-on-a-post nor reposts; the engagement is a
    // star and the instructions must not describe anything else.
    const github = AD_PLATFORM_ACTIONS.github.join(' ').toLowerCase()
    expect(github).toContain('star')
    expect(github).not.toContain('comment')
    expect(github).not.toContain('repost')
  })

  it('knows which platforms involve writing a comment', () => {
    expect(platformRequiresComment('twitter')).toBe(true)
    expect(platformRequiresComment('linkedin')).toBe(true)
    expect(platformRequiresComment('reddit')).toBe(true)
    expect(platformRequiresComment('github')).toBe(false)
  })

  it('attests to the action the platform actually asks for', () => {
    expect(adEvidenceAttestation('twitter')).toContain('commented')
    expect(adEvidenceAttestation('github')).toContain('starred')
    expect(adEvidenceAttestation('github')).not.toContain('commented')
  })
})

describe('status unions mirror the database enums', () => {
  it('includes every engagement status the schema can store', () => {
    // `flagged` existed in the pg enum for a day without being here, which
    // made the one status carrying a consequence unrepresentable in every
    // surface typed against AdEngagementStatus. If this list and the enum in
    // packages/internal/src/db/schema.ts ever disagree again, the symptom is
    // silent — a filter that can never match.
    expect([...AD_ENGAGEMENT_STATUSES]).toEqual([
      'pending',
      'approved',
      'rejected',
      'skipped',
      'flagged',
    ])
  })

  it('labels every status it declares', () => {
    for (const status of AD_ENGAGEMENT_STATUSES) {
      expect(AD_ENGAGEMENT_STATUS_LABELS[status]).toBeTruthy()
    }
    for (const status of AD_CAMPAIGN_STATUSES) {
      expect(AD_CAMPAIGN_STATUS_LABELS[status]).toBeTruthy()
    }
  })
})
