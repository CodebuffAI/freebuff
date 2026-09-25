/**
 * THE IN-PLACE EXECUTION CONTRACT (2026-09-24): one number a client sends to
 * say it runs an accepted sponsored offer as a turn in the ACCEPTING
 * conversation, editing the user's working copy, with no worktree, commit,
 * branch or pull request.
 *
 * Read the amendment in `docs/freebuff-sponsored-local-execution.md` before
 * touching anything here: the write root moves onto the user's real files, so
 * `.git` becomes read-only to the run, secret-bearing files become unreadable,
 * and the rewind becomes the undo.
 *
 * WHY A CLIENT CAPABILITY AND NOT A SERVER KNOB. The two flows differ in what
 * the CLIENT does with the grant, and every released Desktop build does the
 * worktree one. A server switch would change what a build already shipped is
 * asked to do -- offering an in-place run to a client that would make a
 * worktree, or refusing `delivered` from one that cannot commit. So the client
 * declares it, on the offer request and again at Accept, and the server
 * applies in-place semantics for exactly those requests. A request without it
 * is byte-identical to one from before this existed.
 *
 * Sent by BOTH halves on purpose. The offer request needs it because in-place
 * clients are eligible without Git at all (no repository, no commit, no
 * `owner/repo`), so it decides what may be OFFERED. Accept needs it because
 * the grant, the target and the terminal vocabulary differ, and an offer can
 * outlive the build that was shown it -- a card offered to an in-place client
 * can be accepted after an update, or by a build that downgraded.
 */

import { z } from 'zod'

/** `inPlaceExecutionVersion` on the wire, and the only value it may take. */
export const SPONSORED_IN_PLACE_VERSION = 1

export const sponsoredInPlaceVersionSchema = z.literal(
  SPONSORED_IN_PLACE_VERSION,
)

/**
 * Whether this request came from a client that runs in place.
 *
 * Total, and false for everything it does not recognise: a future version, a
 * string, a `0`. An unknown value must read as "the worktree flow" rather
 * than as the newest one this server knows, because the client is the half
 * that has to carry it out.
 */
export function clientRunsSponsoredInPlace(value: unknown): boolean {
  return value === SPONSORED_IN_PLACE_VERSION
}
