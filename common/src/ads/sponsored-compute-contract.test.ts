import { describe, expect, test } from 'bun:test'
import {
  SPONSORED_ACCEPT_EXECUTION_SURFACE_PARAM,
  SPONSORED_COMPUTE_RUN_WINDOW_MS,
  SPONSORED_COMPUTE_START_DEADLINE_MS,
  acceptClientSurfacePairsWithRow,
  readSponsoredComputePolicy,
  sponsoredAcceptSurfaceMatchesRow,
  sponsoredComputeAdmitsCampaign,
  sponsoredComputeRunDeadlineMs,
  type SponsoredAcceptRequest,
} from './sponsored-compute-contract'
import { SPONSORED_RUN_TOKEN_TTL_MS } from './sponsored-run-token'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '../constants/freebuff-model-ids'

const enabled = {
  FREEBUFF_SPONSORED_COMPUTE_ENABLED: 'true',
  FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS:
    '32f72345-38e9-4c53-b66d-8898c3ea7d8d',
  FREEBUFF_SPONSORED_COMPUTE_MODEL_ID: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
}

describe('the run window opens when the run starts (COD-665)', () => {
  const HOUR = 3_600_000
  const acceptedAt = 1_000_000

  test('the policy hour is the run window, and the start deadline is the run token', () => {
    expect(readSponsoredComputePolicy(enabled)!.ttlMs).toBe(
      SPONSORED_COMPUTE_RUN_WINDOW_MS,
    )
    expect(SPONSORED_COMPUTE_RUN_WINDOW_MS).toBe(HOUR)
    expect(SPONSORED_COMPUTE_START_DEADLINE_MS).toBe(SPONSORED_RUN_TOKEN_TTL_MS)
  })

  test('a late start gets its full hour from the start', () => {
    const startDeadline = acceptedAt + SPONSORED_COMPUTE_START_DEADLINE_MS
    expect(
      sponsoredComputeRunDeadlineMs(startDeadline, acceptedAt + 3 * HOUR),
    ).toBe(acceptedAt + 4 * HOUR)
  })

  test('never past the grant: a start near the deadline, or an Accept-anchored grant', () => {
    const startDeadline = acceptedAt + SPONSORED_COMPUTE_START_DEADLINE_MS
    expect(
      sponsoredComputeRunDeadlineMs(startDeadline, startDeadline - 60_000),
    ).toBe(startDeadline)
    const legacy = acceptedAt + HOUR
    expect(
      sponsoredComputeRunDeadlineMs(legacy, acceptedAt + 10 * 60_000),
    ).toBe(legacy)
  })

  test('applying it again later never extends it', () => {
    const first = sponsoredComputeRunDeadlineMs(
      acceptedAt + SPONSORED_COMPUTE_START_DEADLINE_MS,
      acceptedAt + HOUR,
    )
    expect(
      sponsoredComputeRunDeadlineMs(first, acceptedAt + HOUR + 50 * 60_000),
    ).toBe(first)
  })
})

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
      '',
      '*,' + enabled.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS,
      enabled.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS + ',*',
      '**',
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
    expect(policy.campaigns).toEqual({
      kind: 'listed',
      ids: [enabled.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS],
    })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.campaigns)).toBe(true)
  })
  test('a listed policy admits exactly its campaigns', () => {
    const policy = readSponsoredComputePolicy(enabled)!
    expect(
      sponsoredComputeAdmitsCampaign(
        policy,
        enabled.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS,
      ),
    ).toBe(true)
    expect(
      sponsoredComputeAdmitsCampaign(
        policy,
        'bc458fc3-6f78-4e7e-9754-c17f451723aa',
      ),
    ).toBe(false)
  })
  test('* admits every campaign, so review alone decides', () => {
    for (const value of ['*', ' * ']) {
      const policy = readSponsoredComputePolicy({
        ...enabled,
        FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS: value,
      })!
      expect(policy.campaigns).toEqual({ kind: 'all' })
      expect(
        sponsoredComputeAdmitsCampaign(
          policy,
          'bc458fc3-6f78-4e7e-9754-c17f451723aa',
        ),
      ).toBe(true)
      // A malformed id is still not a campaign.
      expect(sponsoredComputeAdmitsCampaign(policy, 'not-a-campaign')).toBe(
        false,
      )
    }
  })
})

describe('the funded Accept request pairs the client with the row (COD-642)', () => {
  test('the client surface and its query parameter share one name', () => {
    expect(SPONSORED_ACCEPT_EXECUTION_SURFACE_PARAM).toBe(
      'clientExecutionSurface',
    )
    const request: SponsoredAcceptRequest = {
      surface: 'desktop',
      runId: '32f72345-38e9-4c53-b66d-8898c3ea7d8d',
      procedureSha256: 'a'.repeat(64),
      clientExecutionSurface: 'desktop_windows',
    }
    expect(Object.keys(request)).toContain(
      SPONSORED_ACCEPT_EXECUTION_SURFACE_PARAM,
    )
  })

  test('a row minted for another machine is refused; an unrecorded one is not', () => {
    expect(
      sponsoredAcceptSurfaceMatchesRow('desktop_windows', 'desktop_windows'),
    ).toBe(true)
    // The case the pairing exists for: a Windows client charged for a run
    // minted for a Mac, which it cannot execute, and the reverse.
    expect(
      sponsoredAcceptSurfaceMatchesRow('desktop_windows', 'desktop_macos'),
    ).toBe(false)
    expect(
      sponsoredAcceptSurfaceMatchesRow('desktop_macos', 'desktop_windows'),
    ).toBe(false)
    expect(sponsoredAcceptSurfaceMatchesRow('desktop_linux', 'cli_linux')).toBe(
      false,
    )
    // A row from before the surface was recorded, or from Cloud, has nothing
    // to pair; the server is where that is decided.
    expect(sponsoredAcceptSurfaceMatchesRow('desktop_windows', undefined)).toBe(
      true,
    )
    expect(sponsoredAcceptSurfaceMatchesRow('desktop_windows', null)).toBe(true)
    // A client that cannot name its own surface matches nothing recorded.
    expect(sponsoredAcceptSurfaceMatchesRow(null, 'desktop_macos')).toBe(false)
  })

  test('the Accept pairing: Windows only ever takes a Windows row, and a Windows row only a Windows client', () => {
    // One rule, applied by the server route and by Desktop before consent.
    expect(
      acceptClientSurfacePairsWithRow('desktop_windows', 'desktop_windows'),
    ).toBe(true)
    // Stricter than the plain match: an unrecorded row is never Windows.
    expect(acceptClientSurfacePairsWithRow('desktop_windows', undefined)).toBe(
      false,
    )
    expect(acceptClientSurfacePairsWithRow('desktop_windows', null)).toBe(false)
    expect(
      acceptClientSurfacePairsWithRow('desktop_windows', 'desktop_macos'),
    ).toBe(false)
    // A client that sends nothing (older builds, the CLI) keeps its old rows
    // and never reaches a Windows one.
    expect(acceptClientSurfacePairsWithRow(undefined, 'desktop_macos')).toBe(
      true,
    )
    expect(acceptClientSurfacePairsWithRow(undefined, undefined)).toBe(true)
    expect(acceptClientSurfacePairsWithRow(undefined, 'desktop_windows')).toBe(
      false,
    )
    expect(acceptClientSurfacePairsWithRow('desktop_macos', undefined)).toBe(
      true,
    )
    expect(
      acceptClientSurfacePairsWithRow('desktop_macos', 'desktop_windows'),
    ).toBe(false)
  })
})
