import z from 'zod/v4'

import { jsonObjectSchema } from '../../../types/json'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'wait_for_subagents'
const endsAgentStep = false
const inputSchema = z
  .object({})
  .describe(
    'Wait until the next agent you started with spawn_agent_async finishes.',
  )
const description = `
Wait for the agents you started with spawn_agent_async. Returns as soon as the next one finishes (its report arrives as the next message), or at once when none is running.

Call it whenever you have nothing to start until a running agent reports, instead of re-reading files, polling, or starting a placeholder task to pass the time.

Example:
${$getNativeToolCallExampleString({ toolName, inputSchema, input: {}, endsAgentStep })}
`.trim()

export const waitForSubagentsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(jsonObjectSchema),
} satisfies $ToolParams
