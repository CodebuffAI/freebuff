import { MAX_LOG_DATA_BYTES } from '../schemas/logs'

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

function safeLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

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
function errorToJson(error: Error): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...error }
  // A drizzle `DrizzleQueryError` carries the whole statement as `query`, every
  // bound value as `params`, and both again in `message`. For a bulk insert
  // that is hundreds of KB: the ad-revenue rollup's 2026-10-02 failure logged
  // 522 KB, the row was cut at MAX_LOG_DATA_BYTES, and the `cause` holding the
  // Postgres reason came after the cut, so it never reached Axiom. Keep the
  // head of the statement, replace a long param list with its count, and keep
  // the cause.
  if (typeof fields.query === 'string') {
    fields.query = clip(fields.query, MAX_ERROR_QUERY_CHARS)
  }
  if (
    Array.isArray(fields.params) &&
    safeLength(fields.params) > MAX_ERROR_QUERY_CHARS
  ) {
    fields.params = `[${fields.params.length} params omitted]`
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

/**
 * Serialize a log payload to a single string field, tolerating circular refs
 * and capping size. The cap applies to ALL sources so a large `data` payload
 * can't inflate Axiom ingest cost. The truncated form is still valid JSON so
 * query scripts can `parse_json(data)`.
 */
export function serializeLogData(data: unknown): string | null {
  if (data == null) return null
  let serialized: string
  if (typeof data === 'string') {
    serialized = data
  } else {
    try {
      const seen = new WeakSet()
      serialized = JSON.stringify(data, (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
          if (v instanceof Error) return errorToJson(v)
        }
        return v
      })
    } catch {
      return null
    }
  }
  if (serialized.length > MAX_LOG_DATA_BYTES) {
    return JSON.stringify({
      _truncated: true,
      original_bytes: serialized.length,
      preview: serialized.slice(0, MAX_LOG_DATA_BYTES),
    })
  }
  return serialized
}
