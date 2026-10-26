/**
 * Which store serves the live project page's `project:getProjectData`
 * (COD-742, docs/project-spine-mirror.md, "The project page"): the web and
 * Cloud project pages, their settings pages and the migration overlay all
 * subscribe to it.
 *
 * - `convex`   (default): the pages subscribe to Convex, exactly as before.
 *              The registry entry answers `unknown_function`, and the spine
 *              projection keeps its 30 s idle cadence and publishes nothing.
 * - `postgres` the pages read the spine row (and the `daytona_migration`
 *              mirror) through the function registry. The projection runs
 *              every few seconds when idle and, after each link commits,
 *              signals `project:<id>:spine` on the realtime Redis, so an open
 *              page refetches within about one link of a Convex write.
 *
 * Needs the spine reads on Postgres (`projectAccessReadsFromPostgres`); the
 * map entry stays on Convex otherwise. A flip is a reviewed one-line diff
 * here, never an env var; the revert is the same diff.
 */
export type ProjectDataBackend = 'convex' | 'postgres'

export const PROJECT_DATA_BACKEND: ProjectDataBackend = 'postgres'

export function projectDataOnPostgres(
  backend: ProjectDataBackend = PROJECT_DATA_BACKEND,
): boolean {
  return backend === 'postgres'
}

/** The live-layer facet the spine projection signals per changed project. */
export const PROJECT_SPINE_LIVE_FACET = 'spine'

/** The spine projection's idle delay while the project page reads Postgres. */
export const PROJECT_DATA_LIVE_IDLE_DELAY_MS = 5_000
