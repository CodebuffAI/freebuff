/**
 * Shared SQL + threshold logic for the production database health alerts
 * (docs/db-capacity-and-scaling.md §7 rec #3 and #4).
 *
 * The queries are plain SQL strings (not drizzle fragments) so this module
 * stays dependency-free; the alert scripts wrap them with `sql.raw(...)`.
 * Threshold defaults are grounded in the capacity doc's measured numbers:
 *
 *   - Wraparound: the doc measured `xid_age` 199.6M = 9.98% of the 2^31 budget
 *     and called it "not urgent". DEFAULT_WRAPAROUND_PCT (50%) pages with
 *     roughly a year of runway at today's growth, and is the standard
 *     conservative wraparound bar.
 *   - backend_xmin: the 2026-08-03 incident's long-lived snapshots were
 *     1,137,687 transactions behind (normal is ~1); DEFAULT_BACKEND_XMIN_XID
 *     (1M) sits just under that severity while far above any ordinary backend.
 *   - Invalid index: the incident's `CREATE INDEX CONCURRENTLY` was stuck for
 *     72 minutes; DEFAULT_STUCK_BUILD_MINUTES (30) is far above any normal
 *     build while catching a stuck one.
 *   - Busy-backend equivalents: the incident query held 9.65 backends (59% of
 *     all DB execution); current total fleet load is ~4.0 (§5.5).
 *     DEFAULT_BUSY_BACKENDS (4) pages when ONE query owns as much as the
 *     entire fleet currently uses.
 *
 * PRIVILEGES ARE A COVERAGE DIAL, NOT A PRECONDITION. These alerts previously
 * refused to run without `pg_read_all_stats` and were dark for a month as a
 * result. See `evaluateStatCoverage` for what each role can actually read and
 * why the grant is not obtainable from application credentials.
 */

export const WRAPAROUND_BUDGET = 2 ** 31
export const DEFAULT_WRAPAROUND_PCT = 0.5
export const DEFAULT_BACKEND_XMIN_XID = 1_000_000
export const DEFAULT_STUCK_BUILD_MINUTES = 30
export const DEFAULT_BUSY_BACKENDS = 4
export const DEFAULT_SAMPLE_SECONDS = 60

export interface WraparoundRow {
  xid_age: string | number
}
export interface BackendXminRow {
  oldest_xmin_age: string | number | null
  /** Backends currently holding a snapshot we can see. */
  snapshot_holders: string | number
  /** Backends whose columns this role may read (its own, or all with the grant). */
  visible_backends: string | number
  /** Backends present as a row but fully NULL — another role's sessions. */
  opaque_backends: string | number
}
export interface InvalidIndexRow {
  schema: string
  table_name: string
  index_name: string
  indisready: boolean
  /** Non-null while a CREATE INDEX / REINDEX is actively running. */
  build_phase: string | null
  /** Seconds the build has run; null when not visible (no pg_read_all_stats). */
  build_seconds: string | number | null
}
export interface StatementSnapshotRow {
  queryid: string | null
  calls: string | number
  total_exec_time: string | number
  query: string
}
export interface BusyBackendRank {
  /** delta total_exec_time (ms) / 1000 / wall seconds. */
  busy: number
  calls: number
  meanMs: number
  query: string
  /** `opaque:<userid>` for an aggregate bucket; see `isOpaqueStatementBucket`. */
  queryid: string | null
}

/** The database's transaction-id age, as a fraction of the wraparound budget. */
export function buildWraparoundSql(): string {
  return `
    SELECT age(datfrozenxid)::bigint AS xid_age
    FROM pg_database
    WHERE datname = current_database()
  `
}

/**
 * The oldest held snapshot, in transactions, PLUS how much of
 * `pg_stat_activity` the connecting role could actually read.
 *
 * The `WHERE backend_type = 'client backend'` filter this query used to carry
 * is what made the alert dangerous. Without `pg_read_all_stats` a role still
 * sees one ROW per backend, but every column of another role's session is
 * NULL — so that predicate silently discarded exactly the sessions it was
 * meant to police and the alert read "all clear" against an empty set. Keeping
 * the opaque rows and counting them is what turns invisibility into a number
 * the caller can report (see `evaluateBackendXmin`).
 */
export function buildBackendXminSql(): string {
  return `
    SELECT
      max(age(backend_xmin))::bigint                              AS oldest_xmin_age,
      count(*) FILTER (WHERE backend_xmin IS NOT NULL)::bigint    AS snapshot_holders,
      count(*) FILTER (WHERE backend_type IS NOT NULL)::bigint    AS visible_backends,
      count(*) FILTER (WHERE backend_type IS NULL)::bigint        AS opaque_backends
    FROM pg_stat_activity
  `
}

