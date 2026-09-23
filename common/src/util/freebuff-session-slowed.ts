/**
 * The completions route's word that a free-mode session is being paced past its
 * target: an SSE comment ending each step once the session's settled spend has
 * crossed it, giving the NEXT step's pause before that pause starts. The server
 * writes it and the SDK reads it through here.
 */
export interface FreebuffSessionSlowed {
  instanceId: string
  delayMs: number
}

/** An SSE comment, so clients that do not look for it ignore it. */
const NOTICE_PREFIX = ': freebuff-session-slowed '

export function sessionSlowedNotice(slowed: FreebuffSessionSlowed): string {
  return `${NOTICE_PREFIX}${JSON.stringify(slowed)}\n\n`
}

/** One SSE line; anything but a well-formed notice is null. */
export function parseSessionSlowedNotice(
  line: string,
): FreebuffSessionSlowed | null {
  if (!line.startsWith(NOTICE_PREFIX)) return null
  try {
    const { instanceId, delayMs } = JSON.parse(line.slice(NOTICE_PREFIX.length))
    return typeof instanceId === 'string' &&
      typeof delayMs === 'number' &&
      delayMs > 0
      ? { instanceId, delayMs }
      : null
  } catch {
    return null
  }
}
