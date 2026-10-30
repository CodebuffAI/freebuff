import {
  identityUserIdMinter,
  type IdentityUserIdMinter,
} from './identity-backend'

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
 *             codes (`finalize`). The preflight reads nothing from Convex.
 *             The background job drives Convex's own purge
 *             (`deleteOwnAccount` with a code the server mints for that
 *             attempt) only while Convex mints users ids
 *             (`accountDeletionPurgesConvex`). Flips with
 *             `IDENTITY_WRITE_BACKEND = postgres`, whose sign-in guard reads
 *             the Postgres audit row.
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

/**
 * True when the background job still drives Convex's own purge
 * (`account_deletion:deleteOwnAccount`): every mode but `postgres`, and at
 * `postgres` only while Convex mints users ids at sign-in
 * (`IDENTITY_USER_ID_MINTER = convex`). Convex's sign-in refuses a new account
 * whose address a claimed Convex `users` document still holds, so while it
 * mints, a deleted account's document must go or its owner could never sign
 * up again. Once freebuff-web mints, nothing reads Convex for the account and
 * its Convex rows stay parked with the rest of Convex (COD-742 B25).
 */
export function accountDeletionPurgesConvex(
  backend: AccountDeletionBackend = accountDeletionBackend(),
  minter: IdentityUserIdMinter = identityUserIdMinter(),
): boolean {
  return backend !== 'postgres' || minter === 'convex'
}

/** True when Postgres holds the deletion step-up proof (`postgres`). */
export function accountDeletionProofOnPostgres(
  backend: AccountDeletionBackend = accountDeletionBackend(),
): boolean {
  return backend === 'postgres'
}
