import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  emptyToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'end_turn'
const endsAgentStep = true
const inputSchema = z
  .object({})
  .describe(
    `End your turn, regardless of any new tool results that might be coming. This will allow the user to type another prompt.`,
  )
const description = `
Only use this tool to hand control back to the user.

- When to use: after you have completed a meaningful chunk of work and you are either (a) fully done, or (b) explicitly waiting for the user's next message.
- Do NOT use: as a stop token mid-work, to pause between tool calls, to wait for tool results, or to "check in" unnecessarily.
- Before calling: finish all pending steps, resolve tool results, and include any outputs the user needs to review.
- Effect: Signals the UI to wait for the user's reply; any pending tool results will be ignored.

*INCORRECT USAGE*:
${$getNativeToolCallExampleString({
  toolName: 'some_tool_that_produces_results',
  inputSchema: null,
  input: { query: 'some example search term' },
  endsAgentStep: false,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {},
  endsAgentStep: true,
})}

*CORRECT USAGE*:
All done! Would you like some more help with xyz?

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {},
  endsAgentStep: false,
})}
`.trim()

export const endTurnParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: emptyToolResultSchema(),
} satisfies $ToolParams
