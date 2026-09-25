/**
 * An optional pointer from an ad request to the agent conversation that
 * prompted it: two opaque ids, never any conversation text.
 *
 * - `traceSessionId` is the SDK's per-conversation trace id (`RunState`'s
 *   `traceSessionId`), shared by every run of that conversation.
 * - `previousRunId` is the id of the last run that COMPLETED before the
 *   request, when there is one. The run for the prompt being answered starts
 *   after the request is sent, so its own id is not known yet; the next run
 *   in the same trace session after `previousRunId` (or the session's first
 *   run, when absent) is the one that carries the prompt.
 *
 * Both are optional on the wire and read leniently: a malformed or oversized
 * value is dropped, never a reason to refuse the ad request.
 */

export type AdTraceContext = {
  traceSessionId: string
  previousRunId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value)
    ? value.toLowerCase()
    : null
}

/**
 * The trace context carried by a request body's `traceContext`, or null when
 * absent or unusable. A `previousRunId` alone points at nothing, so it is
 * dropped without a valid `traceSessionId`.
 */
export function parseAdTraceContext(value: unknown): AdTraceContext | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const traceSessionId = uuidOrNull(record.traceSessionId)
  if (!traceSessionId) return null
  const previousRunId = uuidOrNull(record.previousRunId)
  return previousRunId ? { traceSessionId, previousRunId } : { traceSessionId }
}

/**
 * The client side: the context for a conversation whose SDK state is
 * `runState` (an opaque harness state that may be anything). Null when it
 * carries no usable trace session.
 */
export function adTraceContextFromRunState(
  runState: unknown,
  fallbackTraceSessionId?: string,
): AdTraceContext | null {
  const state =
    typeof runState === 'object' && runState !== null
      ? (runState as {
          traceSessionId?: unknown
          sessionState?: { mainAgentState?: { runId?: unknown } }
        })
      : undefined
  return parseAdTraceContext({
    traceSessionId: state?.traceSessionId ?? fallbackTraceSessionId,
    previousRunId: state?.sessionState?.mainAgentState?.runId,
  })
}
