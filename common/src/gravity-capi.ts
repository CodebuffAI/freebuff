export const GRAVITY_CAPI_ENDPOINT = 'https://api.trygravity.ai/gateway/events'
export const GRAVITY_FIRST_MESSAGE_EVENT = 'FirstMessage'

export const FREEBUFF_GRAVITY_SURFACES = [
  'cli',
  'desktop',
  'web',
  'cloud',
  'chat',
] as const
export type FreebuffGravitySurface = (typeof FREEBUFF_GRAVITY_SURFACES)[number]
export type FreebuffServiceGravitySurface = Extract<
  FreebuffGravitySurface,
  'web' | 'cloud' | 'chat'
>

export function isFreebuffGravitySurface(
  value: unknown,
): value is FreebuffGravitySurface {
  return FREEBUFF_GRAVITY_SURFACES.includes(value as FreebuffGravitySurface)
}

export function isFreebuffServiceGravitySurface(
  value: unknown,
): value is FreebuffServiceGravitySurface {
  return value === 'web' || value === 'cloud' || value === 'chat'
}

export type GravityCapiUserData = {
  click_id?: string | null
  visitor_id?: string | null
  session_id?: string | null
  client_user_agent?: string | null
}

/** Attribution and device data returned by window.gravityPixel.getCAPIData(). */
export type GravityCapiData = {
  user_data?: GravityCapiUserData | null
  event_source_url?: string | null
  client_context?: Record<string, unknown> | null
}

export type GravityConversionResult = {
  event_id?: string
  status?: string
  attributed?: boolean
  error?: unknown
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maxLength
    ? value
    : undefined
}

function boundedObject(
  value: unknown,
  maxJsonLength: number,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      maxJsonLength
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Sanitizes the untrusted browser result from gravityPixel.getCAPIData(). */
export function sanitizeGravityCapiData(
  raw: unknown,
  fallbackEventSourceUrl?: unknown,
): GravityCapiData | undefined {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  const rawUser =
    value?.user_data &&
    typeof value.user_data === 'object' &&
    !Array.isArray(value.user_data)
      ? (value.user_data as Record<string, unknown>)
      : undefined
  const eventSourceUrl =
    boundedString(fallbackEventSourceUrl, 8192) ??
    boundedString(value?.event_source_url, 8192)
  const clientContext = boundedObject(value?.client_context, 32_768)

  if (!value && !eventSourceUrl) return undefined
  return {
    user_data: rawUser
      ? {
          click_id: boundedString(rawUser.click_id, 4096),
          visitor_id: boundedString(rawUser.visitor_id, 4096),
          session_id: boundedString(rawUser.session_id, 4096),
          client_user_agent: boundedString(rawUser.client_user_agent, 4096),
        }
      : undefined,
    event_source_url: eventSourceUrl,
    client_context: clientContext,
  }
}

export function gravityFirstMessageEventId(userId: string): string {
  return `freebuff-first-message-${userId}`
}

export function buildGravityFirstMessagePayload(params: {
  userId: string
  email?: string | null
  surface: FreebuffGravitySurface
  gravity?: GravityCapiData | null
  userAgent?: string | null
  eventTime?: number
}) {
  const pixelUser = params.gravity?.user_data ?? {}
  const userData = {
    ...(pixelUser.click_id ? { click_id: pixelUser.click_id } : {}),
    ...(pixelUser.visitor_id ? { visitor_id: pixelUser.visitor_id } : {}),
    ...(pixelUser.session_id ? { session_id: pixelUser.session_id } : {}),
    ...(pixelUser.client_user_agent || params.userAgent
      ? {
          client_user_agent:
            pixelUser.client_user_agent ?? params.userAgent ?? undefined,
        }
      : {}),
    ...(params.email ? { em: [params.email] } : {}),
    external_id: [params.userId],
  }

  return {
    data: [
      {
        event_name: GRAVITY_FIRST_MESSAGE_EVENT,
        event_time: params.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: gravityFirstMessageEventId(params.userId),
        action_source: 'website',
        ...(params.gravity?.event_source_url
          ? { event_source_url: params.gravity.event_source_url }
          : {}),
        user_data: userData,
        ...(params.gravity?.client_context
          ? { client_context: params.gravity.client_context }
          : {}),
        custom_data: {
          content_name: 'Freebuff first message',
          content_category: params.surface,
        },
      },
    ],
  }
}

/**
 * Sends the account-level first-message conversion. The caller owns retry and
 * persistence; this function throws unless Gravity confirms a terminal result.
 */
export async function sendGravityFirstMessageConversion(params: {
  apiKey: string
  userId: string
  email?: string | null
  surface: FreebuffGravitySurface
  gravity?: GravityCapiData | null
  userAgent?: string | null
  fetchImpl?: typeof fetch
}): Promise<GravityConversionResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const response = await fetchImpl(GRAVITY_CAPI_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'freebuff/1.0 (gravity-capi)',
    },
    body: JSON.stringify(buildGravityFirstMessagePayload(params)),
    signal: AbortSignal.timeout(3_000),
  })

  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(
      `Gravity CAPI rejected FirstMessage (${response.status}): ${responseText.slice(0, 500)}`,
    )
  }

  let body: { results?: GravityConversionResult[] }
  try {
    body = JSON.parse(responseText) as { results?: GravityConversionResult[] }
  } catch {
    throw new Error('Gravity CAPI returned invalid JSON for FirstMessage')
  }

  const result = body.results?.[0]
  if (!result?.status) {
    throw new Error('Gravity CAPI returned no result for FirstMessage')
  }
  // `accepted` is what production actually answers for a live FirstMessage
  // (HTTP 200): queued for processing, not refused. Treating it as a failure
  // made every first message send twice (the missing status code reads as
  // retryable) and log ~5-10k false "Failed to track" errors a day.
  if (
    !['ok', 'accepted', 'duplicate', 'test_ok', 'skipped'].includes(
      result.status,
    )
  ) {
    throw new Error(
      `Gravity CAPI failed FirstMessage with status ${result.status}`,
    )
  }
  return result
}
