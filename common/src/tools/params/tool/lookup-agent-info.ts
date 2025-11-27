import z from 'zod/v4'

import { jsonValueSchema } from '../../../types/json'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'lookup_agent_info'
const endsAgentStep = false
const inputSchema = z
  .object({
    agentId: z
      .string()
      .describe('Agent ID (short local or full published format)'),
  })
  .describe('Retrieve information about an agent by ID')
const description = `
Retrieve information about an agent by ID for proper spawning. Use this when you see a request with a full agent ID like "@publisher/agent-id@version" to validate the agent exists and get its metadata. Only agents that are published under a publisher and version are supported for this tool. 

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    agentId: 'codebuff/researcher@0.0.1',
  },
  endsAgentStep,
})}
`.trim()

export const lookupAgentInfoParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(jsonValueSchema),
} satisfies $ToolParams
