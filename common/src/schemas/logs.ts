import { z } from 'zod/v4'

/**
 * Wire schema for the client → server log/event ingest endpoint (`/api/logs`).
 *
 * Clients (CLI, browser) POST a batch of records. The server stamps `source`,
 * `env`, `user_id` (from auth) and a received-at `timestamp` if missing, then
 * enqueues into the Axiom logs sink. See docs/logging.md.
 *
 * Caps exist to bound per-row storage and protect the ingest path from abuse.
 */

export const MAX_LOG_RECORDS_PER_BATCH = 500
export const MAX_LOG_MESSAGE_LENGTH = 4_000
/** Max serialized size of a single record's `data` payload (≈64 KB). */
export const MAX_LOG_DATA_BYTES = 64_000
/**
 * Hard ceiling on the raw ingest request body (~1 MB). Enforced via
 * Content-Length BEFORE parsing so an unauthenticated client cannot force the
 * server to buffer/parse a huge body (Next.js app-router handlers have no
 * default body limit). See `isLogBodyTooLarge`.
 */
export const MAX_LOG_BODY_BYTES = 1_000_000

/**
 * Returns true if a request declares (or omits, when `required`) a body larger
 * than MAX_LOG_BODY_BYTES. Pass the `Content-Length` header value.
 */
export function isLogBodyTooLarge(contentLength: string | null): boolean {
  if (contentLength == null) return false // chunked / unknown; schema caps still apply
  const len = Number(contentLength)
  return Number.isFinite(len) && len > MAX_LOG_BODY_BYTES
}

export const logLevelSchema = z.enum([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
])

export const logRecordSchema = z.object({
  /** Client-supplied event time (ISO 8601). Server falls back to now. */
  timestamp: z.string().datetime().optional(),
  level: logLevelSchema.default('info'),
  /** Analytics or operational event name when applicable. */
  event: z.string().max(200).nullish(),
  message: z.string().max(MAX_LOG_MESSAGE_LENGTH).nullish(),
  client_session_id: z.string().max(200).nullish(),
  client_request_id: z.string().max(200).nullish(),
  fingerprint_id: z.string().max(200).nullish(),
  /**
   * Structured payload. Kept as unknown JSON; the server truncates if the
   * serialized form exceeds MAX_LOG_DATA_BYTES.
   */
  data: z.unknown().optional(),
})

export type LogRecordInput = z.infer<typeof logRecordSchema>

export const logIngestSchema = z.object({
  records: z.array(logRecordSchema).min(1).max(MAX_LOG_RECORDS_PER_BATCH),
})
