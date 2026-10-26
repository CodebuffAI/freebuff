import z from 'zod/v4'

import { jsonObjectSchema } from '../../../types/json'
import {
  $getNativeToolCallExampleString,
  coerceToObject,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'spawn_agent_async'
const endsAgentStep = false
const inputSchema = z
  .object({
    agent_type: z.string().describe('Agent to spawn'),
    prompt: z
      .string()
      .describe(
        'The task: one small, concrete piece of work, with the files it owns and anything it must agree on with other running tasks',
      ),
    params: z
      .preprocess(coerceToObject, z.record(z.string(), z.any()))
      .optional()
      .describe('Parameters object for the agent (if any)'),
  })
  .describe(
    `Start one agent in the background. Returns at once with its spawn id; the agent's report arrives later as a message.`,
  )
const description = `
Start one agent in the background and keep going. The call returns immediately with a spawn id (like "t3"); the agent works in parallel with you and with every other agent you have started. When it finishes, its report arrives as a message between your steps, tagged with that spawn id. An agent that shares this conversation's context reports its whole transcript: every tool call it made, every result it saw, and its closing summary.

- One agent per call. To run several at once, make several spawn_agent_async calls in the same response; each starts as soon as its call is read.
- To wait for the next report, call wait_for_subagents. A response whose only tool calls are spawn_agent_async, or with no tool call while agents are still running, also waits instead of ending your turn: your turn cannot end while an agent you started is still running.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    agent_type: 'example-task-worker',
    prompt:
      'Add the `timeoutMs` option to `RunOptions` in sdk/src/run.ts and pass it through to `callMainPrompt`. You own sdk/src/run.ts only.',
  },
  endsAgentStep,
})}
`.trim()

export const spawnAgentAsyncParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.object({ agentType: z.string() }).and(jsonObjectSchema),
  ),
} satisfies $ToolParams
