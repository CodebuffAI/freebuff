import { createHash, createHmac, randomBytes } from 'node:crypto'
import { hashMatchingEmail } from './matching-hash'
import {
  normalizePaidSocialAttribution,
  paidSocialSignupPath,
  type PaidSocialAttribution,
  type PaidSocialEvent,
  type PaidSocialPlatform,
} from './util/paid-social-conversions'

type XOAuthCredentials = {
  consumerKey: string
  consumerSecret: string
  accessToken: string
  accessTokenSecret: string
}

export type PaidSocialConfig =
  | { platform: 'tiktok'; pixelId: string; accessToken: string }
  | ({
      platform: 'x'
      pixelId: string
      signupEventId: string
      activationEventId?: string
    } & ({ pixelToken: string } | (XOAuthCredentials & { pixelToken?: never })))

export function paidSocialId(platform: PaidSocialPlatform, value: string) {
  return createHash('sha256').update(`${platform}-capi:${value}`).digest('hex')
}

/** X `hashed_email` and TikTok `email` share one normalization; server use only. */
export const hashPaidSocialEmail = hashMatchingEmail

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

export function xEventId(pixelId: string, value?: string): string | undefined {
  if (!value || !/^[a-z0-9]+$/.test(pixelId)) return undefined
  if (/^[a-z0-9]+$/.test(value)) return value
  const match = /^tw-([a-z0-9]+)-([a-z0-9]+)$/.exec(value)
  return match?.[1] === pixelId ? match[2] : undefined
}

/** OAuth 1.0a signature: JSON request bodies are excluded from OAuth parameters. */
export function xOAuthHeader(
  config: XOAuthCredentials,
  url: string,
  nonce = randomBytes(16).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000).toString(),
) {
  const params: Record<string, string> = {
    oauth_consumer_key: config.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: config.accessToken,
    oauth_version: '1.0',
  }
  const normalized = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join('&')
  const base = ['POST', encode(url), encode(normalized)].join('&')
  params.oauth_signature = createHmac(
    'sha1',
    `${encode(config.consumerSecret)}&${encode(config.accessTokenSecret)}`,
  )
    .update(base)
    .digest('base64')
  return `OAuth ${Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encode(key)}="${encode(value)}"`)
    .join(', ')}`
}

export type SendPaidSocialConversionParams = {
  config: PaidSocialConfig
  eventName: PaidSocialEvent
  eventId: string
  eventAt: Date
  userId: string
  attribution: PaidSocialAttribution
  /** Where the claim was made; decides the page TikTok is told an activation happened on. */
  surface?: 'web' | 'desktop' | 'cli'
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  canSend?: () => Promise<boolean>
}

/**
 * The page TikTok is told the event happened on. Registration completes on
 * the public OAuth callback the user actually hit. Activation happens inside
 * Desktop or the CLI, off the site, so it is reported as a CUSTOM web event on
 * that surface's public product page — decided 2026-09-19, because cost per
 * activation is the campaign's primary metric and TikTok can only see what it
 * is sent. Never a private URL, query or token.
 */
function tikTokEventPage(
  eventName: PaidSocialEvent,
  signupPath: string | undefined,
  surface: SendPaidSocialConversionParams['surface'],
): string | undefined {
  if (eventName === 'CompleteRegistration')
    return signupPath ? `https://freebuff.com${signupPath}` : undefined
  return surface === 'desktop' || surface === 'cli'
    ? `https://freebuff.com/${surface}`
    : undefined
}

export function buildPaidSocialRequest(
  params: SendPaidSocialConversionParams,
): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const { config } = params
  const attribution = normalizePaidSocialAttribution(
    config.platform,
    params.attribution,
  )
  if (!attribution) throw new Error('Invalid paid social matching data')
  if (config.platform === 'tiktok') {
    const page = tikTokEventPage(
      params.eventName,
      paidSocialSignupPath(attribution.signupPath),
      params.surface,
    )
    if (!page)
      throw new Error(
        params.eventName === 'CompleteRegistration'
          ? 'TikTok registration requires a known public auth callback'
          : 'TikTok activation requires a native surface',
      )
    return {
      url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': config.accessToken,
      },
      body: {
        event_source: 'web',
        event_source_id: config.pixelId,
        data: [
          {
            event: params.eventName,
            event_time: Math.floor(params.eventAt.getTime() / 1000),
            event_id: params.eventId,
            user: {
              ...(attribution.clickId ? { ttclid: attribution.clickId } : {}),
              ...(attribution.ttp ? { ttp: attribution.ttp } : {}),
              external_id: paidSocialId('tiktok', params.userId),
              ...(attribution.hashedEmail
                ? { email: attribution.hashedEmail }
                : {}),
              ...(attribution.ipAddress ? { ip: attribution.ipAddress } : {}),
              user_agent: attribution.userAgent,
            },
            page: { url: page },
          },
        ],
      },
    }
  }
  const eventId = xEventId(
    config.pixelId,
    params.eventName === 'CompleteRegistration'
      ? config.signupEventId
      : config.activationEventId,
  )
  if (!eventId) throw new Error('Invalid X conversion event configuration')
  const url = `https://ads-api.x.com/12/measurement/conversions/${config.pixelId}`
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(config.pixelToken !== undefined
        ? { 'X-Pixel-Token': config.pixelToken }
        : { Authorization: xOAuthHeader(config, url) }),
    },
    body: {
      conversions: [
        {
          conversion_time: params.eventAt.toISOString(),
          event_id:
            config.pixelToken !== undefined
              ? `tw-${config.pixelId}-${eventId}`
              : eventId,
          identifiers: [
            {
              ...(attribution.clickId ? { twclid: attribution.clickId } : {}),
              ...(attribution.hashedEmail
                ? { hashed_email: attribution.hashedEmail }
                : {}),
            },
          ],
          conversion_id: params.eventId,
        },
      ],
    },
  }
}

/** Bounded retries retain one immutable occurrence ID. No upstream body/token logs. */
export async function sendPaidSocialConversion(
  params: SendPaidSocialConversionParams,
): Promise<'sent' | 'suppressed'> {
  const sleep =
    params.sleepImpl ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < 2; attempt++) {
    if (params.canSend && !(await params.canSend())) return 'suppressed'
    // OAuth nonce/timestamp must be fresh for every attempt.
    const request = buildPaidSocialRequest(params)
    let retryable = true
    try {
      const response = await (params.fetchImpl ?? fetch)(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(3000),
      })
      const body: unknown = await response.json().catch(() => null)
      const result =
        body && typeof body === 'object'
          ? (body as {
              code?: unknown
              errors?: unknown
              data?: { conversions_processed?: unknown }
            })
          : undefined
      const hasErrors =
        result?.errors &&
        (!Array.isArray(result.errors) || result.errors.length > 0)
      if (
        response.ok &&
        !hasErrors &&
        (params.config.platform === 'tiktok'
          ? result?.code === 0
          : result?.data?.conversions_processed === 1)
      )
        return 'sent'
      retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500 ||
        (params.config.platform === 'tiktok' && result?.code === 40100)
    } catch {
      /* Network errors are retryable, without propagating echoed credentials. */
    }
    if (!retryable || attempt === 1)
      throw new Error('Paid social conversion was not acknowledged')
    await sleep(100)
  }
  throw new Error('Paid social conversion delivery failed')
}
