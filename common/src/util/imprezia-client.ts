import {
  IMPREZIA_LIMITS,
  impreziaBaseUrlForKey,
  impreziaChatAdResponseSchema,
  isImpreziaSandboxKey,
} from './imprezia-ad'

import {
  IMPREZIA_DISPLAY_ORIGIN,
  toImpreziaDisplayAd,
} from './imprezia-display'

import type { ImpreziaAd, ImpreziaDeviceContext } from './imprezia-ad'
import type {
  ImpreziaDisplayAd,
  ImpreziaDisplayRequest,
} from './imprezia-display'
import type { Logger } from '../types/contracts/logger'

/**
 * The one way we call Imprezia's chat-ads API.
 *
 * Two callers reach it from opposite directions — the web chat, which knows
 * the exact turn and the real viewport, and the CLI/Desktop ad provider, which
 * infers a turn from a rolling message list and has no viewport at all. What
 * they have in common is the whole transport: same path, same key header, same
 * forwarded user agent, same timeout, same 403-means-account-not-enabled, same
 * response schema. Only the inputs and what each does with the ad differ.
 *
 * Server-only by convention (it takes the publisher key), which is why it is
 * separate from the isomorphic contract module the browser renderer imports.
 *
 * Every failure is a no-ad path. The reply is already on the user's screen by
 * the time this runs, so an ad-network problem must never surface or delay
 * anything.
 */

const CHAT_ADS_PATH = '/v1/ads/chat'
const DISPLAY_ADS_PATH = '/v1/display'

/** Ad decisioning is off the critical path but holds a socket; cap it well
 *  under the browser's own patience. */
const REQUEST_TIMEOUT_MS = 5_000

/**
 * The sandbox-key refusal below is a CONFIGURATION state, not an event: while a
 * sandbox key is set in production it is true of every request, forever, until
 * someone swaps the key. Logging it per call turned one wrong env var into 1.06M
 * error rows on 2026-08-23 and 1.30M on 2026-08-24 — around 70% of all
 * error-level ingest, which Axiom bills on — and buried every real error on the
 * service underneath it. Say it once per process, then drop to debug: bounded by
 * pod count instead of by traffic, and still loud enough to find.
 */
let sandboxRefusalLogged = false

export type ImpreziaChatAdRequest = {
  /** Current user message, verbatim. */
  request: string
  /** Completed assistant reply for the same turn. */
  response: string
  sessionId: string
  /** ISO-8601 instant the TURN completed — not when we send this. */
  timestamp: string
  /** Origin + path, already stripped of query/fragment. */
  sourceUrl: string
  surface: 'desktop' | 'cli' | 'cloud' | 'web' | 'chat' | 'mobile'
  /** Imprezia platform family; product attribution lives in `surface`. */
  platformString: string
  deviceContext: ImpreziaDeviceContext
}

export type ImpreziaChatAdResult = {
  /** Support/reconciliation key. Present even on no-fill. */
  requestId: string
  ad: ImpreziaAd | null
}

/** Bounded request outcome for aggregate serving telemetry. */
export type ImpreziaChatAdOutcome =
  | 'fill'
  | 'no_fill'
  | 'timeout'
  | 'provider_error'

export type ImpreziaChatAdOutcomeObserver = (
  outcome: ImpreziaChatAdOutcome,
) => void

function observeOutcome(
  observer: ImpreziaChatAdOutcomeObserver | undefined,
  outcome: ImpreziaChatAdOutcome,
): void {
  try {
    observer?.(outcome)
  } catch {
    // Telemetry must never alter serving behavior.
  }
}

/**
 * The sandbox-key refusal, shared by both endpoints.
 *
 * Returns true when the caller must not serve. See the comment on
 * `sandboxRefusalLogged` for why this is logged once per process.
 */
function refusesSandboxKey(params: {
  apiKey: string
  testMode: boolean
  allowSandbox: boolean | undefined
  logger: Logger
}): boolean {
  const { apiKey, testMode, allowSandbox, logger } = params
  if (!isImpreziaSandboxKey(apiKey) || testMode || allowSandbox) return false

  const refusal =
    '[ads:imprezia] Refusing to serve: sandbox key in production. Swap in ' +
    'an api_pub_prod_ key before this can fill.'
  if (sandboxRefusalLogged) {
    logger.debug(refusal)
  } else {
    sandboxRefusalLogged = true
    logger.error(refusal)
  }
  return true
}

/**
 * POST to Imprezia and hand back the decoded body, or null on any failure.
 *
 * Both ad endpoints share this whole transport — key header, forwarded user
 * agent, timeout, 403-means-account-not-enabled, and the rule that every
 * failure is a no-ad path rather than an error anyone sees. Keeping it in one
 * place is what stops the two drifting as either contract moves.
 */
