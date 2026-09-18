/**
 * Advertiser/admin coverage of sponsored verification (COD-597).
 *
 * Distinct accepted runs by latest verdict. Test traffic is excluded from
 * live totals. Historical no-criteria rows stay visible as not verifiable.
 * This never bills.
 */

export type VerificationRollupRow = {
  proposalId: string
  campaignId?: string | null
  latestVerdict: string
  latestUserFacing: string
  sequence: number
  contractSha256?: string | null
  stale: boolean
  test: boolean
}

export type VerificationCoverage = {
  acceptedRuns: number
  liveRuns: number
  success: number
  failed: number
  pending: number
  inconclusive: number
  setupNeeded: number
  codeReady: number
  noCriteria: number
  stale: number
}

export function summarizeVerificationCoverage(
  rows: readonly VerificationRollupRow[],
): VerificationCoverage {
  const live = rows.filter((row) => !row.test)
  const count = (predicate: (row: VerificationRollupRow) => boolean) =>
    live.filter(predicate).length
  return {
    acceptedRuns: rows.length,
    liveRuns: live.length,
    success: count((row) => row.latestUserFacing === 'success' && !row.stale),
    failed: count((row) => row.latestUserFacing === 'failed'),
    pending: count((row) => row.latestUserFacing === 'pending'),
    inconclusive: count(
      (row) =>
        row.latestUserFacing === 'couldnt_verify' && Boolean(row.contractSha256),
    ),
    setupNeeded: count((row) => row.latestUserFacing === 'setup_needed'),
    codeReady: count((row) => row.latestUserFacing === 'code_ready'),
    noCriteria: count(
      (row) =>
        row.latestUserFacing === 'couldnt_verify' && !row.contractSha256,
    ),
    stale: count((row) => row.stale),
  }
}
