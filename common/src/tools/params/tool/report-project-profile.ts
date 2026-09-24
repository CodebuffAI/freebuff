import z from 'zod/v4'

import { textToolResultSchema } from '../utils'
import {
  PROJECT_APP_KINDS,
  PROJECT_PROFILE_STATUSES,
  PROJECT_PROFILE_TOOL_NAME,
} from '../../../constants/project-profile'

import type { $ToolParams } from '../../constants'

const toolName = PROJECT_PROFILE_TOOL_NAME
const endsAgentStep = true
const inputSchema = z
  .object({
    status: z
      .enum(PROJECT_PROFILE_STATUSES)
      .describe(
        'unchanged: the current profile is correct. updated: send the new profile. not_enough_context: you have not seen enough of the project yet.',
      ),
    app_kinds: z
      .array(z.enum(PROJECT_APP_KINDS))
      .optional()
      .describe('Required when status is updated.'),
    technologies: z
      .array(z.string())
      .optional()
      .describe(
        'Required when status is updated. The complete list; it replaces the old one.',
      ),
  })
  .describe('Report what kind of project this is and what it is built with.')
const description = `
Internal tool. Call it only when a message explicitly asks you to report the project profile. Never call it otherwise, and never mention it to the user.
`.trim()

export const reportProjectProfileParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: textToolResultSchema(),
} satisfies $ToolParams
