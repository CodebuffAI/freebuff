/**
 * Whether Postgres keeps a mirror of the Convex `daytona_migration` sidecar
 * (each project's Daytona server and sandbox migration state; Postgres table
 * of the same name), and whether freebuff-web reads it. COD-742 sandboxes;
 * runbook in docs/freebuff-sandbox-errors-postgres.md, "Migration sidecar".
 *
 * - `convex`   nothing reads or writes the Postgres table, and the
 *              `sandbox_migration.projection` chain ends at its next link.
 * - `shadow`   the chain copies every Convex change (insert,
 *              patch, delete) into Postgres, so readers that moved off Convex
 *              can read the mirror. Convex still writes first: its writers
 *              that run on freebuff-web also write through to Postgres
 *              (packages/internal/src/sandbox-migration/write-through.ts).
 *              The fences that have not moved (send gates, run claim,
 *              hosting, the Cloud workspace and preview twins) read Convex.
 * - `postgres` (current) as `shadow` for the chain and the writes (Convex stays
 *              authoritative for the Convex-side readers), and every
 *              freebuff-web reader of the row reads Postgres first: a
 *              Postgres row is the answer; a missing row or a failed read
 *              still asks Convex wherever a reader did before
 *              (freebuff/web/src/server/sandbox-migration-reads.ts).
 *
 * Flip gate (the doc's "Flipping to postgres"): the reconcile reports zero
 * drift and the `carried: false` write-through log rate is about zero.
 *
 * Imported by the jobs worker, the Next servers and Convex, so it must stay a
 * leaf. A flip is a reviewed one-line diff here, never an env var; the
 * revert is the same diff.
 */
export const SANDBOX_MIGRATION_BACKENDS = ['convex', 'shadow', 'postgres'] as const

export type SandboxMigrationBackend = (typeof SANDBOX_MIGRATION_BACKENDS)[number]

export const SANDBOX_MIGRATION_BACKEND: SandboxMigrationBackend = 'postgres'

/** Whether the projection mirrors Convex into Postgres (and writers write through). */
export function sandboxMigrationMirrored(
  backend: SandboxMigrationBackend = SANDBOX_MIGRATION_BACKEND,
): boolean {
  return backend !== 'convex'
}

/** Whether freebuff-web's readers of the row read Postgres first. */
export function sandboxMigrationReadsFromPostgres(
  backend: SandboxMigrationBackend = SANDBOX_MIGRATION_BACKEND,
): boolean {
  return backend === 'postgres'
}
