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