/**
 * User indexes with `indisvalid = false`, joined to build progress so a
 * legitimate in-flight CREATE INDEX CONCURRENTLY is distinguishable from a
 * permanently broken index.
 */
export function buildInvalidIndexesSql(): string {
  return `
    SELECT
      n.nspname                                          AS schema,
      c.relname                                          AS table_name,
      i.relname                                          AS index_name,
      ix.indisready,
      p.phase                                            AS build_phase,
      extract(epoch FROM (now() - a.query_start))        AS build_seconds
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_progress_create_index p ON p.index_relid = ix.indexrelid
    LEFT JOIN pg_stat_activity a ON a.pid = p.pid
    WHERE ix.indisvalid = false
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname, i.relname
  `
}

/**
 * One pg_stat_statements snapshot for the current database.
 *
 * TWO SHAPES OF ROW, AND THE SECOND IS THE WHOLE POINT. Without
 * `pg_read_all_stats`, `queryid` is redacted **in lockstep with `query`** — not
 * just the text. Measured on production 2026-08-19 as `manicode_app`: of 4,694
 * rows, 3,854 had redacted text and *exactly those* 3,854 had a NULL `queryid`,
 * with zero exceptions. An earlier version of this query filtered
 * `WHERE queryid IS NOT NULL`, which therefore dropped every other role's
 * statements — leaving the rank able to see **0.98% of execution time** while
 * still answering "no single query reached N busy-backend equivalents". That is
 * precisely the silent all-clear this watchdog exists to prevent.
 *
 * What survives redaction is the part that matters: `userid`, `calls` and
 * `total_exec_time` are all readable. So the unreadable rows are folded into
 * one bucket per owning role, keyed `opaque:<userid>` so the key is stable
 * across the two snapshots and the delta still works. The bucket cannot name a
 * query, but it answers the question the alert is really asking — is something
 * this role cannot see consuming the database?
 *
 * Buckets are safe to rank alongside real queries because the metric is a
 * DELTA: on production the two opaque buckets held 1,089,687 cumulative
 * exec-seconds and yet moved 0.000 busy-backend equivalents over a 30s window,
 * because that total is frozen history from a previous app role. They surface
 * when something is actually running, not merely because they are large.
 */
export function buildStatementSnapshotSql(): string {
  return `
    SELECT
      s.queryid::text                           AS queryid,
      s.calls::bigint                           AS calls,
      s.total_exec_time::double precision       AS total_exec_time,
      left(regexp_replace(s.query, '\\s+', ' ', 'g'), 200) AS query
    FROM pg_stat_statements s
    JOIN pg_database d ON d.oid = s.dbid AND d.datname = current_database()
    WHERE s.queryid IS NOT NULL
    UNION ALL
    SELECT
      'opaque:' || s.userid::text,
      sum(s.calls)::bigint,
      sum(s.total_exec_time)::double precision,
      '<' || count(*)::text || ' statement(s) of role ' ||
        coalesce(
          (SELECT r.rolname FROM pg_roles r WHERE r.oid = s.userid),
          s.userid::text
        ) ||
        ', not readable as ' || current_user || '>'
    FROM pg_stat_statements s
    JOIN pg_database d ON d.oid = s.dbid AND d.datname = current_database()
    WHERE s.queryid IS NULL
    GROUP BY s.userid
  `
}

/** True for the aggregate rows `buildStatementSnapshotSql` synthesises. */
export function isOpaqueStatementBucket(queryid: string | null): boolean {
  return typeof queryid === 'string' && queryid.startsWith('opaque:')
}

export interface StatCoverageRow {
  role: string
  has_read_all_stats: boolean
  pgss_rows: string | number
  pgss_with_text: string | number
  activity_rows: string | number
  activity_visible: string | number
}

export interface StatCoverage {
  role: string
  /**
   * No readable backend in pg_stat_activity — the snapshot signal is blind.
   * Only the health alert reads this.
   */
  activityBlind: boolean
  /**
   * No pg_stat_statements rows at all — the busy-backend rank is blind. Only
   * that alert reads this, so a reset or absent extension cannot take the
   * health alert down with it.
   */
  statementsBlind: boolean
  /** Human-readable one-liner for the run log and any page; carries the counts. */
  summary: string
}

