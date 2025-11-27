import z from 'zod/v4'

import { $getNativeToolCallExampleString } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'write_todos'
const endsAgentStep = false
const inputSchema = z
  .object({
    todos: z
      .array(
        z.object({
          task: z.string().describe('Description of the task'),
          completed: z.boolean().describe('Whether the task is completed'),
        }),
      )
      .describe(
        "List of todos with their completion status. Add ALL of the applicable tasks to the list, so you don't forget to do anything. Try to order the todos the same way you will complete them. Do not mark todos as completed if you have not completed them yet!",
      ),
  })
  .describe(
    'Write a todo list to track tasks for multi-step implementations. Use this frequently to maintain an updated step-by-step plan.',
  )
const description = `
Use this tool to track your objectives through an ordered step-by-step plan. Call this tool after you have gathered context on the user's request to plan out the implementation steps for the user's request.

After completing each todo step, call this tool again to update the list and mark that task as completed. Note that each time you call this tool, rewrite ALL todos with their current status.

Use this tool frequently as you work through tasks to update the list of todos with their current status. Doing this is extremely useful because it helps you stay on track and complete all the requirements of the user's request. It also helps inform the user of your plans and the current progress, which they want to know at all times.

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
        todos: z.array(z.object({ task: z.string(), completed: z.boolean() })),
      }),
    }),
  ]),
} satisfies $ToolParams
