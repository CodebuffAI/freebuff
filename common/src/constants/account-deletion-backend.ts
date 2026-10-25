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
 * - `postgres` (built, dark): the step-up proof moves to Postgres. The
 *             emailed code, the confirm step's and the Apple step's server-
 *             minted codes are issued and checked in `account_otp`
 *             (`account_deletion`), so the routes never call Convex's
 *             `requestDeletionCode` / `verifyOwnDeletionCode` /
 *             `authorizeAppleDeletion` for the user's proof. The twins are
 *             purged as at `dual`, and the final pass also scrubs
 *             `user_profile`, writes `account_deletion_audit` and spends the
 *             codes (`finalize`). The background job still drives Convex's
 *             own purge (`deleteOwnAccount` with a code the server mints for
 *             that attempt), because the account's Convex rows live there
 *             until their domains move; Convex keeps its own audit row too.
 *             Flips with `IDENTITY_WRITE_BACKEND = postgres`, whose sign-in
 *             guard reads the Postgres audit row.
 *
 * A constant, not an env var: a flip is a reviewed one-line diff.
 */
export type AccountDeletionBackend = 'convex' | 'shadow' | 'dual' | 'postgres'

export const ACCOUNT_DELETION_BACKEND: AccountDeletionBackend = 'postgres'

/** Read through a function so callers' comparisons are not narrowed away. */
export function accountDeletionBackend(): AccountDeletionBackend {
  return ACCOUNT_DELETION_BACKEND
}

/** True when the twins are purged, not just counted (`dual`, `postgres`). */
export function accountDeletionPurgesTwins(
  backend: AccountDeletionBackend = accountDeletionBackend(),
): boolean {
  return backend === 'dual' || backend === 'postgres'
}

/** True when Postgres holds the deletion step-up proof (`postgres`). */
export function accountDeletionProofOnPostgres(
  backend: AccountDeletionBackend = accountDeletionBackend(),
): boolean {
  return backend === 'postgres'
}