/**
 * How much of the stats views the connecting role can actually read.
 *
 * WHY THIS REPLACED A BOOLEAN GATE. Both DB alerts used to probe
 * `pg_has_role(..., 'pg_read_all_stats', ...)` and report BROKEN when it was
 * false, on the stated premise that "pg_stat_statements shows only the role's
 * OWN statements". **That premise is wrong**, and it kept both monitors dark
 * for a month while the grant sat unprovisioned. Measured against production
 * on 2026-08-18 without the grant:
 *
 *   as manicode_scripts   3,403 pgss rows visible, 1,333 with text
 *   as manicode_user      3,410 pgss rows visible, 2,010 with text (94.5% of
 *                         all execution time), 183 of 197 backends readable
 *
 * pg_stat_statements exposes every row to every role; only the `query` TEXT of
 * another role's statements is replaced with `<insufficient privilege>`. Since
 * the busy-backend rank is computed from `total_exec_time` deltas, it is exact
 * without the grant — only attribution is degraded. `pg_stat_activity` is the
 * genuinely restricted one, and there the app role sees every app backend.
 *
 * So the grant is a nice-to-have, not a precondition, and BROKEN is reserved
 * for the states where the numbers really are uncomputable: no statement rows
 * at all (extension missing or wrong database) or no readable backend.
 *
 * The grant itself is NOT obtainable with our credentials — verified on
 * production: `GRANT pg_read_all_stats TO manicode_scripts` fails with
 * "Only roles with the ADMIN option on role pg_read_all_stats may grant this
 * role", and neither `manicode_user` nor `manicode_scripts` holds it
 * (`pg_monitor` is granted only to Render's `datadog` role). Closing the
 * remaining gap needs a Render support request, so nothing here may depend on
 * it.
 */
export function buildActivityCoverageSql(): string {
  return `
    SELECT
      current_user::text                                                AS role,
      pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')            AS has_read_all_stats,
      (SELECT count(*) FROM pg_stat_activity)::bigint                    AS activity_rows,
      (SELECT count(*) FROM pg_stat_activity WHERE backend_type IS NOT NULL)::bigint
                                                                        AS activity_visible
  `
}

/**
 * Split from the activity counts on purpose: SQL resolves relations at parse
 * time, so one statement mentioning `pg_stat_statements` fails outright when
 * the extension is absent. Kept separate, the caller can let this one fail and
 * still answer the wraparound, snapshot and invalid-index questions — which is
 * what stops a missing extension taking BOTH alerts down.
 */
export function buildStatementCoverageSql(): string {
  return `
    SELECT
      count(*)::bigint                                                   AS pgss_rows,
      count(*) FILTER (WHERE s.query <> '<insufficient privilege>')::bigint
                                                                        AS pgss_with_text
    FROM pg_stat_statements s
    JOIN pg_database d ON d.oid = s.dbid AND d.datname = current_database()
  `
}

/**
 * Turn a coverage row into a verdict plus the sentence both alerts print, so
 * the two describe the same limitation identically.
 */
export function evaluateStatCoverage(row: StatCoverageRow): StatCoverage {
  const statementRows = toNumber(row.pgss_rows) ?? 0
  const statementsWithText = toNumber(row.pgss_with_text) ?? 0
  const activityRows = toNumber(row.activity_rows) ?? 0
  const activityVisible = toNumber(row.activity_visible) ?? 0
  // Judged separately because the two alerts read different halves. Zero
  // statement rows means pg_stat_statements is absent, reset, or we are on the
  // wrong database, and the rank would be a confident "all clear" over an empty
  // set; zero readable backends means the same for the snapshot signal. Neither
  // may break the alert that does not consult it.
  const statementsBlind = statementRows === 0
  const activityBlind = activityVisible === 0
  const pct = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 100) : 0
  const summary = row.has_read_all_stats
    ? `role ${row.role} has pg_read_all_stats: full fleet visibility`
    : `role ${row.role} lacks pg_read_all_stats — ${statementsWithText}/${statementRows} ` +
      `statement identities readable (${pct(statementsWithText, statementRows)}%; the rest ` +
      `are ranked as per-role aggregate buckets), ${activityVisible}/${activityRows} ` +
      `backends readable (${pct(activityVisible, activityRows)}%). ` +
      `The grant needs Render support; it is not grantable by manicode_user.`
  return { role: row.role, activityBlind, statementsBlind, summary }
}

/** Coerce a Postgres-returned number-or-string (or null/undefined) to number. */
export function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Breach when the database's xid age is at least `pct` of the 2^31 budget. */
export function evaluateWraparound(
  xidAge: number | null,
  pct = DEFAULT_WRAPAROUND_PCT,
): boolean {
  return xidAge !== null && xidAge >= WRAPAROUND_BUDGET * pct
}

export interface BackendXminVerdict {
  breach: boolean
  /** Carries the age, the holder counts, and the unreadable-backend count. */
  text: string
}

