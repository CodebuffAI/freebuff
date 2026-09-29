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

/**
 * Whether a proposal row was OFFERED to an in-place client, from facts the
 * row already carries -- so an Accept from a client that does NOT run in place
 * can be refused before anything is charged (`client_update_required`).
 *
 * A generic offer is keyed to the FOLDER exactly when its request was
 * in-place, and to the repository otherwise: that is the one rule every serve
 * path applies (`genericAgenticTargetForRequest` in freebuff-web). So a
 * generic row with a workspace target was minted for an in-place client, and
 * a worktree build that accepted it would run the wrong flow in a folder that
 * may have no git at all. `in_place_execution` cannot answer this: it is
 * written AT Accept, from the accepting client's own claim.
 *
 * Non-generic rows (the legacy Supabase format, which keys a remote-less
 * folder by workspace for its own worktree flow) are never in-place offers.
 */
export function sponsoredRowOfferedInPlace(row: {
  deliveryKind: string | null | undefined
  target: { kind: string } | null | undefined
}): boolean {
  return row.deliveryKind === 'generic' && row.target?.kind === 'workspace'
}

/**
 * How an in-place sponsored turn ended, as the client observed it. `closed`
 * includes a quit that cut the turn off; `grant_expired` a turn stopped by
 * its compute grant's deadline.
 */
export type SponsoredTurnEnding =
  | 'completed'
  | 'stopped'
  | 'closed'
  | 'interrupted'
  | 'error'
  | 'grant_expired'

/**
 * The verdict an in-place turn earns (R7), shared by Desktop and the CLI so
 * the two cannot drift:
 *
 * - `delivered`: the turn COMPLETED and left edits of its own.
 * - `partial_edits`: it left edits but ended any other way. Half a procedure
 *   is not the procedure, so this is `failed` -- with copy that says the
 *   partial changes are still in the user's files.
 * - `model_never_ran`: nothing of the model's ran, so no swept file change can
 *   be credited to it.
 * - `no_edits`: the model ran and edited nothing.
 *
 * `modelRan` is optional: a client whose receipts are the run's own tool edits
 * (the CLI) cannot see a model-less turn and leaves it out.
 */
export type SponsoredInPlaceVerdict =
  | 'delivered'
  | 'partial_edits'
  | 'no_edits'
  | 'model_never_ran'

export function sponsoredInPlaceVerdict(input: {
  ending: SponsoredTurnEnding
  editedFileCount: number
  modelRan?: boolean
}): SponsoredInPlaceVerdict {
  if (input.editedFileCount > 0 && input.modelRan !== false) {
    return input.ending === 'completed' ? 'delivered' : 'partial_edits'
  }
  return input.modelRan === false ? 'model_never_ran' : 'no_edits'
}

/**
 * The phrase every partial-edits diagnostic carries. The funnel classifier
 * keys on it (`partial_edits`), which also reclassifies the diagnostics that
 * Desktop builds shipped before this helper existed.
 */
export const SPONSORED_PARTIAL_EDITS_MARKER = 'partial changes'

/**
 * The `diagnostic_reason` of a turn that ended early with edits, byte-for-byte
 * what Desktop has written since 2026-09-25: `how` is the turn's own clause
 * (`turn stopped`, `turn error: <cause>`).
 */
export function sponsoredPartialEditsDiagnostic(
  how: string,
  fileCount: number,
): string {
  return `${how}; the turn ended early, so its partial changes (${fileCount} file${
    fileCount === 1 ? '' : 's'
  }) were left in the workspace and not reported as delivered`
}

/** The user-facing `failure_reason` of a partial-edits run, by how it ended. */
export const SPONSORED_PARTIAL_EDITS_COPY: {
  readonly interrupted: string
  readonly failed: string
} = {
  interrupted:
    'The sponsored task was interrupted before it finished. The changes it made before it stopped are still in your files: review them, or undo them from the conversation above.',
  failed:
    'The sponsored task failed before it finished. The changes it made before it stopped are still in your files: review them, or undo them from the conversation above.',
}
