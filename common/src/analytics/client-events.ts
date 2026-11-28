/**
 * Native app client events (COD-1719) — the wire contract of
 * `POST /api/v1/client-events`, shared by the `web` route and the iOS and
 * Android apps (COD-1726, COD-1725).
 *
 * The apps batch these in memory and send them on the same host and bearer they
 * use for `GET /api/v1/ads/policy`, with `X-Freebuff-Platform: ios|android` and
 * `X-Freebuff-App-Version`. The server stamps platform, app version and the
 * authenticated account id itself and forwards each event to PostHog; nothing
 * in a body is trusted as an identity.
 *
 * The NAME is an allowlist: an unknown name rejects the whole batch (400), so a
 * typo in an app shows up in its own logs rather than as a silent new event.
 * PROPS are filtered, never rejected: a key a name does not declare, a value of
 * the wrong type or enum, or an oversize string is dropped, and the event still
 * counts. Props never carry prompts, message text, file paths, URLs, titles or
 * artifact ids — only the bounded fields below.
 *
 * Add a name or a prop here, then in both apps; never change what an existing
 * value means (recorded PostHog history reads it).
 */
import { z } from 'zod'

import { FREEBUFF_APP_VERSION_HEADER } from '../util/client-platform'

export const CLIENT_EVENTS_PATH = '/api/v1/client-events'

export const CLIENT_EVENTS_MAX_EVENTS = 50
export const CLIENT_EVENT_MAX_PROPS = 20
export const CLIENT_EVENT_MAX_STRING_LENGTH = 200

export const CLIENT_EVENT_PLATFORMS = ['ios', 'android'] as const
export type ClientEventPlatform = (typeof CLIENT_EVENT_PLATFORMS)[number]

export const CLIENT_EVENT_PLATFORM_HEADER = 'x-freebuff-platform'
/** `1.1.6`, or `1.1.6 (23)` with the build (client-platform.ts `mobileAppVersion`). */
export const CLIENT_EVENT_APP_VERSION_HEADER = FREEBUFF_APP_VERSION_HEADER

/** Names a function or a class: no spaces, paths or messages. */
const symbolName = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_$.:<>\-[\]]+$/)

const shortVersion = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9._+\-() ]+$/)

export const CLIENT_EVENT_PROP_SCHEMAS = {
  'mobile.app_opened': {
    firstOpen: z.boolean(),
    coldStart: z.boolean(),
  },
  'mobile.review_prompt': {
    outcome: z.enum([
      'shown',
      'yes',
      'not_really',
      'dismissed',
      'store_opened',
    ]),
    source: z.enum(['prompt', 'settings']),
  },
  'mobile.push_tapped': {
    kind: z.enum(['chat_finished', 'chat_needs_input', 'other']),
  },
  'mobile.feature_used': {
    feature: z.enum([
      'attachment_photo',
      'attachment_camera',
      'attachment_file',
      'dictation',
      'sites_publish',
      'artifact_opened',
      'artifact_edited',
    ]),
    /** An artifact kind (`doc`, `sheet`, ...), never an artifact id. */
    kind: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    outcome: z.enum(['succeeded', 'failed']).optional(),
  },
  'mobile.crash_report': {
    kind: z.enum(['crash', 'hang', 'exception']),
    /** Class name only (`NullPointerException`), never the message. */
    exceptionType: symbolName(100),
    appVersion: shortVersion,
    osVersion: shortVersion,
    ageSec: z.number().finite().nonnegative(),
    /** Function name only, never a file path or line. */
    topFrame: symbolName(CLIENT_EVENT_MAX_STRING_LENGTH).optional(),
  },
} as const satisfies Record<string, Record<string, z.ZodType>>

export type ClientEventName = keyof typeof CLIENT_EVENT_PROP_SCHEMAS

export const CLIENT_EVENT_NAMES = Object.keys(
  CLIENT_EVENT_PROP_SCHEMAS,
) as [ClientEventName, ...ClientEventName[]]

export const clientEventNameSchema = z.enum(CLIENT_EVENT_NAMES)

export const clientEventPropValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])

export const clientEventSchema = z.object({
  name: clientEventNameSchema,
  /** Client clock, milliseconds since the epoch. */
  ts: z.number().finite().nonnegative(),
  props: z.record(z.string(), clientEventPropValueSchema).default({}),
})
export type ClientEvent = z.infer<typeof clientEventSchema>

export const clientEventsRequestSchema = z.object({
  events: z.array(clientEventSchema).max(CLIENT_EVENTS_MAX_EVENTS),
})
export type ClientEventsRequest = z.infer<typeof clientEventsRequestSchema>

export type ClientEventProps = Record<string, string | number | boolean | null>

/**
 * Keeps only the props `name` declares, each valid on its own, at most
 * {@link CLIENT_EVENT_MAX_PROPS} of them, with no string over
 * {@link CLIENT_EVENT_MAX_STRING_LENGTH}. Anything else is dropped, never
 * thrown, so one bad field never loses the event.
 */
export function sanitizeClientEventProps(
  name: ClientEventName,
  props: ClientEventProps,
): { props: ClientEventProps; dropped: number } {
  const allowed: Record<string, z.ZodType> = CLIENT_EVENT_PROP_SCHEMAS[name]
  const out: ClientEventProps = {}
  let kept = 0
  let dropped = 0
  for (const [key, value] of Object.entries(props)) {
    const schema = Object.hasOwn(allowed, key) ? allowed[key] : undefined
    if (
      !schema ||
      value === null ||
      kept >= CLIENT_EVENT_MAX_PROPS ||
      (typeof value === 'string' &&
        value.length > CLIENT_EVENT_MAX_STRING_LENGTH)
    ) {
      dropped += 1
      continue
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      dropped += 1
      continue
    }
    out[key] = value
    kept += 1
  }
  return { props: out, dropped }
}

export function parseClientEventPlatform(
  value: string | null | undefined,
): ClientEventPlatform | null {
  const v = value?.trim().toLowerCase()
  return v === 'ios' || v === 'android' ? v : null
}