/**
 * Breach when the oldest held snapshot is >= `threshold` transactions behind.
 *
 * The verdict carries `opaqueBackends` because a null `oldestXminAge` is
 * ambiguous: it means either "nothing is holding a snapshot" (healthy) or
 * "every holder belongs to a role we cannot read" (blind). The 2026-08-03
 * incident was the second case — the snapshots 1,137,687 transactions behind
 * belonged to `manicode_scripts` sessions running an untracked script — so the
 * count is reported rather than collapsed into the boolean.
 *
 * Note the global alternative does NOT substitute for this. Measured on
 * production: a read-only REPEATABLE READ transaction holds a snapshot that
 * blocks vacuum and CREATE INDEX CONCURRENTLY, but is assigned no xid, so
 * `pg_snapshot_xmin(pg_current_snapshot())` does not move for it. Only
 * `backend_xmin` sees it, and only for backends the role may read.
 */
export function evaluateBackendXmin(
  row: BackendXminRow | null,
  threshold = DEFAULT_BACKEND_XMIN_XID,
): BackendXminVerdict {
  const oldestXminAge = toNumber(row?.oldest_xmin_age ?? null)
  const snapshotHolders = toNumber(row?.snapshot_holders ?? null) ?? 0
  const visibleBackends = toNumber(row?.visible_backends ?? null) ?? 0
  const opaqueBackends = toNumber(row?.opaque_backends ?? null) ?? 0
  const breach = oldestXminAge !== null && oldestXminAge >= threshold
  const blindSuffix =
    opaqueBackends > 0
      ? ` (${opaqueBackends} backend(s) opaque to this role and not covered)`
      : ''
  const text = breach
    ? `oldest held snapshot is ${oldestXminAge} transactions behind ` +
      `(threshold ${threshold}); it blocks vacuum and CREATE INDEX CONCURRENTLY${blindSuffix}`
    : `oldest held snapshot ${oldestXminAge ?? 0} xacts behind across ` +
      `${snapshotHolders} holder(s) of ${visibleBackends} readable backend(s)${blindSuffix}`
  return { breach, text }
}

/**
 * Which invalid indexes are a breach. A permanently-invalid index (not
 * building) is never OK. A building index pages only once it has been stuck
 * for `stuckMinutes`; a building index whose age we cannot see (query_start
 * hidden without pg_read_all_stats) is treated as in-progress and reported,
 * not paged.
 */
export function evaluateInvalidIndexes(
  rows: InvalidIndexRow[],
  stuckMinutes = DEFAULT_STUCK_BUILD_MINUTES,
): { breach: boolean; offenders: string[] } {
  const offenders: string[] = []
  for (const row of rows) {
    const building = row.build_phase !== null
    const buildSeconds = toNumber(row.build_seconds)
    const stuck =
      building && buildSeconds !== null && buildSeconds >= stuckMinutes * 60
    if (!building || stuck) {
      const safeBuildSeconds = buildSeconds !== null && Number.isFinite(buildSeconds) ? buildSeconds : 0
      const where = building
        ? `building ${Math.round(safeBuildSeconds / 60)}m`
        : 'not building'
      offenders.push(
        `${row.schema}.${row.table_name}.${row.index_name} (${where}, indisready=${row.indisready})`,
      )
    }
  }
  return { breach: offenders.length > 0, offenders }
}

/**
 * Busy-backend equivalents per query: delta `total_exec_time` over the
 * wall-clock window, the metric that found the 2026-08-03 incident (§3).
 * Mirrors the ad-hoc recipe in scripts/logs/_adhoc-pgdelta.ts.
 */
export function computeBusyBackendRank(
  before: StatementSnapshotRow[],
  after: StatementSnapshotRow[],
  wallSeconds: number,
): BusyBackendRank[] {
  if (wallSeconds <= 0) return []
  const beforeById = new Map(before.map((r) => [r.queryid, r]))
  const out: BusyBackendRank[] = []
  for (const nb of after) {
    const na = beforeById.get(nb.queryid)
    // A missing `before` entry is treated as cumulative zero below, which is
    // bounded for one statement but not for an aggregate bucket: a bucket holds
    // its role's entire history, so its first observation would rank that whole
    // total against a single sampling window. Skipping it costs one window.
    if (na === undefined && isOpaqueStatementBucket(nb.queryid)) continue
    const dc = Number(nb.calls) - Number(na?.calls ?? 0)
    const dt = Number(nb.total_exec_time) - Number(na?.total_exec_time ?? 0)
    if (dc <= 0 && dt <= 0) continue
    out.push({
      busy: dt / 1000 / wallSeconds,
      calls: dc,
      meanMs: dc > 0 ? dt / dc : 0,
      query: nb.query,
      queryid: nb.queryid,
    })
  }
  return out.sort((a, b) => b.busy - a.busy)
}

/** Breach when the top query holds at least `threshold` busy-backend equivalents. */
export function evaluateBusyBackendRank(
  rank: BusyBackendRank[],
  threshold = DEFAULT_BUSY_BACKENDS,
): { breach: boolean; top: BusyBackendRank | null } {
  const top = rank[0] ?? null
  return { breach: top !== null && top.busy >= threshold, top }
}
