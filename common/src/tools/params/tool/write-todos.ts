import z from 'zod/v4'

import { $getNativeToolCallExampleString, coerceToArray } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'write_todos'
const endsAgentStep = false
const inputSchema = z
  .object({
    todos: z
      .preprocess(
        coerceToArray,
        z.array(
          z.object({
            task: z.string().describe('Description of the task'),
            completed: z
              .boolean()
              .default(false)
              .describe('Whether the task is completed'),
          }),
        ),
      )
      .describe(
        "List of todos with their completion status. List every step the user's request requires, so you don't forget any, and nothing it does not: no extra features, refactors or polish. Try to order the todos the same way you will complete them. Do not mark todos as completed if you have not completed them yet!",
      ),
  })
  .describe(
    'Write a todo list to track tasks for multi-step implementations. Keep it updated as you complete each step.',
  )
const description = `
Use this tool to track your objectives through an ordered step-by-step plan, for requests that need several distinct steps. Skip it for a question, a single edit or another small change. Call it after you have gathered context on the user's request to plan the steps that request needs. The list is the user's request broken down, not a place to add work they did not ask for.

After completing each todo step, call this tool again to update the list and mark that task as completed. Note that each time you call this tool, rewrite ALL todos with their current status.

Update the list as you work through it. This helps you stay on track and complete all the requirements of the user's request, and it shows the user your plan and current progress.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    todos: [
      { task: 'Create new implementation in foo.ts', completed: true },
      { task: 'Update bar.ts to use the new implementation', completed: false },
      { task: 'Write tests for the new implementation', completed: false },
      {
        task: 'Run the tests to verify the new implementation',
        completed: false,
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const writeTodosParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
      }),
    }),
  ]),
} satisfies $ToolParams
