import { z } from 'zod'

const shortcuts = z.record(z.string().max(80), z.string().max(120).nullable())
  .refine(value => Object.keys(value).length <= 64)

/** Account preferences only. Open tabs, drafts and running terminals belong to a device session. */
export const workspacePreferencesSchema = z.object({
  advancedMode: z.boolean(),
  injectAgentsMd: z.boolean(),
  /** Absent means on. Never defaulted, because an open tab of an older build refuses unknown keys. */
  notificationSounds: z.boolean().optional(),
  /** Settings → General → Sessions: a running chat buys the next hour when its
   *  hour runs out (web/src/server/desktop-cloud/cloud-session-renewal.ts).
   *  Absent means on. Never defaulted, for the same reason as `notificationSounds`. */
  autoStartSessions: z.boolean().optional(),
  /** The streak day whose milestone share dialog (`streak_share_2026_11`) this
   *  account was last shown, as that day's `nextResetAt`: the dialog opens once
   *  per milestone day on any surface, and again when a new streak reaches a
   *  milestone. Absent means none. Never defaulted, for the same reason as
   *  `notificationSounds`. */
  streakShareShownFor: z.string().max(40).optional(),
  /** Unread: the first build's once-per-milestone record (2026-11-16), kept so
   *  a stored value still parses. */
  streakShareShownThrough: z.number().int().min(0).max(100_000).optional(),
  interfaceSize: z.number().int().min(70).max(160),
  desktopMacShortcuts: shortcuts,
  desktopPcShortcuts: shortcuts,
  webMacShortcuts: shortcuts,
  webPcShortcuts: shortcuts,
}).strict()

export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>
export const workspacePreferencesPatchSchema = workspacePreferencesSchema.partial()
export type WorkspacePreferencesPatch = Partial<WorkspacePreferences>
export const defaultWorkspacePreferences: WorkspacePreferences = {
  advancedMode: false,
  injectAgentsMd: true,
  interfaceSize: 100,
  desktopMacShortcuts: {},
  desktopPcShortcuts: {},
  webMacShortcuts: {},
  webPcShortcuts: {},
}

export const shortcutPreferenceKey = (surface: 'desktop' | 'web', mac: boolean) =>
  `${surface}${mac ? 'Mac' : 'Pc'}Shortcuts` as const
