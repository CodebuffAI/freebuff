import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  emptyToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'set_messages'
const endsAgentStep = true
const inputSchema = z
  .object({
    messages: z.any(),
  })
  .describe(`Set the conversation history to the provided messages.`)
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    messages: [
      {
        role: 'user',
        content: 'Hello, how are you?',
      },
      {
        role: 'assistant',
        content: 'I am fine, thank you.',
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const setMessagesParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: emptyToolResultSchema(),
} satisfies $ToolParams
