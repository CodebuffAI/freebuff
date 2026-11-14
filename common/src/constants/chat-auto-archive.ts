import { z } from 'zod/v4'

// Zero disables automatic archiving in settings.
export const DEFAULT_CHAT_AUTO_ARCHIVE_DAYS = 0
// Older Cloud workers interpret zero as immediately due. Store Never as a long
// interval during rolling upgrades; current workers exclude it from discovery.
export const STORED_CHAT_AUTO_ARCHIVE_NEVER_DAYS = 365_000
export const CHAT_AUTO_ARCHIVE_OPTIONS = [
  { value: '0', label: 'Never' },
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '7', label: '1 week' },
  { value: '14', label: '2 weeks' },
] as const

export const chatAutoArchiveDaysSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(3),
  z.literal(7),
  z.literal(14),
])
export const chatAutoArchiveSettingsSchema = z
  .object({
    days: chatAutoArchiveDaysSchema,
  })
  .strict()
export type ChatAutoArchiveSettings = z.infer<
  typeof chatAutoArchiveSettingsSchema
>

export function chatAutoArchiveDays(value: unknown): number {
  const parsed = chatAutoArchiveDaysSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_CHAT_AUTO_ARCHIVE_DAYS
}
