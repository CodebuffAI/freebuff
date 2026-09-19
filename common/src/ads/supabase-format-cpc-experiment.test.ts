import { describe, expect, test } from 'bun:test'

import {
  SUPABASE_AGENTIC_INITIAL_CTA_BILLING_VERSION,
  SUPABASE_FORMAT_CPC_DAILY_CAP_CENTS,
  SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION,
  SUPABASE_FORMAT_CPC_PRICE_CENTS,
  evaluateSupabaseFormatCpcEligibility,
  supabaseFormatCpcArmForUser,
  supabaseFormatCpcExperimentMode,
  supabaseFormatCpcPolicyForArm,
  validateSupabaseFormatCpcCandidate,
} from './supabase-format-cpc-experiment'

function eligibleInput(userId: string) {
  return {
    userId,
    qualifiedRelevance: true,
    geoTier: 'tier1' as const,
    executionSurface: 'desktop_macos',
    invitationBillingVersion: SUPABASE_AGENTIC_INITIAL_CTA_BILLING_VERSION,
  }
}

function candidate(arm: 'display' | 'agentic') {
  const policy = supabaseFormatCpcPolicyForArm(arm)
  return {
    campaignId: policy.campaignId,
    status: 'active',
    reviewed: true,
    billingModel: 'cpc' as const,
    cpcCents: policy.cpcCents,
    dailyCapCents: SUPABASE_FORMAT_CPC_DAILY_CAP_CENTS,
    totalBudgetCents: null,
    availableBalanceCents: 50_000,
    spentTodayCents: 0,
  }
}

describe('Supabase CPC format experiment policy', () => {
  test('is dark except for the exact on value', () => {
    expect(supabaseFormatCpcExperimentMode(undefined)).toBe('off')
    expect(supabaseFormatCpcExperimentMode('ON')).toBe('off')
    expect(supabaseFormatCpcExperimentMode('on')).toBe('on')
  })

  test('has an independently salted stable 50/50 authenticated assignment', () => {
    const assignments = new Set<'display' | 'agentic'>()
    for (let index = 0; index < 10_000; index++) {
      const userId = `cpc-format-user-${index}`
      const first = supabaseFormatCpcArmForUser(userId)
      expect(supabaseFormatCpcArmForUser(userId)).toBe(first)
      if (first) assignments.add(first)
    }
    expect(assignments).toEqual(new Set(['display', 'agentic']))
    for (const userId of [null, undefined, '', '  ']) {
      expect(supabaseFormatCpcArmForUser(userId)).toBeNull()
    }
  })

  test('uses exactly the requested prices, per-arm daily cap, and first CTA billing', () => {
    const display = supabaseFormatCpcPolicyForArm('display')
    const agentic = supabaseFormatCpcPolicyForArm('agentic')
    expect(display).toMatchObject({
      experimentVersion: SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION,
      cpcCents: SUPABASE_FORMAT_CPC_PRICE_CENTS.display,
      dailyCapCents: 12_500,
      billingAction: 'display_click',
    })
    expect(agentic).toMatchObject({
      cpcCents: SUPABASE_FORMAT_CPC_PRICE_CENTS.agentic,
      dailyCapCents: 12_500,
      billingAction: 'agentic_initial_implement_click',
    })
  })

  test('holds both arms to the same Tier 1 population', () => {
    const users = Array.from({ length: 200 }, (_, index) => `reach-user-${index}`)

    // Neither arm reaches Tier 2: an uneven reach would make the 50/50
    // readout a comparison between two different populations.
    for (const userId of users) {
      expect(
        evaluateSupabaseFormatCpcEligibility({
          ...eligibleInput(userId),
          geoTier: 'tier2',
        }),
      ).toEqual({ eligible: false, reason: 'geo_not_eligible' })
    }

    // Both arms DO serve on Tier 1, and reach never re-rolls the assignment.
    const served = new Set<'display' | 'agentic'>()
    for (const userId of users) {
      const result = evaluateSupabaseFormatCpcEligibility(eligibleInput(userId))
      expect(result.eligible).toBe(true)
      if (result.eligible) {
        expect(result.arm).toBe(supabaseFormatCpcArmForUser(userId)!)
        served.add(result.arm)
      }
    }
    expect(served).toEqual(new Set(['display', 'agentic']))
  })

  test('refuses Windows for both arms until a client can report it', () => {
    for (const userId of ['reach-user-0', 'reach-user-1', 'reach-user-2']) {
      expect(
        evaluateSupabaseFormatCpcEligibility({
          ...eligibleInput(userId),
          executionSurface: 'desktop_windows',
        }),
      ).toEqual({ eligible: false, reason: 'surface_not_eligible' })
    }
  })

  test('fails closed outside qualified Mac/Linux Desktop evidence', () => {
    for (const input of [
      { ...eligibleInput('user-1'), qualifiedRelevance: false },
      { ...eligibleInput('user-1'), geoTier: 'unknown' },
      { ...eligibleInput('user-1'), executionSurface: 'cli_linux' },
      { ...eligibleInput('user-1'), userId: null },
    ]) {
      expect(evaluateSupabaseFormatCpcEligibility(input).eligible).toBe(false)
    }
  })

  test('requires v1 initial-CTA billing support only for the agentic arm', () => {
    const agenticUser = Array.from({ length: 100 }, (_, index) => `user-${index}`).find(
      (userId) => supabaseFormatCpcArmForUser(userId) === 'agentic',
    )!
    const displayUser = Array.from({ length: 100 }, (_, index) => `user-${index}`).find(
      (userId) => supabaseFormatCpcArmForUser(userId) === 'display',
    )!
    expect(
      evaluateSupabaseFormatCpcEligibility({
        ...eligibleInput(agenticUser),
        invitationBillingVersion: 0,
      }),
    ).toEqual({ eligible: false, reason: 'agentic_client_update_required' })
    expect(
      evaluateSupabaseFormatCpcEligibility({
        ...eligibleInput(displayUser),
        invitationBillingVersion: 0,
      }),
    ).toMatchObject({ eligible: true, arm: 'display' })
  })

  test('accepts only the assigned canonical active reviewed CPC campaign with no lifetime cap', () => {
    expect(validateSupabaseFormatCpcCandidate({ arm: 'display', candidate: candidate('display') })).toMatchObject({ valid: true })
    expect(
      validateSupabaseFormatCpcCandidate({ arm: 'display', candidate: candidate('agentic') }),
    ).toEqual({ valid: false, reason: 'campaign_not_canonical' })
    expect(
      validateSupabaseFormatCpcCandidate({
        arm: 'display',
        candidate: { ...candidate('display'), totalBudgetCents: 1 },
      }),
    ).toEqual({ valid: false, reason: 'lifetime_cap_configured' })
  })

  test('honors the daily-cap boundary and refuses unsafe configuration', () => {
    const display = candidate('display')
    expect(
      validateSupabaseFormatCpcCandidate({
        arm: 'display',
        candidate: {
          ...display,
          spentTodayCents: display.dailyCapCents - display.cpcCents,
        },
      }),
    ).toMatchObject({ valid: true })
    expect(
      validateSupabaseFormatCpcCandidate({
        arm: 'display',
        candidate: {
          ...display,
          spentTodayCents: display.dailyCapCents - display.cpcCents + 1,
        },
      }),
    ).toEqual({ valid: false, reason: 'daily_cap_exhausted' })
    expect(
      validateSupabaseFormatCpcCandidate({
        arm: 'display',
        candidate: { ...display, dailyCapCents: 12_501 },
      }),
    ).toEqual({ valid: false, reason: 'daily_cap_invalid' })
  })
})
