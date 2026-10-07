/**
 * Which store answers identity reads — the Convex `users` document behind
 * `users:viewer` and the admin-role gate — for the move off platform Convex
 * (COD-742 roadmap §6 C, second half; docs/freebuff-identity-postgres.md).
 * FULL tier: `convex` → `shadow` (7 days, zero mismatches) → `postgres`, then
 * a 14-day zero-call soak.
 *
 * Convex stays the WRITER of `users` in every mode here (writes have their
 * own switch, IDENTITY_WRITE_BACKEND, below). Convex users ids are
 * referenced by about 110 `v.id('users')` fields, so they keep being minted
 * in Convex (`getOrCreateSignedInUser`) and Postgres `user_profile` mirrors
 * them through the projection job until those tables have moved.
 *
 * - `convex`   (default): nothing in the port runs. The projection link and
 *              the profile audit no-op, `users:viewer` is served by Convex,
 *              and the admin gate reads the role from Convex.
 * - `shadow`   the projection keeps `user_profile` current. Every identity
 *              read still answers from Convex; the browser also fetches the
 *              registry's `users:viewer` and compares (`convex_pg_shadow_*`),
 *              the admin gate also reads the Postgres role and compares
 *              (`identity_role_shadow_*`), and a sampled job compares rows.
 * - `postgres` `users:viewer` and the admin role are read from Postgres.
 *              Convex still writes and the projection still runs.
 *
 * In `common` because the browser's backend map and the server both read it.
 * A flip is a reviewed one-line diff here, never an env var.
 */
export type IdentityBackend = 'convex' | 'shadow' | 'postgres'

export const IDENTITY_BACKEND: IdentityBackend = 'convex'

/** Read through a function so callers' comparisons are not narrowed away. */
export function identityBackend(): IdentityBackend {
  return IDENTITY_BACKEND
}

/** True when the Convex → Postgres `users` projection should run. */
export function identityProjectionEnabled(
  backend: IdentityBackend = identityBackend(),
): boolean {
  return backend !== 'convex'
}

/** True when identity reads also compute the Postgres answer to compare. */
export function identityShadowEnabled(
  backend: IdentityBackend = identityBackend(),
): boolean {
  return backend === 'shadow'
}

/** Who answers identity READS in `backend`. Shadow still answers from Convex. */
export function identityReadBackend(
  backend: IdentityBackend = identityBackend(),
): 'convex' | 'postgres' {
  return backend === 'postgres' ? 'postgres' : 'convex'
}

/**
 * Who WRITES identity — the Convex `users` writers listed in
 * docs/freebuff-identity-postgres.md ("Writes") — a separate stage from
 * reads because writes flip late: about 110 `v.id('users')` fields and 514
 * `getAuthUser` call sites inside Convex still read Convex `users`, so Convex
 * keeps the document every reader sees, and stays the id minter, in every
 * mode here; up to `dual` it is also the authority.
 *
 * - `convex`  (default): nothing in the port runs. The browser calls the
 *             Convex mutations directly; the registry twins answer
 *             `unknown_function`; server-side writers call Convex only.
 * - `shadow`  each ported write still runs on Convex first (the browser's
 *             call goes through the registry, which calls the same Convex
 *             mutation as the caller), then its Postgres twin runs in a
 *             transaction that is ROLLED BACK, and the twin's result and the
 *             row it would leave are compared with what Convex returned and
 *             now holds (`identity_write_shadow_*`). The projection still
 *             carries the write into `user_profile`.
 * - `dual`    as `shadow`, but the twin's transaction COMMITS: the caller's
 *             own write is in `user_profile` before the response, instead of
 *             one projection link later. The projection still runs and
 *             converges anything the twin got wrong (it applies Convex's
 *             document), and the comparison still logs.
 *
 * - `postgres` Postgres DECIDES the browser-called writes: the twin runs
 *             first, with the rows locked and the resurrection guard read
 *             from `account_deletion_audit`, and a refusal there never
 *             reaches Convex. An accepted write is then CARRIED to Convex by
 *             the same Convex mutation, inside the Postgres transaction, so
 *             a Convex failure rolls it back and the two never part; a new
 *             account's id is minted by that same call (Convex stays the
 *             minter while ~110 `v.id('users')` fields and 514
 *             `getAuthUser` sites read Convex `users`). The answer is the
 *             twin's. Server-side writers (badge sync, email move, Desktop
 *             provisioner) behave as at `dual`. The projection still runs.
 *
 * Needs the projection running (`IDENTITY_BACKEND` not `convex`): the twins
 * write a mirror that only the projection keeps whole. `postgres` also needs
 * identity READS on Postgres (`IDENTITY_BACKEND` `postgres`): a writer of
 * record must read what it decides on. Tests pin both.
 */
export type IdentityWriteBackend = 'convex' | 'shadow' | 'dual' | 'postgres'

export const IDENTITY_WRITE_BACKEND: IdentityWriteBackend = 'convex'

/** Read through a function so callers' comparisons are not narrowed away. */
export function identityWriteBackend(): IdentityWriteBackend {
  return IDENTITY_WRITE_BACKEND
}

/** True when a ported identity write also runs its Postgres twin. */
export function identityWriteTwinEnabled(
  backend: IdentityWriteBackend = identityWriteBackend(),
): boolean {
  return backend !== 'convex'
}

/**
 * True when the twin's transaction commits (`dual`, `postgres`); false rolls
 * it back.
 */
export function identityWriteTwinCommits(
  backend: IdentityWriteBackend = identityWriteBackend(),
): boolean {
  return backend === 'dual' || backend === 'postgres'
}

/** True when Postgres decides a browser-called identity write (`postgres`). */
export function identityWriteAuthorityIsPostgres(
  backend: IdentityWriteBackend = identityWriteBackend(),
): boolean {
  return backend === 'postgres'
}
