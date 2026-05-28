import type { FreebuffAccessTier } from '../constants/freebuff-models'

/**
 * Shapes used by `/api/v1/freebuff/session` and the CLI. Most variants are
 * wire-level responses serialized by the server; explicitly documented
 * compatibility variants may be synthesized by the CLI for older servers.
 */

/**
 * Usage counter surfaced to the CLI so the waiting-room UI can render
 * "N of M sessions used" alongside queue/active state. Present when the
 * joined model consumes premium Freebuff sessions. `recentCount` is the
 * rounded session units since the last midnight Pacific reset at the time
 * the response was produced — see also the standalone `rate_limited` status
 * for the reject path.
 */
export interface FreebuffSessionRateLimit {
  model: string
  limit: number
  period: 'pacific_day'
  resetTimeZone: string
  resetAt: string
  /** Deprecated wire field kept for older clients. Premium usage now resets
   *  at midnight Pacific time rather than using a rolling window. */
  windowHours: number
  recentCount: number
}

export type FreebuffSessionRateLimitByModel = Record<
  string,
  FreebuffSessionRateLimit
>

/** Pull the per-model premium quota snapshot off whichever session statuses
 *  carry it (queued, active, ended, none). Returns undefined for terminal /
 *  pre-join states that have no quota field. The parameter is intentionally
 *  loose so the CLI can pass its `FreebuffSessionResponse` (which adds the
 *  client-only `takeover_prompt` variant) without a discriminated-union
 *  ceremony at every call site. */
export const getRateLimitsByModel = (
  session: { status: string } | null | undefined,
): FreebuffSessionRateLimitByModel | undefined =>
  session && 'rateLimitsByModel' in session
    ? (session as { rateLimitsByModel?: FreebuffSessionRateLimitByModel })
        .rateLimitsByModel
    : undefined

export type FreebuffCountryBlockReason =
  | 'country_not_allowed'
  | 'anonymized_or_unknown_country'
  | 'anonymous_network'
  | 'missing_client_ip'
  | 'unresolved_client_ip'
  | 'ip_privacy_lookup_failed'

export type FreebuffIpPrivacySignal =
  | 'anonymous'
  | 'vpn'
  | 'proxy'
  | 'tor'
  | 'relay'
  | 'res_proxy'
  | 'hosting'
  | 'service'

export type FreebuffSpurStatus =
  | 'not_checked'
  | 'clean'
  | 'suspicious'
  | 'failed'

export type FreebuffScamalyticsStatus =
  | 'not_checked'
  | 'clean'
  | 'suspicious'
  | 'failed'

export type FreebuffPrivacyDecision =
  | 'allowed_clean'
  | 'ipinfo_suspicious_spur_clean'
  | 'corroborated_block'
  | 'cloudflare_tor_block'
  | 'spur_failed_limited'
  | 'scamalytics_failed_limited'
  | 'scamalytics_suspicious_limited'
  | 'ipinfo_failed_limited'
  | 'limited_other'

export type FreebuffPrivacyProviderDecision =
  | 'not_checked'
  | 'cloudflare_tor'
  | 'ipinfo_clean'
  | 'ipinfo_failed'
  | 'ipinfo_only'
  | 'spur_failed'
  | 'scamalytics_failed'
  | 'scamalytics_only'
  | 'corroborated_soft'
  | 'corroborated_hard'

export interface FreebuffLimitedModeReason {
  /** Present for limited access so the model picker can explain why the
   *  reduced model set is shown without re-running geo/IP logic locally. */
  countryCode?: string | null
  countryBlockReason?: FreebuffCountryBlockReason | null
  ipPrivacySignals?: FreebuffIpPrivacySignal[] | null
}

