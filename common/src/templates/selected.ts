import { z } from 'zod/v4'
import { TEMPLATE_ID } from './catalog'

/** The starter the user selected, carried alongside its initialized source files. */
export const selectedTemplateSchema = z
  .object({
    id: z.string().regex(TEMPLATE_ID),
    name: z.string().min(1).max(80),
  })
  .strict()

export type SelectedTemplate = z.infer<typeof selectedTemplateSchema>
