import { describe, expect, it } from 'bun:test'

import {
  buildStatementSnapshotSql,
  computeBusyBackendRank,
  DEFAULT_BACKEND_XMIN_XID,
  DEFAULT_BUSY_BACKENDS,
  DEFAULT_STUCK_BUILD_MINUTES,
  DEFAULT_WRAPAROUND_PCT,
  evaluateBackendXmin,
  evaluateBusyBackendRank,
  evaluateInvalidIndexes,
  evaluateStatCoverage,
  isOpaqueStatementBucket,
  evaluateWraparound,
  toNumber,
  WRAPAROUND_BUDGET,
  type BackendXminRow,
  type BusyBackendRank,
  type InvalidIndexRow,
  type StatCoverageRow,
  type StatementSnapshotRow,
} from '../db-health-alerts'

const coverageRow = (over: Partial<StatCoverageRow> = {}): StatCoverageRow => ({
  role: 'manicode_user',
  has_read_all_stats: false,
  pgss_rows: 3410,
  pgss_with_text: 2010,
  activity_rows: 197,
  activity_visible: 183,
  ...over,
})

describe('evaluateStatCoverage', () => {
  // The regression this whole module exists to prevent: the alerts used to
  // treat "no pg_read_all_stats" as fatal, which is what kept them dark for a
  // month. Partial visibility must stay RUNNABLE.
  it('is usable without pg_read_all_stats and says what is degraded', () => {
    const cov = evaluateStatCoverage(coverageRow())
    expect(cov.activityBlind).toBe(false)
    expect(cov.statementsBlind).toBe(false)
    expect(cov.summary).toContain('lacks pg_read_all_stats')
    // It must NOT claim the counts are exact: statement identities are
    // redacted, and the unreadable ones are ranked as aggregate buckets.
    expect(cov.summary).toContain('aggregate buckets')
    expect(cov.summary).toContain('2010/3410')
    expect(cov.summary).toContain('183/197')
  })

  it('reports full visibility when the grant is present', () => {
    const cov = evaluateStatCoverage(
      coverageRow({ has_read_all_stats: true, pgss_with_text: 3410 }),
    )
    expect(cov.activityBlind).toBe(false)
    expect(cov.statementsBlind).toBe(false)
    expect(cov.summary).toContain('full fleet visibility')
  })

  // Each alert must be broken only by the half it reads: an absent or
  // freshly-reset pg_stat_statements must not take the health alert down.
  it('judges the two signals independently', () => {
    const noStatements = evaluateStatCoverage(coverageRow({ pgss_rows: 0 }))
    expect(noStatements.statementsBlind).toBe(true)
    expect(noStatements.activityBlind).toBe(false)

    const noBackends = evaluateStatCoverage(coverageRow({ activity_visible: 0 }))
    expect(noBackends.activityBlind).toBe(true)
    expect(noBackends.statementsBlind).toBe(false)
  })
})