export type FreebuffSessionServerResponse =
  | {
      /** Compatibility fallback for older servers without the session
       *  endpoint. Client should treat this as "admitted forever". */
      status: 'disabled'
    }
  | ({
      /** User has no session row. CLI must POST to (re-)queue. Also returned
       *  when `getSessionState` notices the user has been swept past the
       *  grace window. */
      status: 'none'
      accessTier?: FreebuffAccessTier
      message?: string
      /** Snapshot of every model's queue depth at GET time. The picker no
       *  longer renders this (queues effectively never form at current
       *  traffic), but it's still surfaced for diagnostics and future use.
       *  Present on GET responses; not returned from POST (POST never
       *  produces `none`). */
      queueDepthByModel?: Record<string, number>
      /** Current quota snapshots for premium models, keyed by model id. Lets
       *  the picker show today's premium-session usage before the user commits
       *  to a queue. */
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
    } & FreebuffLimitedModeReason)
  | ({
      status: 'queued'
      accessTier: FreebuffAccessTier
      instanceId: string
      /** Model the user is queued for. Each model has its own queue. */
      model: string
      /** 1-indexed position in the queue for `model`. */
      position: number
      queueDepth: number
      /** Current depth of every model's queue. Retained for diagnostics —
       *  the CLI no longer renders per-row queue hints. Models with no
       *  queued rows at snapshot time may be absent; treat a missing entry
       *  as 0. */
      queueDepthByModel: Record<string, number>
      estimatedWaitMs: number
      queuedAt: string
      /** Premium-session quota for this model. Absent for unlimited models. */
      rateLimit?: FreebuffSessionRateLimit
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
    } & FreebuffLimitedModeReason)
  | ({
      status: 'active'
      accessTier: FreebuffAccessTier
      instanceId: string
      /** Model the active session is bound to — cannot change mid-session. */
      model: string
      admittedAt: string
      expiresAt: string
      remainingMs: number
      /** Premium-session quota for this model. Absent for unlimited models. */
      rateLimit?: FreebuffSessionRateLimit
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
    } & FreebuffLimitedModeReason)
  | ({
      /** Session is over. While `instanceId` is present we're inside the
       *  server-side grace window — chat requests still go through so the
       *  agent can finish, but the CLI must not accept new prompts. Once
       *  `instanceId` is absent the session is fully gone and the user must
       *  rejoin via POST.
       *
       *  Server-supplied form (in-grace) carries the timing fields; the
       *  client may also synthesize a no-grace `{ status: 'ended' }` when a
       *  poll reveals the row was swept. Both render the same UI. */
      status: 'ended'
      accessTier?: FreebuffAccessTier
      instanceId?: string
      admittedAt?: string
      expiresAt?: string
      gracePeriodEndsAt?: string
      gracePeriodRemainingMs?: number
      /** Snapshot of the user's premium-session quota at the moment the
       *  session ended. Lets the post-session banner show "N of M premium
       *  sessions used today" without an extra round-trip. */
      rateLimitsByModel?: FreebuffSessionRateLimitByModel
    } & FreebuffLimitedModeReason)
  | {
      /** Another CLI on the same account rotated our instance id. Polling
       *  stops and the UI shows a "close the other CLI" screen. The server
       *  returns this from GET /session when the caller's instance id
       *  doesn't match the stored one; the chat-completions gate also
       *  surfaces it as a 409 for fast in-flight feedback. */
      status: 'superseded'
    }
  | {
      /** Request originated outside the free-mode allowlist, or from an
       *  unknown/anonymized location that cannot be trusted for free mode.
       *  Returned before queue admission so users don't wait through the
       *  room only to be rejected on their first chat request. Terminal —
       *  CLI stops polling and shows a "not available in your country"
       *  screen. `countryCode` is the resolved country, or UNKNOWN. */
      status: 'country_blocked'
      message?: string
      countryCode: string
      countryBlockReason?: FreebuffCountryBlockReason
      ipPrivacySignals?: FreebuffIpPrivacySignal[]
    }
  | {
      /** User has an active session bound to a different model. Returned
       *  from POST /session when they pick a new model without ending their
       *  current session first. The CLI shows a confirmation prompt: "End
       *  your active DeepSeek session to switch?" → on confirm, DELETE then
       *  re-POST with the new model. */
      status: 'model_locked'
      accessTier?: FreebuffAccessTier
      currentModel: string
      requestedModel: string
    }
  | {
      /** Requested model is valid but not selectable right now. */
      status: 'model_unavailable'
      accessTier?: FreebuffAccessTier
      requestedModel: string
      availableHours: string
    }
  | {
      /** Account is banned. Returned from every endpoint so banned bots can't
       *  join the queue at all (otherwise they inflate `queueDepth` until the
       *  15s admission tick's `evictBanned` sweeps them). Terminal — CLI
       *  stops polling and shows a banned message. */
      status: 'banned'
    }
  | {
      /** User has used up their shared premium-session quota for the current
       *  Pacific day. Returned from POST /session before the user is placed in
       *  the queue. `retryAfterMs` is the time until the next midnight Pacific
       *  reset. Terminal for the CLI's current poll session; the user can exit
       *  and come back later. */
      status: 'rate_limited'
      accessTier?: FreebuffAccessTier
      /** The freebuff model the user tried to join. */
      model: string
      /** Max premium session units permitted per Pacific day (e.g. 5). */
      limit: number
      period: 'pacific_day'
      resetTimeZone: string
      resetAt: string
      /** Deprecated wire field kept for older clients. */
      windowHours: number
      /** Premium session units since today's Pacific reset — will be ≥ limit. */
      recentCount: number
      /** Milliseconds from now until the next Pacific midnight reset. */
      retryAfterMs: number
    }
