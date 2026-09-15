import { describe, expect, test } from 'bun:test'
import {
  SUPABASE_AGENTIC_PILOT_VERSION,
  SUPABASE_FORMAT_EXPERIMENT_VERSION,
  SUPABASE_FORMAT_DATABASE_PAIR,
  supabaseDeliveryVersionMatches,
  aggregateSupabaseFormatExperiment,
} from './supabase-format-experiment'

describe('Supabase pilot protocol boundary', () => {
  test('admits pilot reservations only for the canonical agentic campaign', () => {
    const pilot = {
      experimentVersion: SUPABASE_AGENTIC_PILOT_VERSION,
      campaignId: SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
      arm: 'agentic' as const,
    }
    expect(supabaseDeliveryVersionMatches(pilot)).toBe(true)
    expect(supabaseDeliveryVersionMatches({ ...pilot, arm: 'display' })).toBe(
      false,
    )
    expect(
      supabaseDeliveryVersionMatches({
        ...pilot,
        campaignId: 'other-campaign',
      }),
    ).toBe(false)
    expect(
      supabaseDeliveryVersionMatches({
        ...pilot,
        experimentVersion: 'unknown',
      }),
    ).toBe(false)
    expect(
      supabaseDeliveryVersionMatches({
        ...pilot,
        experimentVersion: SUPABASE_FORMAT_EXPERIMENT_VERSION,
      }),
    ).toBe(true)
  })

  test('never counts single-arm pilot events in the randomized v1 analysis', () => {
    const report = aggregateSupabaseFormatExperiment([
      {
        type: 'eligible',
        experimentVersion: SUPABASE_AGENTIC_PILOT_VERSION,
        eventId: 'pilot-event',
        occurredAt: '2026-09-15T00:00:00Z',
        userId: 'user-1',
        arm: 'agentic',
        angle: 'database',
        surface: 'desktop_macos',
        decisionId: 'decision',
        policyVersion: 'policy',
        procedureHash: 'hash',
      },
    ])
    expect(report.byArm.agentic.eligibleUsers).toBe(0)
    expect(report.rejected.malformed).toBe(1)
  })
})
