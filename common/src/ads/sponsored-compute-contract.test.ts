import { describe, expect, test } from 'bun:test'
import { readSponsoredComputePolicy } from './sponsored-compute-contract'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '../constants/freebuff-model-ids'

const enabled = {
  FREEBUFF_SPONSORED_COMPUTE_ENABLED: 'true',
  FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS:
    '32f72345-38e9-4c53-b66d-8898c3ea7d8d',
  FREEBUFF_SPONSORED_COMPUTE_MODEL_ID: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
}

describe('sponsored compute admission policy', () => {
  test('missing configuration never enables sponsored execution', () => {
    expect(readSponsoredComputePolicy({})).toBeNull()
    for (const key of Object.keys(enabled)) {
      expect(
        readSponsoredComputePolicy({ ...enabled, [key]: undefined }),
      ).toBeNull()
    }
    expect(
      readSponsoredComputePolicy({
        ...enabled,
        FREEBUFF_SPONSORED_COMPUTE_ENABLED: '1',
      }),
    ).toBeNull()
    expect(
      readSponsoredComputePolicy({
        ...enabled,
        FREEBUFF_SPONSORED_COMPUTE_MODEL_ID: 'unsupported/model',
      }),
    ).toBeNull()
  })
  test('invalid allowlists are refused as a whole', () => {
    for (const ids of [
      '*',
      '',
      enabled.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS + ',',
      'not-a-campaign',
    ]) {
      expect(
        readSponsoredComputePolicy({
          ...enabled,
          FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS: ids,
        }),
      ).toBeNull()
    }
  })
  test('configures a $1 Accept without changing the compute allowance', () => {
    expect(
      readSponsoredComputePolicy({
        ...enabled,
        FREEBUFF_SPONSORED_COMPUTE_ACCEPTANCE_PRICE_CENTS: '100',
      }),
    ).toMatchObject({ acceptancePriceCents: 100, allowanceUsdMicros: 500_000 })
    for (const price of [
      '',
      '0',
      '-1',
      '1.5',
      '100x',
      '1e2',
      '9007199254740992',
    ]) {
      expect(
        readSponsoredComputePolicy({
          ...enabled,
          FREEBUFF_SPONSORED_COMPUTE_ACCEPTANCE_PRICE_CENTS: price,
        }),
      ).toBeNull()
    }
  })
  test('admitted policy fixes the commercial fee and bounds internal compute', () => {
    const policy = readSponsoredComputePolicy(enabled)!
    expect(policy.acceptancePriceCents).toBe(200)
    expect(policy.allowanceUsdMicros).toBe(500_000)
    expect(policy.ttlMs).toBe(3_600_000)
    expect(policy.campaignIds).toEqual([
      enabled.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS,
    ])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.campaignIds)).toBe(true)
  })
})
