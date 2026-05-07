import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'read'
const endsAgentStep = true
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(
        'Path to the file to read, relative to the project root or absolute within the project.',
      ),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Line number to start reading from (1-indexed).'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of lines to read.'),
  })
  .describe(
    'Read the contents of a single text file. Output is truncated to 2000 lines or 50KB, whichever is hit first. Use offset and limit for large files.',
  )

const description = `
Read the contents of a single text file. Use this when you need one file or a specific range in a file.

For text files, output is truncated to 2000 lines or 50KB, whichever is hit first. Use offset to continue from a later line and limit to read a specific line window.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'src/index.ts',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'src/index.ts',
    offset: 101,
    limit: 100,
  },
  endsAgentStep,
})}
`.trim()

export const readParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        path: z.string(),
        content: z.string(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
