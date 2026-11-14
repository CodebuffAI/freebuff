/**
 * Who mints a new project's id and inserts it (COD-742, platform Convex
 * pause; docs/project-spine-writes.md, "Ids").
 *
 * - `convex` (default, current): every create is the Convex internal
 *            mutation (over the admin key), carried into Postgres in the
 *            same transaction while the spine writes are on Postgres
 *            (`project-create-through-postgres.ts`).
 * - `postgres` freebuff-web mints the project, owner membership and
 *            `daytona_migration` ids in Convex's format
 *            (packages/internal/src/project-spine/local-ids.ts) and inserts
 *            the rows on Postgres with no Convex call: the Web create's pool
 *            claim and shell, connect-repo, blank Cloud, and warm-pool
 *            provisioning (`project-create-on-postgres.ts`). The pool's
 *            candidate list, ready mark and discards move with them.
 *
 * Writes to a project minted on Postgres never go to Convex, whatever this
 * says: the id itself says where the project lives (`isPostgresMintedConvexId`).
 *
 * Flip only with platform Convex paused, or once nothing Convex-side reads a
 * new project: Convex holds no document for a Postgres-minted project, so a
 * Convex function that reads one (an old bundle's direct Convex read) finds
 * nothing. A Web cold start of a minted shell runs on freebuff-web
 * (freebuff/web/src/server/web-cold-start-on-postgres.ts). A flip is a reviewed
 * one-line diff here, never an env var. freebuff-web's Render root is
 * `freebuff/web`, so a commit touching only this file does not deploy it:
 * redeploy freebuff-web by hand after the flip merges. The runner does not
 * read it (it routes only writes to projects already minted on Postgres).
 * Before the flip, copy the golden snapshots (`scripts/sandbox-snapshot-seed.ts`).
 */
export type ProjectIdMinter = 'convex' | 'postgres'

export const PROJECT_ID_MINTER: ProjectIdMinter = 'convex'

/** Read through a function so callers' comparisons are not narrowed away. */
export function projectIdMinter(): ProjectIdMinter {
  return PROJECT_ID_MINTER
}

/** True when new projects are minted and inserted on Postgres. */
export function projectsMintedOnPostgres(
  minter: ProjectIdMinter = projectIdMinter(),
): boolean {
  return minter === 'postgres'
}
