import { z } from 'zod'

/** Public catalogue identifiers only; never project names, prompts or paths. */
export const templateAnalyticsFields = {
  template_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  template_version: z.string().min(1).max(40).optional(),
  template_entry_point: z
    .enum([
      'app_builder_landing',
      'workspace_composer',
      'desktop_composer',
      'first_project',
      'project_dialog',
      'sites_gallery',
    ])
    .optional(),
}

export type TemplateEntryPoint = NonNullable<
  z.infer<typeof templateAnalyticsFields.template_entry_point>
>
export type TemplateAnalytics = {
  template_id?: string
  template_version?: string
  template_entry_point: TemplateEntryPoint
}
export type TemplateTracker = (
  state: 'shown' | 'selected' | 'opened',
  properties: TemplateAnalytics,
) => void
