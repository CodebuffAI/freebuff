import { MAX_LOG_DATA_BYTES } from '../schemas/logs'
import { redactErrorFieldForLog, redactQueryErrorForLog } from './log-redaction'

import type { LogLevel } from '../types/contracts/logs'

/**
 * Shared pieces of the Axiom log-row pipeline used by every producer that
 * ingests rows — the long-lived sink (packages/logging/src/sink.ts) and the
 * Convex direct-ingest helper (freebuff/web/convex/lib/axiom_log.ts). Living
 * here keeps the serialized `data` contract and level ordering identical
 * across producers, so APL queries behave the same regardless of which
 * service emitted a row. Deliberately light on imports (the schemas module
 * pulls only zod) so it stays safe for the Convex bundle.
 */

/** Numeric severity order for LogLevel, used for min-level gating. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
}

/** Stack traces cost ingest on every error row; the top frames carry it. */
const MAX_ERROR_STACK_CHARS = 2_000
/** An error message or SQL statement longer than this is a payload, not a reason. */
const MAX_ERROR_MESSAGE_CHARS = 2_000
const MAX_ERROR_QUERY_CHARS = 500

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [${text.length - max} chars omitted]`
    : text
}

/**
 * An Error as plain JSON. `name`, `message` and `stack` are non-enumerable, so
 * `JSON.stringify(error)` is `{}`: every `logger.error({ error }, ...)` whose
 * error reached this serializer arrived in Axiom with no reason attached (on
 * 2026-09-27, 119 error/warn rows a day on freebuff-web alone, and the
 * Imprezia ingest's refusals for nine days). Enumerable fields a library adds
 * (`code`, `status`, a driver's `query`) are kept, and `cause` is walked by the
 * same replacer.
 */
function errorToJson(original: Error): Record<string, unknown> {
  // A drizzle `DrizzleQueryError` carries the whole statement as `query`, and
  // every bound value as `params` and again in `message` and `stack`. The
  // values can be credentials (OAuth tokens on an auth insert), so they are
  // never logged; for a bulk insert they were also hundreds of KB: the
  // ad-revenue rollup's 2026-10-02 failure logged 522 KB, the row was cut at
  // MAX_LOG_DATA_BYTES, and the `cause` holding the Postgres reason came after
  // the cut. Keep the head of the statement and the cause.
  const error = redactQueryErrorForLog(original)
  const fields: Record<string, unknown> = { ...error }
  if (typeof fields.query === 'string') {
    fields.query = clip(fields.query, MAX_ERROR_QUERY_CHARS)
  }
  // An AI SDK `APICallError` carries the whole LLM request (every message),
  // both header sets and the URL, and Bun's fetch errors the URL as `path`:
  // keep their shape, never the prompt or a key. The same function redacts
  // `getErrorObject`'s raw dump, so the two paths cannot drift apart.
  for (const key of Object.keys(fields)) {
    fields[key] = redactErrorFieldForLog(key, fields[key])
  }
  return {
    ...fields,
    name: error.name,
    message: clip(error.message, MAX_ERROR_MESSAGE_CHARS),
    ...(error.stack
      ? { stack: error.stack.slice(0, MAX_ERROR_STACK_CHARS) }
      : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  }
}

/** Stringify a log payload, tolerating circular refs and unwrapping Errors. */
export function stringifyLogData(data: unknown): string | undefined {
  try {
    const seen = new WeakSet()
    return JSON.stringify(data, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
        if (v instanceof Error) return errorToJson(v)
      }
      return v
    })
  } catch {
    return undefined
  }
}

/**
 * Fit an oversized log payload inside MAX_LOG_DATA_BYTES **without losing the
 * fields that identify it.**
 *
 * The whole payload used to be replaced by one `preview` string, so a single
 * oversized field took every small field beside it down with it. Measured on
 * 2026-10-14 against one hour of production: **171 of 281 `Agent execution
 * failed` rows (61%, 149 distinct users) carried no queryable `error`,
 * `agentType`, `agentId` or `runId`** — the CLI's failure line logs
 * `messageHistory` and `systemPrompt`, which alone run past the cap (121 KB in
 * the sampled row), so every row of the busiest error line in the dataset was
 * unattributable. `errorToJson`'s comment above records the same accident
 * happening to a drizzle `cause` on 2026-10-02 and fixes it for that one
 * shape; this fixes it for every shape.
 *
 * Keeps fields smallest-first until the budget is spent, so the scalars that
 * identify a row (ids, counts, status codes) survive by construction and only
 * the payloads are dropped. `_omitted` names each dropped field and its size,
 * because "this row had no error" and "this row's error did not fit" are
 * different facts and the old shape could not tell them apart. The byte cap is
 * unchanged, so ingest cost is unchanged.
 */
function fitLogDataToCap(data: unknown, originalBytes: number): string {
  const wholePayloadPreview = (serialized: string) =>
    JSON.stringify({
      _truncated: true,
      original_bytes: originalBytes,
      preview: serialized.slice(0, MAX_LOG_DATA_BYTES),
    })

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return wholePayloadPreview(stringifyLogData(data) ?? '')
  }

  const sized: { key: string; value: unknown; bytes: number }[] = []
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    const serialized = stringifyLogData(value)
    if (serialized === undefined) continue
    // `"key":` plus a separator, so the budget counts what the row will cost.
    sized.push({ key, value, bytes: serialized.length + key.length + 4 })
  }
  sized.sort((a, b) => a.bytes - b.bytes)

  const kept: Record<string, unknown> = {}
  const omitted: Record<string, number> = {}
  // Headroom for the `_truncated` / `original_bytes` / `_omitted` markers.
  let budget = MAX_LOG_DATA_BYTES - 256
  for (const field of sized) {
    if (field.bytes <= budget) {
      kept[field.key] = field.value
      budget -= field.bytes
    } else {
      omitted[field.key] = field.bytes
      // A dropped field still costs its name in `_omitted`.
      budget -= field.key.length + 12
    }
  }

  // Nothing fit: fall back to a preview, so a single enormous field still
  // leaves a readable head rather than only its byte count.
  if (Object.keys(kept).length === 0) {
    return wholePayloadPreview(stringifyLogData(data) ?? '')
  }

  const fitted = stringifyLogData({
    ...kept,
    _truncated: true,
    original_bytes: originalBytes,
    _omitted: omitted,
  })
  // The budget arithmetic should make this unreachable; a payload whose
  // serialization grew anyway falls back rather than breaking the cap.
  if (fitted === undefined || fitted.length > MAX_LOG_DATA_BYTES) {
    return wholePayloadPreview(stringifyLogData(data) ?? '')
  }
  return fitted
}

/**
 * Serialize a log payload to a single string field, tolerating circular refs
 * and capping size. The cap applies to ALL sources so a large `data` payload
 * can't inflate Axiom ingest cost. The truncated form is still valid JSON so
 * query scripts can `parse_json(data)`.
 *
 * An oversized object keeps the fields that fit (see {@link fitLogDataToCap});
 * only an oversized string or array collapses to a `preview`.
 */
export function serializeLogData(data: unknown): string | null {
  if (data == null) return null
  let serialized: string
  if (typeof data === 'string') {
    serialized = data
  } else {
    const stringified = stringifyLogData(data)
    if (stringified === undefined) return null
    serialized = stringified
  }
  if (serialized.length > MAX_LOG_DATA_BYTES) {
    return typeof data === 'string'
      ? JSON.stringify({
          _truncated: true,
          original_bytes: serialized.length,
          preview: serialized.slice(0, MAX_LOG_DATA_BYTES),
        })
      : fitLogDataToCap(data, serialized.length)
  }
  return serialized
}

/**
 * The same payload with every `Error` replaced by its JSON form, as plain
 * JSON values rather than a string.
 *
 * For producers that hand their payload to ANOTHER process before it reaches
 * {@link serializeLogData}: the CLI POSTs each log row to `/api/logs`, and
 * that hop's `JSON.stringify` drops `name`, `message` and `stack` (they are
 * non-enumerable), so the sink on the far side receives an error that has
 * already lost its reason and cannot restore it. Measured on 2026-10-14, one
 * hour of production CLI rows for `[ads] Failed to fetch ad`: 49 of 205
 * carried `err: {}` — nothing at all — and the other 156 carried only Bun's
 * enumerable `code`/`errno`/`path`, never the message.
 *
 * Unwrapping here also applies the redaction in `redactErrorFieldForLog` on
 * the client, so a URL, header set or request body hanging off an error is
 * trimmed before it leaves the machine instead of after.
 */
export function toJsonSafeLogData(data: unknown): unknown {
  if (data == null || typeof data !== 'object') return data
  const serialized = stringifyLogData(data)
  if (serialized === undefined) return data
  try {
    return JSON.parse(serialized)
  } catch {
    return data
  }
}
