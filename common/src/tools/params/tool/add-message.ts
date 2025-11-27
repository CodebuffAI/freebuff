import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  emptyToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'add_message'
const endsAgentStep = true
const inputSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })
  .describe(
    `Add a new message to the conversation history. To be used for complex requests that can't be solved in a single step, as you may forget what happened!`,
  )
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    role: 'user',
    content: 'Hello, how are you?',
  },
  endsAgentStep,
})}
`.trim()

export const addMessageParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: emptyToolResultSchema(),
} satisfies $ToolParams
