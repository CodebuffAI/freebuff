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
