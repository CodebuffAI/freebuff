import { z } from 'zod/v4'

/**
 * The wire contract of `/api/v1/cloud/notifications` (docs/freebuff-notifications.md),
 * shared by the server and every client that shows the inbox or a push.
 */

/** Where a notification takes the user when clicked. */
export const notificationTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    workspaceId: z.string().min(1).max(120),
  }),
])
export type NotificationTarget = z.infer<typeof notificationTargetSchema>

export type NotificationView = {
  id: string
  trigger: string
  title: string
  body: string
  target: NotificationTarget | null
  createdAt: string
  readAt: string | null
}

export type NotificationInbox = {
  notifications: NotificationView[]
  unreadCount: number
  /** Pass as `before` for the next page; null on the last one. */
  nextCursor: string | null
}

export type NotificationPreferenceView = {
  trigger: string
  description: string
  enabled: boolean
}

export type NotificationPreferences = {
  /** False: every trigger is off, whatever the per-trigger answers say. */
  enabled: boolean
  triggers: NotificationPreferenceView[]
}

/** `trigger` omitted: the switch for all notifications. */
export const notificationPreferencePatchSchema = z
  .object({
    trigger: z.string().min(1).max(80).optional(),
    enabled: z.boolean(),
  })
  .strict()
export type NotificationPreferencePatch = z.infer<
  typeof notificationPreferencePatchSchema
>

/*
 * Delivery (PR 2). Phones register a push token per install; Desktop and the
 * browser workspace hold a stream instead and need no registration.
 */

export const notificationPushPlatformSchema = z.enum(['ios', 'android'])
export type NotificationPushPlatform = z.infer<
  typeof notificationPushPlatformSchema
>

/**
 * `POST /api/v1/cloud/notifications/devices`: registers (or refreshes) this
 * install's push token for the caller. Idempotent by `(platform, token)`; a
 * token another account registered moves to the caller (a shared phone that
 * signed in again). Answers `{ device: NotificationDeviceView }`.
 */
export const notificationDeviceRegistrationSchema = z
  .object({
    platform: notificationPushPlatformSchema,
    /** APNs: the hex device token. FCM: the registration token. */
    token: z.string().min(16).max(4096),
    /** APNs only: which gateway the build's entitlement targets. */
    environment: z.enum(['production', 'sandbox']).optional(),
    appVersion: z.string().max(64).optional(),
    /** IANA zone, for quiet hours. */
    timezone: z.string().max(64).optional(),
  })
  .strict()
export type NotificationDeviceRegistration = z.infer<
  typeof notificationDeviceRegistrationSchema
>

export type NotificationDeviceView = {
  id: string
  platform: NotificationPushPlatform
  appVersion: string | null
  lastSeenAt: string
}

/**
 * The data every push carries (APNs custom keys beside `aps`; FCM `data`,
 * all strings there, so `target` is JSON-encoded on FCM). A tap opens
 * `target`, then marks the notification read with `POST /:id/read`.
 */
export type NotificationPushData = {
  notificationId: string
  trigger: string
  target: NotificationTarget | null
}

/**
 * `GET /api/v1/cloud/notifications/stream`: Server-Sent Events for a signed-in
 * client that is open (Desktop, the browser workspace). Each event's SSE `id`
 * is an inbox cursor; reconnecting with `Last-Event-ID` (or `?after=`) first
 * replays ready notifications created after it, then streams live ones.
 *
 * - `event: notification`: a ready notification, `data` is a NotificationView,
 *   plus `replay: true` when it is the catch-up of a resumed stream (what the
 *   client missed while away, not news). Catch-up overlaps the cursor by a few
 *   seconds, so clients dedupe notifications by id.
 * - `?presence=1`: this stream means someone is looking (a visible web tab),
 *   so phones are not pushed meanwhile. Never set it for a background
 *   connection (Desktop holds its stream whenever it runs).
 * - `event: read`: notifications marked read anywhere, `data` is `{ ids: string[] }`
 *   (`ids` empty with `all: true` for "mark all read").
 * - `: keepalive` comments every 25 s.
 */
export type NotificationStreamEvent =
  | { type: 'notification'; notification: NotificationView; replay?: boolean }
  | { type: 'read'; ids: string[]; all?: boolean }
