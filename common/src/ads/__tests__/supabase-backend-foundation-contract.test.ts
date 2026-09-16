import { describe, expect, test } from 'bun:test'
import {
  SUPABASE_BACKEND_FOUNDATION_VERSION,
  SUPABASE_FOUNDATION_VERSION,
  SUPABASE_FORMAT_DATABASE_PAIR,
  SUPABASE_FORMAT_FOUNDATION_PAIR,
  SUPABASE_FORMAT_BACKEND_FOUNDATION_PAIR,
  supabaseFormatPairs,
  supabaseFormatPairForCampaignId,
  supabasePairForDeliveryVersion,
  supabaseDeliverySurfaceMatches,
  supabaseDeliveryVersionMatches,
} from '../supabase-format-experiment'

describe('one campaign backend foundation contract', () => {
  test.each(['database', 'auth', 'storage'] as const)(
    '%s uses the same campaign, reviewed procedure and consent',
    (angle) => {
      const pairs = supabaseFormatPairs({
        FREEBUFF_SUPABASE_FORMAT_DELIVERY: 'foundation-backend-desktop',
      })
      const pair = pairs[angle]!
      expect(pair.angle).toBe(angle)
      expect(pair.agenticCampaignId).toBe(
        SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
      )
      expect(pair.procedureSha256).toBe(
        SUPABASE_FORMAT_BACKEND_FOUNDATION_PAIR.procedureSha256,
      )
      expect(pair.consentSummary).toBe(
        SUPABASE_FORMAT_BACKEND_FOUNDATION_PAIR.consentSummary,
      )
      expect(
        supabaseFormatPairForCampaignId(pairs, pair.agenticCampaignId, angle)
          ?.pair,
      ).toBe(pair)
    },
  )
  test('old foundation offers retain their exact identity after a mode switch', () => {
    expect(
      supabasePairForDeliveryVersion(
        SUPABASE_FORMAT_BACKEND_FOUNDATION_PAIR,
        SUPABASE_FOUNDATION_VERSION,
      ),
    ).toEqual(SUPABASE_FORMAT_FOUNDATION_PAIR)
    expect(
      supabasePairForDeliveryVersion(
        SUPABASE_FORMAT_DATABASE_PAIR,
        SUPABASE_BACKEND_FOUNDATION_VERSION,
      ),
    ).toEqual(SUPABASE_FORMAT_BACKEND_FOUNDATION_PAIR)
  })
  test('new protocol is restricted to local Desktop and the existing funded campaign', () => {
    for (const surface of ['desktop_macos', 'desktop_linux'])
      expect(
        supabaseDeliverySurfaceMatches(
          SUPABASE_BACKEND_FOUNDATION_VERSION,
          surface,
        ),
      ).toBe(true)
    for (const surface of [
      'desktop_windows',
      'cli_linux',
      'cli_wsl',
      'cloud',
      'web',
    ])
      expect(
        supabaseDeliverySurfaceMatches(
          SUPABASE_BACKEND_FOUNDATION_VERSION,
          surface,
        ),
      ).toBe(false)
    const base = {
      experimentVersion: SUPABASE_BACKEND_FOUNDATION_VERSION,
      campaignId: SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
      arm: 'agentic' as const,
    }
    expect(supabaseDeliveryVersionMatches(base)).toBe(true)
    expect(supabaseDeliveryVersionMatches({ ...base, arm: 'display' })).toBe(
      false,
    )
    expect(
      supabaseDeliveryVersionMatches({ ...base, campaignId: 'other' }),
    ).toBe(false)
  })
  test('existing modes do not silently enable backend intents', () => {
    const pairs = supabaseFormatPairs({
      FREEBUFF_SUPABASE_FORMAT_DELIVERY: 'foundation-desktop',
    })
    expect(pairs.database).toEqual(SUPABASE_FORMAT_FOUNDATION_PAIR)
    expect(pairs.auth).toBeNull()
    expect(pairs.storage).toBeUndefined()
  })
})
