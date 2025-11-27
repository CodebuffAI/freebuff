import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'list_directory'
const endsAgentStep = true
const inputSchema = z
  .object({
    path: z
      .string()
      .describe('Directory path to list, relative to the project root.'),
  })
  .describe(
    'List files and directories in the specified path. Returns separate arrays of file names and directory names.',
  )
const description = `
Lists all files and directories in the specified path. Useful for exploring directory structure and finding files.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'src/components',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: '.',
  },
  endsAgentStep,
})}
    `.trim()

export const listDirectoryParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        files: z.array(z.string()).describe('Array of file names'),
        directories: z.array(z.string()).describe('Array of directory names'),
        path: z.string().describe('The directory path that was listed'),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
