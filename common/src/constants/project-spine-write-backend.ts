/**
 * Who WRITES the project spine: Convex `project`, `project_member`,
 * `paused_projects` and `paused_users` (COD-742 roadmap §6 C / Wave E2;
 * docs/project-spine-writes.md). A separate stage from the spine READ switch
 * (`PROJECT_SPINE_BACKEND`, packages/internal/src/project-spine/backend.ts)
 * because writes flip late: about 185 Convex functions write these tables,
 * Convex mints project ids that dozens of Convex tables reference, and every
 * pause is enforced by Convex code. So Convex stays the authority, and the
 * only id minter, in every mode here.
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
 *
 * There is deliberately no `postgres` (Postgres as the authority) yet: it
 * needs every Convex reader and writer of these tables gone, or a Postgres →
 * Convex projection.
 *
 * Needs the projection running (`PROJECT_SPINE_BACKEND` not `convex`): the
 * twins write a mirror that only the projection keeps whole. A test pins it.
 *
 * In `common` because the browser's backend map and the server both read it.
 * A flip is a reviewed one-line diff here, never an env var.
 */
export type ProjectSpineWriteBackend = 'convex' | 'shadow' | 'dual'

export const PROJECT_SPINE_WRITE_BACKEND: ProjectSpineWriteBackend = 'convex'

/** Read through a function so callers' comparisons are not narrowed away. */
export function projectSpineWriteBackend(): ProjectSpineWriteBackend {
  return PROJECT_SPINE_WRITE_BACKEND
}

/** True when a ported spine write also runs its Postgres twin. */
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
