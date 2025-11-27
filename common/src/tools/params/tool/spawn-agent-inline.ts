import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  emptyToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'spawn_agent_inline'
const endsAgentStep = true
const inputSchema = z
  .object({
    agent_type: z.string().describe('Agent to spawn'),
    prompt: z.string().optional().describe('Prompt to send to the agent'),
    params: z
      .record(z.string(), z.any())
      .optional()
      .describe('Parameters object for the agent (if any)'),
  })
  .describe(
    `Spawn a single agent that runs within the current message history.`,
  )
const description = `
Spawn a single agent that runs within the current message history. 
The spawned agent sees all previous messages and any messages it adds 
are preserved when control returns to you.

You should prefer to use the spawn_agents tool unless instructed otherwise. This tool is only for special cases.

This is useful for:
- Delegating specific tasks while maintaining context
- Having specialized agents process information inline
- Managing message history (e.g., summarization)
The agent will run until it calls end_turn, then control returns to you. There is no tool result for this tool.
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    agent_type: 'file-picker',
    prompt: 'Find files related to authentication',
    params: { paths: ['src/auth.ts', 'src/user.ts'] },
  },
  endsAgentStep,
})}
`.trim()

export const spawnAgentInlineParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: emptyToolResultSchema(),
} satisfies $ToolParams
