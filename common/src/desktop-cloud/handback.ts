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