async function postToImprezia(params: {
  url: string
  apiKey: string
  userAgent: string
  /** Only the display API needs this; chat is not origin-gated. */
  origin?: string
  body: unknown
  /** Named in the 403 log, which is about account state, not code. */
  productLabel: string
  signal?: AbortSignal
  onFailure?: (outcome: 'timeout' | 'provider_error') => void
  logger: Logger
  fetch: typeof globalThis.fetch
  // `null` means the request never produced a response; a 2xx returns its
  // decoded body WRAPPED, because that body may legitimately be `null` and the
  // caller has to tell the two apart. Imprezia answered 200 with an
  // unparseable body for nine hours on 2026-08-26, and the schema mismatch the
  // caller logs from it is the only reason anyone noticed.
}): Promise<{ status: number; body: unknown } | null> {
  const {
    url,
    apiKey,
    userAgent,
    origin,
    body,
    productLabel,
    signal,
    onFailure,
    logger,
    fetch,
  } = params

  // `baseUrl` is what these two logs have always carried, and dashboards and
  // ad-hoc queries key on it; `url` is added beside it rather than replacing
  // it, because with two endpoints the path is now the interesting part.
  const baseUrl = new URL(url).origin

  const controller = new AbortController()
  let abortedByCaller = false
  const abortFromCaller = () => {
    abortedByCaller = true
    controller.abort()
  }
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        // Imprezia targets and measures off this; sending our runtime's UA
        // would look like datacenter traffic and be discounted as invalid.
        'X-Forwarded-User-Agent': userAgent,
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      // A publisher account not switched on for this product 403s on every
      // single request. That is an account-state problem with an account-side
      // fix, not a bug to chase in the logs, so name it rather than burying it.
      if (response.status === 403) {
        logger.warn(
          { baseUrl, url },
          `[ads:imprezia] Publisher is not enabled for ${productLabel}; no ad ` +
            'will fill until Imprezia enables the account for this key',
        )
        onFailure?.('provider_error')
        return null
      }
      // WITH THE BODY, truncated. Without it the line says only "400" and the
      // cause is unknowable from the logs: on 2026-09-07 this fired ~270 times
      // an hour for weeks and nobody could say why, because every field we
      // logged was one we already knew. Imprezia's error bodies name the
      // rejected field. Read defensively — a body that stalls or is already
      // consumed must not turn a failed ad fetch into a failed turn — and
      // capped, because this is a third party's string in our logs.
      const detail = await response
        .text()
        .then((text) => text.slice(0, 300))
        .catch(() => null)
      logger.error(
        { baseUrl, url, status: response.status, detail },
        '[ads:imprezia] API returned error',
      )
      onFailure?.('provider_error')
      return null
    }

    return {
      status: response.status,
      // Keep the deadline and caller cancellation listener alive until the
      // body is consumed. `fetch` resolves once headers arrive, while an
      // Imprezia response body may still stall indefinitely.
      body:
        response.status === 204
          ? null
          : await response.json().catch((error) => {
              if (
                controller.signal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
              ) {
                throw error
              }
              // Keep malformed JSON on the established schema-error path.
              return null
            }),
    }
  } catch (error) {
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    logger.warn(
      abortedByCaller
        ? { baseUrl, url, timedOut: true, abortSource: 'caller' }
        : { baseUrl, url, timedOut: aborted, error },
      aborted
        ? '[ads:imprezia] Ad request timed out'
        : '[ads:imprezia] Ad request failed',
    )
    onFailure?.(aborted ? 'timeout' : 'provider_error')
    return null
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function fetchImpreziaChatAd(params: {
  apiKey: string
  request: ImpreziaChatAdRequest
  /** The END USER's UA, forwarded verbatim. Never our HTTP client's. */
  userAgent: string
  /** False in production. A sandbox key must not serve real users. */
  testMode: boolean
  /** Serve sandbox creatives in production; see the guard below. */
  allowSandbox?: boolean
  /** Optional caller deadline combined with the client's five-second cap. */
  signal?: AbortSignal
  /** Optional bounded observer; it cannot affect the ad decision. */
  onOutcome?: ImpreziaChatAdOutcomeObserver
  logger: Logger
  fetch: typeof globalThis.fetch
}): Promise<ImpreziaChatAdResult | null> {
  const {
    apiKey,
    request,
    userAgent,
    testMode,
    allowSandbox,
    signal,
    onOutcome,
    logger,
    fetch,
  } = params
  const baseUrl = impreziaBaseUrlForKey(apiKey)

  // Both halves are required and must be non-empty. A turn with an empty reply
  // (aborted mid-stream) is not an ad opportunity.
  if (!request.request.trim() || !request.response.trim()) {
    logger.debug('[ads:imprezia] Skipping turn with an empty message')
    observeOutcome(onOutcome, 'provider_error')
    return null
  }

  // A sandbox key serves Imprezia's own house ad ("Developers. Earn money with
  // your AI app."), rendered exactly like a paid one — so someone who did not
  // ask for it cannot tell it from a real advertiser. Asking for it by name is
  // the whole opt-in.
  if (refusesSandboxKey({ apiKey, testMode, allowSandbox, logger })) {
    observeOutcome(onOutcome, 'provider_error')
    return null
  }

  const response = await postToImprezia({
    url: `${baseUrl}${CHAT_ADS_PATH}`,
    apiKey,
    userAgent,
    productLabel: 'chat ads',
    signal,
    onFailure: (outcome) => observeOutcome(onOutcome, outcome),
    logger,
    fetch,
    body: {
      ...request,
      request: request.request.slice(0, IMPREZIA_LIMITS.request),
      response: request.response.slice(0, IMPREZIA_LIMITS.response),
      sessionId: request.sessionId.slice(0, IMPREZIA_LIMITS.sessionId),
    },
  })
  if (!response) return null
  if (response.status === 204) {
    observeOutcome(onOutcome, 'no_fill')
    return null
  }

  const parsed = impreziaChatAdResponseSchema.safeParse(response.body)
  if (!parsed.success) {
    logger.error(
      { baseUrl, issues: parsed.error.issues },
      '[ads:imprezia] API response did not match the expected shape',
    )
    observeOutcome(onOutcome, 'provider_error')
    return null
  }

  const { requestId, ad } = parsed.data
  if (!ad) {
    // No-fill is the common case, not an error. Log the requestId anyway: it
    // is the reconciliation key Imprezia support asks for, and the only handle
    // we have on a serve that produced nothing.
    logger.debug({ requestId }, '[ads:imprezia] No ad fill')
    observeOutcome(onOutcome, 'no_fill')
    return { requestId, ad: null }
  }

  logger.info(
    {
      requestId,
      impressionUuid: ad.impression.impressionUuid,
      brandName: ad.creative.brandName,
      // Whether the demand attached third-party measurement, and in which
      // channel. Without this we cannot tell "the partner sent no trackers"
      // from "we dropped them", which is exactly the question that gets asked
      // when an advertiser reports missing impressions.
      trackerChannels: ad.trackers
        ? [
            ad.trackers.impressionFrameUrl
              ? 'impression:frame'
              : ad.trackers.impression?.length
                ? 'impression:pixels'
                : null,
            ad.trackers.viewabilityFrameUrl
              ? 'mrc50:frame'
              : ad.trackers.mrc50?.length
                ? 'mrc50:pixels'
                : null,
          ].filter(Boolean)
        : [],
    },
    '[ads:imprezia] Ad filled',
  )
  observeOutcome(onOutcome, 'fill')
  return { requestId, ad }
}

/**
 * Ask for a display ad for one slot.
 *
 * No conversation is involved, which is the whole point: this is the only
 * Imprezia product a screen with no chat on it can fill from.
 */
export async function fetchImpreziaDisplayAd(params: {
  apiKey: string
  request: ImpreziaDisplayRequest
  /** The END USER's UA, forwarded verbatim. Never our HTTP client's. */
  userAgent: string
  testMode: boolean
  allowSandbox?: boolean
  logger: Logger
  fetch: typeof globalThis.fetch
}): Promise<{ requestId: string; ad: ImpreziaDisplayAd | null } | null> {
  const { apiKey, request, userAgent, testMode, allowSandbox, logger, fetch } =
    params

  if (refusesSandboxKey({ apiKey, testMode, allowSandbox, logger })) return null

  const response = await postToImprezia({
    url: `${impreziaBaseUrlForKey(apiKey)}${DISPLAY_ADS_PATH}`,
    apiKey,
    userAgent,
    // Without this the API answers 403 origin_not_allowed; it is built for
    // the browser SDK and expects the header a browser would have sent.
    origin: IMPREZIA_DISPLAY_ORIGIN,
    productLabel: 'display ads',
    logger,
    fetch,
    body: {
      ...request,
      sessionId: request.sessionId?.slice(0, IMPREZIA_LIMITS.sessionId),
    },
  })
  if (!response) return null

  const result = toImpreziaDisplayAd(response.body)
  if (!result) {
    logger.error(
      '[ads:imprezia] Display response did not match the expected shape',
    )
    return null
  }

  if (!result.ad) {
    logger.debug(
      { requestId: result.requestId },
      '[ads:imprezia] No display fill',
    )
    return result
  }

  logger.info(
    {
      requestId: result.requestId,
      impressionUuid: result.ad.impressionUuid,
      slotId: request.slotId,
      brandName: result.ad.brandName,
    },
    '[ads:imprezia] Display ad filled',
  )
  return result
}
