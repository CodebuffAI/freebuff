import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'add_subgoal'
const endsAgentStep = false
const inputSchema = z
  .object({
    id: z
      .string()
      .min(1, 'Id cannot be empty')
      .describe(
        `A unique identifier for the subgoal. Try to choose the next sequential integer that is not already in use.`,
      ),
    objective: z
      .string()
      .min(1, 'Objective cannot be empty')
      .describe(`The objective of the subgoal, concisely and clearly stated.`),
    status: z
      .enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'ABORTED'])
      .describe(`The status of the subgoal.`),
    plan: z.string().optional().describe('A plan for the subgoal.'),
    log: z
      .string()
      .optional()
      .describe('A log message for the subgoal progress.'),
  })
  .describe(
    `Add a new subgoal for tracking progress. To be used for complex requests that can't be solved in a single step, as you may forget what happened!`,
  )
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    id: '1',
    objective: 'Add a new "deploy api" subgoal',
    status: 'IN_PROGRESS',
  },
  endsAgentStep,
})}
`.trim()

export const addSubgoalParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.object({
      message: z.string(),
    }),
  ),
} satisfies $ToolParams
