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
