/**
 * How many copies of the *same* exception we are willing to send to PostHog.
 *
 * WHY THIS EXISTS: nothing between "client code throws" and "PostHog bills us"
 * was bounded. Every `logger.error` in the CLI captures an exception
 * (cli/src/utils/logger.ts `logAsErrorIfNeeded`), and posthog-node's
 * `enableExceptionAutocapture` turns every uncaught error and unhandled
 * rejection in the CLI and Desktop into one more, so a client stuck in a retry
 * loop bills one exception per iteration, forever. On 2026-08-26 that produced
 * 1,090,609 exceptions against a ~30k/day baseline — and it was invisible in
 * Axiom, because the log shippers on those surfaces DO drop under load
 * (cli/src/utils/log-shipper.ts keeps 1,000 records and shifts out the oldest).
 *
 * A geometric ladder rather than a rate limit: a rate limit spends its budget
 * on whichever error is loudest, while a ladder keeps the FIRST sighting of
 * every distinct error — the one that says "this is new" — and still collapses
 * a million repeats into seven events. Nothing is hidden: the counts
 * move from rows onto `$exception_occurrence`.
 */

/** Distinct exceptions one process tracks before it stops opening buckets.
 *  Guards the other failure shape: one cause minified into many fingerprints
 *  (a version-skew "x is not a function" produced 74 of them), where the
 *  ladder alone would still send a first sighting for each. */
const MAX_DISTINCT_FINGERPRINTS = 200

/** The event shape both posthog-node (`EventMessage`) and posthog-js
 *  (`CaptureResult`) satisfy — event name plus a mutable property bag. */
export type ExceptionBudgetEvent = {
  event?: string | null
  properties?: Record<string, any> | null
}

/** Generic in the event type so one filter can be each library's own
 *  `before_send` without widening what those callers get back. */
export type ExceptionBeforeSend = <T extends ExceptionBudgetEvent>(
  event: T | null,
) => T | null

/**
 * Identify an exception by type and message, truncated so a stack-shaped
 * message can't grow the map by kilobytes per distinct error.
 *
 * Deliberately NOT by stack: the same bug reached from two call sites is one
 * problem to us, and minified frames differ per build, which would defeat the
 * ladder on exactly the long-running loops it is for.
 *
 * Both libraries hand `before_send` a fully built `$exception_list` of
 * `{type, value}`, and both stringify `value` first — a promise rejected with
 * an object arrives as "Object captured as exception with keys: …", so
 * distinct non-Error rejections still land in distinct buckets.
 */
function fingerprint(
  properties: Record<string, any> | null | undefined,
): string {
  const list = properties?.$exception_list
  const first = Array.isArray(list) ? list[0] : undefined
  const type = typeof first?.type === 'string' ? first.type : 'Error'
  return `${type}: ${String(first?.value ?? '')}`.slice(0, 300)
}

/** True for the occurrences we send: 1, 10, 100, 1000, … The gaps grow the way
 *  the problem does, so a loop that ends early is still reported at roughly the
 *  order of magnitude it reached. */
function isReportedOccurrence(occurrence: number): boolean {
  let remaining = occurrence
  while (remaining % 10 === 0) remaining /= 10
  return remaining === 1
}

/**
 * A `before_send` filter that applies the budget to `$exception` events, per
 * process, and passes everything else through untouched.
 *
 * Suppressed events are dropped by returning null, which both libraries treat
 * as "never happened" — posthog-node's capture paths catch the resulting
 * rejection, so a dropped exception cannot itself become an unhandled
 * rejection that autocapture would bill us for.
 */
export function createExceptionBeforeSend(): ExceptionBeforeSend {
  const counts = new Map<string, number>()

  return (event) => {
    if (!event || event.event !== '$exception') return event

    const key = fingerprint(event.properties)
    const seen = counts.get(key)
    // Over the distinct cap we neither send nor remember: remembering would let
    // fingerprint churn grow the map without bound, which is what it guards.
    if (seen === undefined && counts.size >= MAX_DISTINCT_FINGERPRINTS) {
      return null
    }
    const occurrence = (seen ?? 0) + 1
    counts.set(key, occurrence)
    if (!isReportedOccurrence(occurrence)) return null

    // Stamp the real count on what we do send, so a suppressed loop reads as
    // "this happened 100,000 times" rather than as a handful of stray errors.
    if (event.properties) {
      event.properties.$exception_occurrence = occurrence
    }
    return event
  }
}
