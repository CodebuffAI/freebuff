/**
 * Whether Postgres keeps a mirror of the Convex `daytona_migration` sidecar
 * (each project's Daytona server and sandbox migration state; Postgres table
 * of the same name). COD-742 sandboxes; runbook in
 * docs/freebuff-sandbox-errors-postgres.md, "Migration sidecar".
 *
 * - `convex`  nothing reads or writes the Postgres table, and the
 *            `sandbox_migration.projection` chain ends at its next link.
 * - `shadow` the chain copies every Convex change (insert, patch, delete)
 *            into Postgres, so readers that moved off Convex can read the
 *            mirror. Convex still writes: its writers (project creation,
 *            Cloud connect, the snapshot migration) have not moved, though
 *            those that run on freebuff-web also write through to Postgres
 *            (packages/internal/src/sandbox-migration/write-through.ts).
 *
 * There is no `postgres` yet: that comes with the writers' port.
 *
 * Imported by the jobs worker and the Next servers, so it must stay a leaf. A
 * flip is a reviewed one-line diff here, never an env var.
 */
export type SandboxMigrationBackend = 'convex' | 'shadow'

export const SANDBOX_MIGRATION_BACKEND: SandboxMigrationBackend = 'shadow'

/** Whether the projection mirrors Convex into Postgres. */
export function sandboxMigrationMirrored(
  backend: SandboxMigrationBackend = SANDBOX_MIGRATION_BACKEND,
): boolean {
  return backend === 'shadow'
}
