/**
 * Who WRITES the project spine: Convex `project`, `project_member`,
 * `paused_projects` and `paused_users` (COD-742 roadmap §6 C / Wave E2;
 * docs/project-spine-writes.md). A separate stage from the spine READ switch
 * (`PROJECT_SPINE_BACKEND`, packages/internal/src/project-spine/backend.ts)
 * because writes flip late: about 185 Convex functions write these tables,
 * Convex mints project ids that dozens of Convex tables reference, and every
 * pause is enforced by Convex code. So Convex stays the only id minter in
 * every mode, and the authority in every mode but `postgres`, where Postgres
 * decides the routed browser writes and Convex is mirrored inside the
 * decision's transaction.
 *
 * - `convex` (default): nothing in the port runs. The browser calls the
 *            Convex mutations directly, the registry twins answer
 *            `unknown_function`, and the pause writer calls Convex only.
 * - `shadow` each ported write still runs on Convex first (its answer is
 *            what the caller gets), then its Postgres twin runs in a
 *            transaction that is ROLLED BACK, and the twin's result and the
 *            rows it would leave are compared with what Convex returned and
 *            now holds (`project_spine_write_shadow_*`). The projection still
 *            carries the write into Postgres.
 * - `dual`   as `shadow`, but the twin's transaction COMMITS: the write is
 *            in Postgres before the response instead of one projection link
 *            later. The projection still runs and converges anything the
 *            twin got wrong (it applies Convex's whole document).
 * - `postgres` POSTGRES DECIDES. A routed write runs its port in one
 *            Postgres transaction first; a Postgres refusal is the answer and
 *            Convex is never called. When Postgres allows it, the SAME Convex
 *            mutation runs as the transaction's last step (Convex readers,
 *            Convex-minted ids and the side effects outside the spine still
 *            live there), and the transaction commits only if Convex took it
 *            too. The pause writer is not routed: at `postgres` it behaves as
 *            at `dual`, because every pause is still enforced by Convex code.
 *
 * `postgres` is REFUSED unless the spine READS are on Postgres
 * (`PROJECT_SPINE_BACKEND = 'postgres'` with membership deletes applied, i.e.
 * `projectAccessReadsFromPostgres()`): deciding writes from a mirror whose
 * reads are not trusted, or that keeps revoked memberships (`report` mode),
 * would grant what Convex refuses. The check is
 * `effectiveProjectSpineWriteBackend` in packages/internal (this package
 * cannot see the read switch); a refused `postgres` runs as `dual`, and a
 * test pins the checked-in pair.
 *
 * Every mode but `convex` needs the projection running (`PROJECT_SPINE_BACKEND`
 * not `convex`): the twins write a mirror that only the projection keeps
 * whole, and at `postgres` it is still what carries the ~170 Convex-internal
 * writers' changes into Postgres. A test pins it.
 *
 * In `common` because the browser's backend map and the server both read it.
 * A flip is a reviewed one-line diff here, never an env var.
 */
export type ProjectSpineWriteBackend = 'convex' | 'shadow' | 'dual' | 'postgres'

export const PROJECT_SPINE_WRITE_BACKEND: ProjectSpineWriteBackend = 'convex'

/** Read through a function so callers' comparisons are not narrowed away. */
export function projectSpineWriteBackend(): ProjectSpineWriteBackend {
  return PROJECT_SPINE_WRITE_BACKEND
}

/**
 * True when the browser-called spine writers go through the registry
 * (`shadow`, `dual`, `postgres`) instead of calling Convex directly.
 */
export function projectSpineWritesRouted(
  backend: ProjectSpineWriteBackend = projectSpineWriteBackend(),
): boolean {
  return backend !== 'convex'
}

/**
 * True when a write runs Convex FIRST and then its Postgres twin (`shadow`,
 * `dual`; the pause writer also at `postgres`, see the header).
 */
export function projectSpineWriteTwinEnabled(
  backend: ProjectSpineWriteBackend = projectSpineWriteBackend(),
): boolean {
  return backend === 'shadow' || backend === 'dual'
}

/** True when the twin's transaction commits (`dual`); false rolls it back. */
export function projectSpineWriteTwinCommits(
  backend: ProjectSpineWriteBackend = projectSpineWriteBackend(),
): boolean {
  return backend === 'dual'
}

/** True when Postgres decides a routed write and Convex is mirrored (`postgres`). */
export function projectSpineWritePostgresDecides(
  backend: ProjectSpineWriteBackend = projectSpineWriteBackend(),
): boolean {
  return backend === 'postgres'
}
