import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

export const fileContentsSchema = z.union([
  z.object({
    path: z.string(),
    content: z.string(),
    referencedBy: z.record(z.string(), z.string().array()).optional(),
  }),
  z.object({
    path: z.string(),
    contentOmittedForLength: z.literal(true),
  }),
])

const toolName = 'read_files'
const endsAgentStep = true
const inputSchema = z
  .object({
    paths: z
      .array(
        z
          .string()
          .min(1, 'Paths cannot be empty')
          .describe(
            `File path to read relative to the **project root**. Absolute file paths will not work.`,
          ),
      )
      .describe('List of file paths to read.'),
  })
  .describe(
    `Read multiple files from disk and return their contents. Use this tool to read as many files as would be helpful to answer the user's request.`,
  )
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    paths: ['path/to/file1.ts', 'path/to/file2.ts'],
  },
  endsAgentStep,
})}
`.trim()
export const readFilesParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(fileContentsSchema.array()),
} satisfies $ToolParams
