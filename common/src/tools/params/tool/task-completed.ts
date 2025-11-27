import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  emptyToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'task_completed'
const endsAgentStep = true
const inputSchema = z.object({}).describe(
  `Signal that the task is complete. Use this tool when:
- The user's request is completely fulfilled
- You need clarification from the user before continuing
- You are stuck or need help from the user to continue

This tool explicitly marks the end of your work on the current task.`,
)
const description = `
Use this tool to signal that the task is complete.

- When to use:
  * The user's request is completely fulfilled and you have nothing more to do
  * You need clarification from the user before continuing
  * You need help from the user to continue (e.g., missing information, unclear requirements)
  * You've encountered a blocker that requires user intervention

- Before calling:
  * Ensure all pending work is finished
  * Resolve all tool results
  * Provide any outputs or summaries the user needs

- Effect: Signals completion of the current task and returns control to the user

*EXAMPLE USAGE*:

All changes have been implemented and tested successfully!

${$getNativeToolCallExampleString({ toolName, inputSchema, input: {}, endsAgentStep })}

OR

I need more information to proceed. Which database schema should I use for this migration?

${$getNativeToolCallExampleString({ toolName, inputSchema, input: {}, endsAgentStep })}

OR

I can't get the tests to pass after several different attempts. I need help from the user to proceed.

${$getNativeToolCallExampleString({ toolName, inputSchema, input: {}, endsAgentStep })}
`.trim()

export const taskCompletedParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: emptyToolResultSchema(),
} satisfies $ToolParams
