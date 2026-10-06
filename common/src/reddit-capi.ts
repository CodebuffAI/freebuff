import { createHash } from 'node:crypto'

import { IS_PROD } from '@codebuff/common/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { RedditCapiEventName } from '@codebuff/common/util/reddit-capi-events'

export type { RedditCapiEventName }

/** Reddit Ads pixel ID (public, also used for CAPI endpoint). */
export const REDDIT_PIXEL_ID = 'a2_j6o59svbxzzn'

const REDDIT_CAPI_ENDPOINT = `https://ads-api.reddit.com/api/v3/pixels/${REDDIT_PIXEL_ID}/conversion_events`

export type RedditActionSource = 'WEBSITE' | 'APP' | 'PHYSICAL_STORE' | 'OTHER'

export type RedditCapiUser = {
  email?: string | null
  externalId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  clickId?: string | null
  uuid?: string | null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  const atIndex = normalized.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return normalized
  }
  const local = normalized.slice(0, atIndex)
  const domain = normalized.slice(atIndex + 1)
  return `${local.split('+')[0]?.replaceAll('.', '')}@${domain}`
}

export function buildRedditCapiUserPayload(user: RedditCapiUser) {
  const payload: Record<string, string> = {}

  if (user.email) {
    payload.email = sha256(normalizeEmail(user.email))
  }
  if (user.externalId) {
    payload.external_id = sha256(user.externalId.trim())
  }
  if (user.ipAddress) {
    payload.ip_address = user.ipAddress
  }
  if (user.userAgent) {
    payload.user_agent = user.userAgent
  }
  if (user.uuid) {
    payload.uuid = user.uuid
  }

  return Object.keys(payload).length > 0 ? payload : undefined
}

export type SendRedditCustomConversionParams = {
  /** Conversion access token from Reddit Events Manager (env-provided; no-op when unset). */
  accessToken: string | undefined
  customEventName: RedditCapiEventName
  conversionId: string
  actionSource: RedditActionSource
  eventAt?: number
  eventSourceUrl?: string
  testId?: string
  user: RedditCapiUser
  fetchImpl?: typeof fetch
  logger?: Logger
  enabled?: boolean
  sleepImpl?: (ms: number) => Promise<void>
}

export type RedditCapiDeliveryResult = 'sent' | 'disabled'

export class RedditCapiDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RedditCapiDeliveryError'
  }
}

function eventSourceUrlWithClickId(
  eventSourceUrl: string | undefined,
  clickId: string | null | undefined,
): string | undefined {
  if (!eventSourceUrl || !clickId) return eventSourceUrl
  try {
    const url = new URL(eventSourceUrl)
    if (!url.searchParams.has('rdt_cid')) {
      url.searchParams.set('rdt_cid', clickId)
    }
    return url.toString()
  } catch {
    return eventSourceUrl
  }
}

export function buildRedditCustomConversionBody(
  params: Pick<
    SendRedditCustomConversionParams,
    | 'customEventName'
    | 'conversionId'
    | 'actionSource'
    | 'eventAt'
    | 'eventSourceUrl'
    | 'testId'
    | 'user'
  >,
) {
  const user = buildRedditCapiUserPayload(params.user)
  const eventSourceUrl = eventSourceUrlWithClickId(
    params.eventSourceUrl,
    params.user.clickId,
  )

  return {
    data: {
      ...(params.testId ? { test_id: params.testId } : {}),
      events: [
        {
          event_at: params.eventAt ?? Date.now(),
          action_source: params.actionSource,
          ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
          type: {
            tracking_type: 'CUSTOM',
            custom_event_name: params.customEventName,
          },
          ...(params.user.clickId ? { click_id: params.user.clickId } : {}),
          metadata: {
            conversion_id: params.conversionId,
          },
          ...(user ? { user } : {}),
        },
      ],
    },
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Deliver one custom event, retrying one transient failure. */
export async function sendRedditCustomConversion(
  params: SendRedditCustomConversionParams,
): Promise<RedditCapiDeliveryResult> {
  if (!(params.enabled ?? IS_PROD) || !params.accessToken) {
    return 'disabled'
  }

  const fetchImpl = params.fetchImpl ?? fetch
  const body = buildRedditCustomConversionBody(params)
  const sleepImpl = params.sleepImpl ?? sleep

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(REDDIT_CAPI_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'freebuff/1.0 (reddit-capi)',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      })
      if (response.ok) {
        params.logger?.info(
          {
            customEventName: params.customEventName,
            conversionId: params.conversionId,
            attempt,
          },
          'Reddit CAPI conversion delivered',
        )
        return 'sent'
      }

      const responseBody = (await response.text().catch(() => '')).slice(0, 500)
      if (attempt === 1 && isRetryableStatus(response.status)) {
        await sleepImpl(100)
        continue
      }
      throw new RedditCapiDeliveryError(
        `Reddit CAPI rejected ${params.customEventName} (${response.status}): ${responseBody}`,
        response.status,
      )
    } catch (error) {
      if (
        attempt === 1 &&
        (!(error instanceof RedditCapiDeliveryError) ||
          (error.status !== undefined && isRetryableStatus(error.status)))
      ) {
        await sleepImpl(100)
        continue
      }
      params.logger?.warn(
        {
          error,
          customEventName: params.customEventName,
          conversionId: params.conversionId,
          attempt,
        },
        'Reddit CAPI conversion request failed',
      )
      if (error instanceof RedditCapiDeliveryError) throw error
      throw new RedditCapiDeliveryError(
        `Reddit CAPI request failed for ${params.customEventName}`,
      )
    }
  }

  throw new RedditCapiDeliveryError(
    `Reddit CAPI request failed for ${params.customEventName}`,
  )
}

export function redditConversionId(
  event: RedditCapiEventName,
  userId: string,
): string {
  return sha256(`${event}:${userId}`)
}

/**
 * Identity fields shared by every server-side Reddit conversion call, built
 * from the incoming request's headers. Surface-specific attribution (click id,
 * uuid) is layered on by callers that have it.
 *
 * The IP is resolved by the caller, from an edge-verified source, and passed
 * in. It is never read from `x-real-ip` or the leftmost `x-forwarded-for`
 * entry here: both pass through Cloudflare from the caller, so they would let
 * a caller choose what we tell Reddit about them.
 */
export function redditUserFromRequestHeaders(params: {
  userId: string
  email?: string | null
  ipAddress?: string | null
  headers: { get(name: string): string | null }
}): RedditCapiUser {
  return {
    email: params.email,
    externalId: params.userId,
    ipAddress: params.ipAddress || undefined,
    userAgent: params.headers.get('user-agent')?.trim() || undefined,
  }
}
