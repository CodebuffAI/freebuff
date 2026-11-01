import { z } from 'zod/v4'

/**
 * Cloud-to-local handoff ("Continue locally", COD-878). A Cloud chat moves to
 * one computer keeping its chat id, transcript and place in its project; the
 * reverse move is the existing Continue in Cloud import.
 *
 * 1. `GET /api/v1/cloud/workspaces/:id/export` streams a gzip tar of the chat's
 *    worktree (the same exclusions as a source import: `.git`, dependencies,
 *    build output, `.env` secrets, symlinks). It changes nothing.
 * 2. `POST /api/v1/cloud/workspaces/:id/handback` fences the chat to the
 *    computer, but only when no run started after the export. From then on
 *    Cloud refuses new runs for it, so a chat never runs in two places.
 * 3. Continue in Cloud on a handed-back chat sends `resume: true` and only the
 *    turns taken locally. Cloud reseeds the chat's worktree from the new files
 *    and lifts the fence.
 */

/** Export response headers. The body is `application/gzip`. */
export const CLOUD_EXPORT_HEADERS = {
  /** Newest run of the chat when the export was taken, or empty for none. */
  runId: 'x-freebuff-export-run',
  /** Lowercase hex SHA-256 of the whole response body. */
  sha256: 'x-freebuff-export-sha256',
  /** Byte length of the body. */
  bytes: 'x-freebuff-export-bytes',
} as const

export const handbackRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(120),
    /** The export's run receipt; a newer run means the export is stale. */
    exportRunId: z.string().max(120),
    exportSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
export type HandbackRequest = z.infer<typeof handbackRequestSchema>

/** Sent only after Desktop has committed the local landing. The timestamp identifies this move,
 * so a delayed acknowledgement cannot reclaim a later Cloud workspace. */
export const handbackCompleteSchema = handbackRequestSchema.extend({
  handedBackAt: z.iso.datetime({ offset: true }),
})
export type HandbackCompleteRequest = z.infer<typeof handbackCompleteSchema>

export interface HandbackResponse {
  workspaceId: string
  /** ISO time the chat left Cloud. Repeating the same handback returns the original time. */
  handedBackAt: string
}

/** The 409 a run request gets for a chat that continues on a computer. */
export const HANDED_BACK_RUN_ERROR =
  'This chat continues on a computer. Open it there, or choose Continue in Cloud on that computer to bring it back.'

/** The 409 a handback gets when Cloud moved on after the export; export again. */
export const STALE_EXPORT_ERROR =
  'This chat changed in Cloud after its files were copied. Retry Continue locally.'

/**
 * Export v2 (`GET …/export?v=2`). The tar is the same working-tree copy, plus two entries under
 * this directory, which a worktree never exports itself:
 *
 * - `meta.json` (`CloudExportMeta`): the commit the chat's worktree started from, its HEAD, and the
 *   files tracked at HEAD that the working tree no longer has.
 * - `commits.bundle`: `git bundle` of HEAD excluding `base` (absent when HEAD is the base; with
 *   `history=full`, HEAD's whole history, for a Cloud project's first landing on a computer), under
 *   the ref `CLOUD_EXPORT_BUNDLE_REF`. Its prerequisites are reachable from `base`, which the
 *   computer that uploaded the chat has. Without a known base it holds HEAD's whole history.
 *
 * With them, Continue locally lands Cloud's commits as commits and merges Cloud's work with the
 * computer's own, instead of flattening it over the current branch tip. An older server ignores
 * `v` and sends v1 (no `meta.json`); Desktop then lands the files as before.
 */
export const CLOUD_EXPORT_V2_DIR = '.freebuff-export'
/** The ref name inside `commits.bundle`. */
export const CLOUD_EXPORT_BUNDLE_REF = 'HEAD'

const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)

const cloudExportV2Schema = z
  .object({
    version: z.literal(2),
    /** The commit the worktree started from (its marker), or null for a chat initialized before it was recorded. */
    base: commitSchema.nullable(),
    /** The worktree's HEAD, or null for an empty repository. */
    head: commitSchema.nullable(),
    /** The worktree's branch. */
    branch: z.string().max(400).nullable(),
    /** Whether `commits.bundle` is in the tar. */
    bundle: z.boolean(),
    /** Tracked at HEAD, absent from the working tree. */
    deleted: z.array(z.string().max(4096)).max(200_000),
  })
  .strict()
/** V3 sends Git objects once plus only working files whose bytes differ from HEAD.
 * `have` is a complete commit graph verified by the receiver; unknown bases send a full pack.
 * `files` is the complete eligible working-file inventory, for plain-folder reconstruction.
 * `shallow` preserves any history boundary already present in Cloud (never invents one).
 */
export const cloudExportV3Schema = cloudExportV2Schema.extend({
  version: z.literal(3),
  bundle: z.literal(false),
  pack: z.boolean(),
  have: commitSchema.nullable(),
  shallow: z.array(commitSchema).max(200_000),
  files: z.array(z.string().max(4096)).max(200_000),
}).strict()
export const cloudExportMetaSchema = z.union([cloudExportV2Schema, cloudExportV3Schema])
export type CloudExportMeta = z.infer<typeof cloudExportMetaSchema>

/** Archiving moves a chat's files from its VM to storage; its next turn brings them back. */
export const ARCHIVED_CHAT_RESTORE_ERROR =
  'This chat’s Cloud files are archived. Send a message to bring them back.'

/** Cloud has lost its full copy, but the portable export Desktop lands is still there. */
export const ARCHIVED_CHAT_DESKTOP_ERROR =
  'Cloud can’t bring back this chat’s files. Open it in Freebuff Desktop to restore its saved copy. Its conversation is safe and stays here to read.'

/** No copy of the chat's files survives, so no client can restore them. */
export const ARCHIVED_CHAT_LOST_ERROR =
  'Cloud no longer has this chat’s files, so it can’t continue here. Its conversation is safe and stays here to read. Start a new chat in this project to keep working: it starts from the project’s source, without this chat’s changes.'
