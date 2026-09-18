import { describe, expect, test } from 'bun:test'

import { summarizeVerificationCoverage } from './sponsored-verification-reporting'

describe('summarizeVerificationCoverage', () => {
  test('excludes test traffic from live totals', () => {
    const summary = summarizeVerificationCoverage([
      {
        proposalId: 'p1',
        latestVerdict: 'success',
        latestUserFacing: 'success',
        sequence: 1,
        contractSha256: 'abc',
        stale: false,
        test: false,
      },
      {
        proposalId: 'p2',
        latestVerdict: 'success',
        latestUserFacing: 'success',
        sequence: 1,
        contractSha256: 'abc',
        stale: false,
        test: true,
      },
    ])
    expect(summary.acceptedRuns).toBe(2)
    expect(summary.liveRuns).toBe(1)
    expect(summary.success).toBe(1)
  })

  test('keeps no-criteria coverage distinct from inconclusive', () => {
    const summary = summarizeVerificationCoverage([
      {
        proposalId: 'legacy',
        latestVerdict: 'inconclusive',
        latestUserFacing: 'couldnt_verify',
        sequence: 1,
        contractSha256: null,
        stale: false,
        test: false,
      },
      {
        proposalId: 'timeout',
        latestVerdict: 'inconclusive',
        latestUserFacing: 'couldnt_verify',
        sequence: 1,
        contractSha256: 'abc',
        stale: false,
        test: false,
      },
    ])
    expect(summary.noCriteria).toBe(1)
    expect(summary.inconclusive).toBe(1)
  })
})
