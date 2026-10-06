/**
 * What account deletion does with the Postgres copies of a Freebuff Web
 * account (COD-742 Wave C, full tier; docs/convex-retirement-account-deletion.md).
 *
 * Convex stays the authority in every mode here: the step-up code is checked,
 * and the account purged, inside `account_deletion:deleteOwnAccount` /
 * `account_deletion:purge` exactly as before. What changes is the Postgres
 * twins the domain moves created (`project_member`, `github_connection`,
 * `cloud_agent_run`, …), which a Convex-only purge leaves holding the deleted
 * account's rows.
 *
 * - `convex`  (default): the twins are not read or touched.
 * - `shadow`: after Convex reports the account purged, count what the twins
 *             still hold for it and log the counts beside Convex's. Deletes
 *             nothing in Postgres.
 * - `dual`:   after Convex reports the account purged, purge the twins too
 *             (`purgeWebAccountTwins`). A failure there never fails the
 *             deletion: the `account_deletion.purge_web_account` job retries
 *             it.
 *
 * There is no `postgres` mode yet: Convex mints the users id and holds the
 * users row until identity moves, so the code check and the audit writer move
 * with identity (see the doc).
 *
 * A constant, not an env var: a flip is a reviewed one-line diff.
 */
export type AccountDeletionBackend = 'convex' | 'shadow' | 'dual'

export const ACCOUNT_DELETION_BACKEND: AccountDeletionBackend = 'convex'

/** Read through a function so callers' comparisons are not narrowed away. */
export function accountDeletionBackend(): AccountDeletionBackend {
  return ACCOUNT_DELETION_BACKEND
}
