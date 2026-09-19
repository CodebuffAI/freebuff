import { createHash } from 'node:crypto'

import {
  isMetaConversionValue,
  type MetaConversionEventName,
  type MetaConversionValue,
} from './util/meta-conversions'

// Verified against Meta's official facebook-nodejs-business-sdk/src/api.js.
export const META_GRAPH_API_VERSION = 'v26.0'

export type MetaConversionAttribution = {
  fbc?: string
  fbp?: string
  /** Unsalted SHA-256 of the trimmed, lowercased account email (Meta's `em`). */
  hashedEmail?: string
  /** Client address resolved at enrollment, sent as `client_ip_address`. */
  ipAddress?: string
  /** Enrollment browser agent, sent as `client_user_agent` on every event. */
  userAgent: string
}

export function metaExternalId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex')
}

export function metaConversionId(
  eventName: MetaConversionEventName,
  userId: string,
): string {
  return createHash('sha256')
    .update(`meta-capi:${eventName}:${userId}`)
    .digest('hex')
}

export type SendMetaConversionParams = {
  pixelId: string
  accessToken: string
  eventName: MetaConversionEventName
  eventId: string
  eventAt: Date
  userId: string
  attribution: MetaConversionAttribution
  surface: 'web' | 'desktop' | 'cli'
  conversionValue?: MetaConversionValue
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  /** Rechecked immediately before every network attempt, including retries. */
  canSend?: () => Promise<boolean>
}

export function buildMetaConversionBody(params: SendMetaConversionParams) {
  if (
    params.eventName === 'Subscribe' &&
    !isMetaConversionValue(params.conversionValue)
  ) {
    throw new Error('Subscribe requires a positive confirmed USD payment')
  }
  const { attribution } = params
  return {
    data: [
      {
        event_name: params.eventName,
        event_id: params.eventId,
        event_time: Math.floor(params.eventAt.getTime() / 1000),
        // A desktop/CLI activation is not a website conversion or a mobile app
        // SDK event. Keep its source honest even when enrollment was on the web.
        action_source: params.surface === 'web' ? 'website' : 'other',
        ...(params.surface === 'web'
          ? { event_source_url: 'https://freebuff.com/' }
          : {}),
        // Every key below identifies the PERSON, not the event's own network
        // hop, so the enrollment browser's agent and address ride on native
        // events too. Match quality is what decides whether Meta can tie a
        // conversion back to the ad; measured 4.7/10 with fbp+external_id only.
        user_data: {
          external_id: [metaExternalId(params.userId)],
          ...(attribution.hashedEmail ? { em: [attribution.hashedEmail] } : {}),
          ...(attribution.fbc ? { fbc: attribution.fbc } : {}),
          ...(attribution.fbp ? { fbp: attribution.fbp } : {}),
          ...(attribution.ipAddress
            ? { client_ip_address: attribution.ipAddress }
            : {}),
          client_user_agent: attribution.userAgent,
        },
        custom_data: {
          surface: params.surface,
          ...(params.eventName === 'Subscribe' ? params.conversionValue : {}),
        },
      },
    ],
  }
}

/** Two bounded attempts; callers retain the claim for later retries. No PII/token logs. */
export async function sendMetaConversion(
  params: SendMetaConversionParams,
): Promise<'sent' | 'suppressed'> {
  if (!/^\d+$/.test(params.pixelId)) throw new Error('Invalid Meta dataset ID')
  const fetchImpl = params.fetchImpl ?? fetch
  const sleep =
    params.sleepImpl ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const body = JSON.stringify(buildMetaConversionBody(params))
  for (let attempt = 0; attempt < 2; attempt++) {
    if (params.canSend && !(await params.canSend())) return 'suppressed'
    let retry = false
    try {
      const response = await fetchImpl(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${params.pixelId}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(3_000),
        },
      )
      if (response.ok) {
        const result: unknown = await response.json()
        if (
          result &&
          typeof result === 'object' &&
          'events_received' in result &&
          result.events_received === 1
        )
          return 'sent'
        throw new Error('Meta did not acknowledge the conversion')
      }
      retry =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      if (!retry || attempt === 1)
        throw new MetaConversionRejectedError(response.status)
    } catch (error) {
      if (error instanceof MetaConversionRejectedError || attempt === 1) {
        // Do not propagate provider bodies or network errors that may echo secrets.
        throw new Error(
          error instanceof MetaConversionRejectedError
            ? `Meta conversion rejected (${error.status})`
            : 'Meta conversion delivery failed',
        )
      }
      retry = true
    }
    if (retry) await sleep(100)
  }
  throw new Error('Meta conversion delivery failed')
}

class MetaConversionRejectedError extends Error {
  constructor(readonly status: number) {
    super('Meta conversion rejected')
  }
}
