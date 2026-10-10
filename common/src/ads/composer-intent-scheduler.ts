/**
 * WHEN A CLIENT ASKS THE COMPOSER INTENT, shared by Desktop's composer pill
 * and the CLI's composer row so the two pace the server identically.
 *
 * The intent request (`intent: 'composer'`, see `partner-triggers.ts`) costs a
 * Perpetual Flash call on the server, so it is paced like a typeahead:
 *
 * - DEBOUNCED: a draft is asked about only once it has been idle for
 *   {@link COMPOSER_INTENT_IDLE_MS}, and only when it is at least
 *   {@link COMPOSER_INTENT_MIN_CHARS} characters.
 * - SINGLE-FLIGHT, WITH A TRAILING REQUEST: at most one request is in flight.
 *   A draft that settles meanwhile waits, and only the NEWEST such draft is
 *   sent once the current request returns. Nothing is aborted: the server has
 *   paid for the Flash call the moment the request lands.
 * - DEDUPED: a draft already answered is answered again from memory.
 * - NEVER STALE: an answer is shown only while it is the answer for the
 *   current draft. An answer for an older draft is remembered but not shown,
 *   and the shown answer stays put (no flicker) until a current one arrives.
 *   A draft cleared below the minimum hides the answer at once.
 */

export const COMPOSER_INTENT_IDLE_MS = 1_000
export const COMPOSER_INTENT_MIN_CHARS = 3
/**
 * The newest part of a draft a client sends. The server keeps only the newest
 * 6,000 characters of the whole conversation for Flash anyway.
 */
export const COMPOSER_INTENT_MAX_DRAFT_CHARS = 4_000
/** Answered drafts remembered per scheduler (one per conversation). */
const MAX_REMEMBERED = 32

export interface ComposerIntentScheduler {
  /** The draft changed. */
  update(draft: string): void
  /** Stop: no timer fires and no late answer is shown. */
  dispose(): void
}

export function createComposerIntentScheduler<Ad>(params: {
  /** One intent request for one draft; null on a no-fill or any failure. */
  request: (draft: string) => Promise<Ad | null>
  /** What to show now. Called with null when the draft is cleared. */
  onAnswer: (ad: Ad | null) => void
  idleMs?: number
  minChars?: number
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}): ComposerIntentScheduler {
  const idleMs = params.idleMs ?? COMPOSER_INTENT_IDLE_MS
  const minChars = params.minChars ?? COMPOSER_INTENT_MIN_CHARS
  const schedule =
    params.setTimeout ??
    ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms))
  const cancel =
    params.clearTimeout ??
    ((handle: unknown) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))

  const answered = new Map<string, Ad | null>()
  let current = ''
  let timer: unknown = null
  let inFlight = false
  let trailing: string | null = null
  let disposed = false

  const remember = (draft: string, ad: Ad | null) => {
    answered.delete(draft)
    answered.set(draft, ad)
    if (answered.size > MAX_REMEMBERED)
      answered.delete(answered.keys().next().value!)
  }

  const send = (draft: string) => {
    inFlight = true
    void params
      .request(draft)
      .catch(() => null)
      .then((ad) => {
        inFlight = false
        if (disposed) return
        remember(draft, ad)
        if (draft === current) params.onAnswer(ad)
        const next = trailing
        trailing = null
        if (next !== null && next === current) settle(next)
      })
  }

  /** A draft has been idle long enough to ask about. */
  const settle = (draft: string) => {
    if (answered.has(draft)) {
      params.onAnswer(answered.get(draft)!)
      return
    }
    if (inFlight) {
      trailing = draft
      return
    }
    send(draft)
  }

  return {
    update(draft) {
      if (disposed) return
      const next = draft.trim()
      if (next === current) return
      current = next
      if (timer !== null) cancel(timer)
      timer = null
      if (next.length < minChars) {
        trailing = null
        params.onAnswer(null)
        return
      }
      timer = schedule(() => {
        timer = null
        if (!disposed && current === next) settle(next)
      }, idleMs)
    },
    dispose() {
      disposed = true
      if (timer !== null) cancel(timer)
      timer = null
      trailing = null
    },
  }
}
