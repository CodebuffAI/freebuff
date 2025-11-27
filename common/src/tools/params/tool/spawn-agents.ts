import z from 'zod/v4'

import { jsonObjectSchema } from '../../../types/json'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

export const spawnAgentsOutputSchema = z
  .object({
    agentType: z.string(),
  })
  .and(jsonObjectSchema)
  .array()

const toolName = 'spawn_agents'
const endsAgentStep = true
const inputSchema = z
  .object({
    agents: z
      .object({
        agent_type: z.string().describe('Agent to spawn'),
        prompt: z.string().optional().describe('Prompt to send to the agent'),
        params: z
          .record(z.string(), z.any())
          .optional()
          .describe('Parameters object for the agent (if any)'),
      })
      .array(),
  })
  .describe(
    `Spawn multiple agents and send a prompt and/or parameters to each of them. These agents will run in parallel. Note that that means they will run independently. If you need to run agents sequentially, use spawn_agents with one agent at a time instead.`,
  )
const description = `
Use this tool to spawn agents to help you complete the user request. Each agent has specific requirements for prompt and params based on their inputSchema.

The prompt field is a simple string, while params is a JSON object that gets validated against the agent's schema.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    agents: [
      {
        agent_type: 'planner',
        prompt: 'Create a plan for implementing user authentication',
        params: { filePaths: ['src/auth.ts', 'src/user.ts'] },
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const spawnAgentsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(spawnAgentsOutputSchema),
} satisfies $ToolParams
