import z from 'zod/v4'

import { $getNativeToolCallExampleString } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'set_output'
const endsAgentStep = false
const inputSchema = z
  .looseObject({})
  .describe(
    'JSON object to set as the agent output. This completely replaces any previous output. If the agent was spawned, this value will be passed back to its parent. If the agent has an outputSchema defined, the output will be validated against it.',
  )
const description = `
You must use this tool as it is the only way to report any findings to the user. Nothing else you write will be shown to the user.

Please set the output with all the information and analysis you want to pass on to the user. If you just want to send a simple message, use an object with the key "message" and value of the message you want to send.
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    message: 'I found a bug in the code!',
  },
  endsAgentStep,
})}
`.trim()

export const setOutputParams = {
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
