/**
 * Redaction for values that end up in error messages and logs, which reach
 * PostHog and Axiom from the CLI, the SDK and the servers. No imports, so it
 * is safe for every bundle that serializes logs (including Convex's).
 */

/**
 * A URL fit for an error message or log line: scheme, host and path. The
 * query and fragment are dropped (they carry ids such as `fingerprintHash`,
 * and sometimes keys), and so are any `user:password@` credentials.
 */
export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host
      ? `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      : `${parsed.protocol}${parsed.pathname}`
  } catch {
    // Relative or malformed: strip the same parts textually.
    return url
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1')
      .replace(/[?#][\s\S]*$/, '')
  }
}

export type RequestBodySummary = {
  /** The `model` field, when the body names one. */
  model?: string
  /** Length of the conversation array (`messages`, `input` or `contents`). */
  messageCount?: number
  /** Top-level keys, e.g. whether `tools` or `response_format` were sent. */
  keys: string[]
  /** Approximate serialized size of the whole body. */
  bytes?: number
}

const MAX_SUMMARY_KEYS = 30

/**
 * The shape of an LLM request body without its content. An AI SDK
 * `APICallError` carries the full request (`requestBodyValues`): every
 * message, file and tool result, including BYOK users' prompts that we never
 * otherwise see. Logs get this summary instead.
 */
export function summarizeRequestBodyForLog(
  body: unknown,
): RequestBodySummary | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined
  }
  const record = body as Record<string, unknown>
  const conversation = [record.messages, record.input, record.contents].find(
    Array.isArray,
  )
  let bytes: number | undefined
  try {
    bytes = JSON.stringify(body)?.length
  } catch {
    bytes = undefined
  }
  return {
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(conversation ? { messageCount: conversation.length } : {}),
    keys: Object.keys(record).slice(0, MAX_SUMMARY_KEYS),
    ...(bytes !== undefined ? { bytes } : {}),
  }
}

// `token` only as a whole segment, so rate-limit headers such as
// `x-ratelimit-remaining-tokens` stay readable.
const SENSITIVE_HEADER =
  /authorization|cookie|api[-_]?key|secret|signature|password|(^|[-_])token($|[-_])/i

/**
 * Request or response headers with credential-bearing values replaced by
 * `[redacted]`. Accepts a plain record or a `Headers` instance.
 */
export function redactHeadersForLog(
  headers: unknown,
): Record<string, unknown> | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined
  const entries: [string, unknown][] = []
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => entries.push([name, value]))
  } else {
    entries.push(...Object.entries(headers))
  }
  return Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      SENSITIVE_HEADER.test(name) ? '[redacted]' : value,
    ]),
  )
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * One field of a serialized error, redacted by name: an AI SDK `APICallError`
 * carries the whole request body and both header sets, and Bun's fetch errors
 * carry the request URL as `path`. Every error serializer (`getErrorObject`'s
 * raw dump, the Axiom and Convex-ingest log data) goes through this one
 * function, so a field redacted on one path cannot leak on another.
 */
export function redactErrorFieldForLog(key: string, val: unknown): unknown {
  if (key === 'requestBodyValues') return summarizeRequestBodyForLog(val)
  if (
    key === 'requestHeaders' ||
    key === 'responseHeaders' ||
    key === 'headers'
  ) {
    return redactHeadersForLog(val) ?? val
  }
  // `url` is always a URL; `path` is also a filesystem path on other errors,
  // so it is rewritten only when it is one.
  if (
    typeof val === 'string' &&
    (key === 'url' || (key === 'path' && URL_LIKE.test(val)))
  ) {
    return redactUrlForLog(val)
  }
  return val
}

// `<deployment>|<token>`: an admin key, and a deploy key's body after its
// `prod:`/`dev:`/`preview:<team>:<project>:` prefix. The name part is kept.
const CONVEX_KEY_AFTER_NAME = /(\b[A-Za-z0-9_.:-]+\|)[A-Za-z0-9+/=_.-]{20,}/g
// The token Convex mints for deploy keys and team/project access tokens is
// base64 JSON starting `{"v2":`, so it is recognisable without a name.
const CONVEX_V2_TOKEN = /eyJ2MiI6[A-Za-z0-9+/=_.-]*/g
// `CONVEX_DEPLOY_KEY=…` in a command line; `$(cat …)` is a reference, kept.
const CONVEX_KEY_ASSIGNMENT =
  /(\bCONVEX_[A-Z_]*(?:KEY|TOKEN)=)(['"]?)(?!\$)[^\s'"]+/g

/**
 * Text with every Convex credential replaced by `[redacted]`: deploy keys,
 * admin keys (`Authorization: Convex <deployment>|<token>`, and the URL the
 * Convex CLI echoes when handed one), bare access tokens, and
 * `CONVEX_*_KEY=`/`CONVEX_*_TOKEN=` assignments. The deployment name stays, as
 * it is what says which key would need rotating. For Convex Management API
 * response bodies, CLI output and error text bound for a log line.
 */
export function redactConvexKeysForLog(text: string): string {
  return text
    .replace(CONVEX_KEY_ASSIGNMENT, '$1$2[redacted]')
    .replace(CONVEX_KEY_AFTER_NAME, '$1[redacted]')
    .replace(CONVEX_V2_TOKEN, '[redacted]')
}

const QUERY_PARAMS_MARKER = '\nparams: '

/**
 * A drizzle `DrizzleQueryError` without its bound values. Drizzle writes every
 * param into `message` (and so into `stack`) as well as `params`, and the
 * values of an auth write are credentials: on 2026-10-19 freebuff-web logged a
 * Google access token and ID token from a failed `linkAccount` insert. The
 * statement and the `cause` holding the Postgres reason are kept; the params
 * become their count. Any other value is returned unchanged.
 */
export function redactQueryErrorForLog<T>(error: T): T {
  if (!(error instanceof Error)) return error
  const fields = error as Error & { query?: unknown; params?: unknown }
  if (typeof fields.query !== 'string' || !('params' in fields)) return error
  const marker = error.message.indexOf(QUERY_PARAMS_MARKER)
  const count = Array.isArray(fields.params) ? fields.params.length : 0
  const omitted = `[${count} params omitted]`
  const message =
    marker === -1
      ? error.message
      : `${error.message.slice(0, marker)}${QUERY_PARAMS_MARKER}${omitted}`
  const redacted = new Error(message, { cause: error.cause })
  Object.assign(redacted, error, { params: omitted })
  redacted.name = error.name
  redacted.stack =
    error.stack && error.stack.includes(error.message)
      ? error.stack.replace(error.message, () => message)
      : `${error.name}: ${message}`
  return redacted as T
}