describe('toNumber', () => {
  it('coerces numeric strings and numbers', () => {
    expect(toNumber('123')).toBe(123)
    expect(toNumber(123)).toBe(123)
    expect(toNumber('0')).toBe(0)
    expect(toNumber(0)).toBe(0)
  })

  it('returns null for null, undefined, empty and non-numeric input', () => {
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
    expect(toNumber('')).toBeNull()
    expect(toNumber('abc')).toBeNull()
    expect(toNumber(Number.NaN)).toBeNull()
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('evaluateWraparound', () => {
  it('breaches at the configured fraction of the 2^31 budget', () => {
    // 50% of 2^31 is exactly 2^30.
    const threshold = Math.floor(WRAPAROUND_BUDGET * DEFAULT_WRAPAROUND_PCT)
    expect(evaluateWraparound(threshold)).toBe(true)
    expect(evaluateWraparound(threshold - 1)).toBe(false)
  })

  it('honors a custom fraction', () => {
    expect(evaluateWraparound(200_000_000, 0.1)).toBe(false) // 10% of 2^31 ≈ 214.7M
    expect(evaluateWraparound(215_000_000, 0.1)).toBe(true)
  })

  it('never breaches without a measured age', () => {
    expect(evaluateWraparound(null)).toBe(false)
  })
})

const xminRow = (over: Partial<BackendXminRow> = {}): BackendXminRow => ({
  oldest_xmin_age: 1,
  snapshot_holders: 1,
  visible_backends: 183,
  opaque_backends: 14,
  ...over,
})

describe('evaluateBackendXmin', () => {
  it('breaches at the threshold, inclusive', () => {
    expect(
      evaluateBackendXmin(xminRow({ oldest_xmin_age: DEFAULT_BACKEND_XMIN_XID }))
        .breach,
    ).toBe(true)
    expect(
      evaluateBackendXmin(
        xminRow({ oldest_xmin_age: DEFAULT_BACKEND_XMIN_XID - 1 }),
      ).breach,
    ).toBe(false)
  })

  it('never breaches with no snapshot held', () => {
    expect(
      evaluateBackendXmin(xminRow({ oldest_xmin_age: null })).breach,
    ).toBe(false)
    expect(evaluateBackendXmin(null).breach).toBe(false)
  })

  // A null age means either "nothing holds a snapshot" or "every holder is
  // invisible to us". The 2026-08-03 holders were manicode_scripts sessions,
  // so the count has to reach the reader either way.
  it('always reports how many backends it could not see', () => {
    const blind = evaluateBackendXmin(
      xminRow({ oldest_xmin_age: null, snapshot_holders: 0 }),
    )
    expect(blind.text).toContain('14 backend(s) opaque')

    const breaching = evaluateBackendXmin(
      xminRow({ oldest_xmin_age: 1_137_687 }),
    )
    expect(breaching.breach).toBe(true)
    expect(breaching.text).toContain('1137687 transactions behind')
    expect(breaching.text).toContain('14 backend(s) opaque')
  })

  it('omits the blind-spot clause when nothing is opaque', () => {
    const full = evaluateBackendXmin(xminRow({ opaque_backends: 0 }))
    expect(full.text).not.toContain('opaque')
  })
})

describe('evaluateInvalidIndexes', () => {
  const row = (over: Partial<InvalidIndexRow>): InvalidIndexRow => ({
    schema: 'public',
    table_name: 'messages',
    index_name: 'messages_created_at_idx',
    indisready: true,
    build_phase: null,
    build_seconds: null,
    ...over,
  })

  it('breaches on a permanently-invalid index', () => {
    const { breach, offenders } = evaluateInvalidIndexes([row({})])
    expect(breach).toBe(true)
    expect(offenders[0]).toContain('public.messages.messages_created_at_idx')
    expect(offenders[0]).toContain('not building')
  })

  it('does not breach on a fresh in-flight build', () => {
    const { breach } = evaluateInvalidIndexes([
      row({ build_phase: 'building index', build_seconds: 60 }),
    ])
    expect(breach).toBe(false)
  })

  it('breaches on a build stuck past the threshold', () => {
    const { breach, offenders } = evaluateInvalidIndexes([
      row({
        build_phase: 'building index',
        build_seconds: DEFAULT_STUCK_BUILD_MINUTES * 60 + 1,
      }),
    ])
    expect(breach).toBe(true)
    expect(offenders[0]).toContain('building 30m')
  })

  it('reports but does not page a build whose age is hidden (no pg_read_all_stats)', () => {
    const { breach } = evaluateInvalidIndexes([
      row({ build_phase: 'building index', build_seconds: null }),
    ])
    expect(breach).toBe(false)
  })

  it('is empty-safe', () => {
    expect(evaluateInvalidIndexes([])).toEqual({ breach: false, offenders: [] })
  })
})

describe('computeBusyBackendRank', () => {
  const snap = (
    rows: Array<Partial<StatementSnapshotRow>>,
  ): StatementSnapshotRow[] =>
    rows.map((r) => ({
      queryid: r.queryid!,
      calls: r.calls ?? 0,
      total_exec_time: r.total_exec_time ?? 0,
      query: r.query ?? '',
    }))

  it('computes busy-backend equivalents from the delta over the window', () => {
    const before = snap([
      { queryid: '1', calls: 100, total_exec_time: 10_000, query: 'SELECT 1' },
    ])
    const after = snap([
      { queryid: '1', calls: 200, total_exec_time: 60_000, query: 'SELECT 1' },
    ])
    const rank = computeBusyBackendRank(before, after, 60)
    expect(rank).toHaveLength(1)
    // 50,000ms delta / 1000 / 60s = 0.833 busy-backend equivalents.
    expect(rank[0].busy).toBeCloseTo(0.833, 3)
    expect(rank[0].calls).toBe(100)
    expect(rank[0].meanMs).toBeCloseTo(500, 3)
  })

  it('counts a query first seen in the after snapshot from zero', () => {
    const before = snap([])
    const after = snap([
      { queryid: '2', calls: 10, total_exec_time: 5_000, query: 'SELECT 2' },
    ])
    const rank = computeBusyBackendRank(before, after, 50)
    expect(rank).toHaveLength(1)
    expect(rank[0].busy).toBeCloseTo(5_000 / 1000 / 50, 3)
  })

  it('drops queries that vanished between snapshots', () => {
    const before = snap([
      { queryid: '3', calls: 5, total_exec_time: 5_000, query: 'x' },
    ])
    const after = snap([])
    expect(computeBusyBackendRank(before, after, 60)).toEqual([])
  })

  it('skips rows with no activity in the window', () => {
    const before = snap([
      { queryid: '4', calls: 50, total_exec_time: 5_000, query: 'x' },
    ])
    const after = snap([
      { queryid: '4', calls: 50, total_exec_time: 5_000, query: 'x' },
    ])
    expect(computeBusyBackendRank(before, after, 60)).toEqual([])
  })

  it('sorts by busy descending', () => {
    const before = snap([])
    const after = snap([
      { queryid: 'a', calls: 1, total_exec_time: 2_000, query: 'a' },
      { queryid: 'b', calls: 1, total_exec_time: 9_000, query: 'b' },
    ])
    const rank = computeBusyBackendRank(before, after, 10)
    expect(rank.map((r) => r.query)).toEqual(['b', 'a'])
  })

  it('returns an empty rank for a non-positive wall window (never Infinity)', () => {
    const before = snap([])
    const after = snap([
      { queryid: 'x', calls: 1, total_exec_time: 100, query: 'x' },
    ])
    expect(computeBusyBackendRank(before, after, 0)).toEqual([])
    expect(computeBusyBackendRank(before, after, -5)).toEqual([])
  })

  it('is empty-safe', () => {
    expect(computeBusyBackendRank([], [], 60)).toEqual([])
  })
})

describe('opaque statement buckets', () => {
  // The bug this guards: `queryid` is redacted in lockstep with `query`, so a
  // rank that requires a queryid sees only the connecting role's statements —
  // measured at 0.98% of production execution time — while still reporting
  // "no single query reached N busy-backend equivalents".
  it('recognises a bucket key and nothing else', () => {
    expect(isOpaqueStatementBucket('opaque:16385')).toBe(true)
    expect(isOpaqueStatementBucket('3968477124571382750')).toBe(false)
    expect(isOpaqueStatementBucket(null)).toBe(false)
  })

  // The emitted SQL is a template literal, so `\s` there is a NonEscapeCharacter that
  // collapses to plain `s` — shipping `regexp_replace(query, 's+', ...)`, which
  // strips runs of the letter s and never collapses whitespace. Nothing else in
  // the suite reads the SQL, so only this catches it.
  it('emits a whitespace regex, not a letter-s regex', () => {
    const sql = buildStatementSnapshotSql()
    expect(sql).toContain("'\\s+'")
    expect(sql).not.toContain("'s+'")
  })

  it('skips a bucket it has never seen, rather than ranking its whole history', () => {
    const after: StatementSnapshotRow[] = [
      { queryid: 'opaque:16385', calls: 9_999, total_exec_time: 1_089_687_000, query: '<first sighting>' },
    ]
    // Absent from `before`: treated as cumulative zero, this would rank ~36,000
    // busy backends off one 30s window and page immediately.
    expect(computeBusyBackendRank([], after, 30)).toEqual([])
  })

  it('ranks a bucket by its delta, alongside identifiable queries', () => {
    const before: StatementSnapshotRow[] = [
      { queryid: 'opaque:16385', calls: 1_000, total_exec_time: 500_000, query: '<2307 statement(s) of role manicode_user, not readable as manicode_app>' },
      { queryid: '42', calls: 10, total_exec_time: 1_000, query: 'SELECT 1' },
    ]
    const after: StatementSnapshotRow[] = [
      { queryid: 'opaque:16385', calls: 1_600, total_exec_time: 800_000, query: '<2307 statement(s) of role manicode_user, not readable as manicode_app>' },
      { queryid: '42', calls: 20, total_exec_time: 3_000, query: 'SELECT 1' },
    ]
    const rank = computeBusyBackendRank(before, after, 60)

    // 300,000ms over 60s = 5 busy backends, which must out-rank the 0.033 the
    // identifiable query moved.
    expect(rank[0]?.queryid).toBe('opaque:16385')
    expect(rank[0]?.busy).toBeCloseTo(5, 5)
    expect(rank[1]?.queryid).toBe('42')
  })

  // A large CUMULATIVE bucket must not page on its own: production's two
  // buckets held 1,089,687 exec-seconds of frozen history and moved nothing.
  it('ignores a large bucket that is not currently accruing', () => {
    const row = (t: number): StatementSnapshotRow[] => [
      { queryid: 'opaque:16385', calls: 5, total_exec_time: t, query: '<frozen>' },
    ]
    expect(computeBusyBackendRank(row(1_089_687_000), row(1_089_687_000), 30)).toEqual([])
  })
})

describe('evaluateBusyBackendRank', () => {
  const top = (busy: number): BusyBackendRank => ({
    busy,
    calls: 1,
    meanMs: 10,
    query: 'SELECT 1',
    queryid: '123',
  })

  it('breaches when the top query holds at least the threshold', () => {
    expect(evaluateBusyBackendRank([top(DEFAULT_BUSY_BACKENDS)]).breach).toBe(
      true,
    )
    expect(
      evaluateBusyBackendRank([top(DEFAULT_BUSY_BACKENDS - 0.01)]).breach,
    ).toBe(false)
  })

  it('returns the top offender', () => {
    const { top: offender } = evaluateBusyBackendRank([top(9.65)])
    expect(offender?.busy).toBe(9.65)
  })

  it('never breaches an empty rank', () => {
    expect(evaluateBusyBackendRank([])).toEqual({ breach: false, top: null })
  })
})

describe('evaluateStatCoverage percentage formatting', () => {
  it('handles zero whole gracefully', () => {
    const cov = evaluateStatCoverage(
      coverageRow({ pgss_rows: 0, pgss_with_text: 0 }),
    )
    expect(cov.summary).toContain('0/0')
    expect(cov.summary).toContain('0%')
  })

  it('formats normal percentages correctly', () => {
    const cov = evaluateStatCoverage(
      coverageRow({ pgss_rows: 200, pgss_with_text: 50 }),
    )
    expect(cov.summary).toContain('25%')
  })

  it('rounds percentages correctly', () => {
    const cov = evaluateStatCoverage(
      coverageRow({ pgss_rows: 300, pgss_with_text: 100 }),
    )
    expect(cov.summary).toContain('33%')
  })

  it('handles 100% correctly', () => {
    const cov = evaluateStatCoverage(
      coverageRow({ pgss_rows: 100, pgss_with_text: 100 }),
    )
    expect(cov.summary).toContain('100%')
  })
})
