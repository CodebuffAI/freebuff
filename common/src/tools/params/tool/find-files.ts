import z from 'zod/v4'

import { fileContentsSchema } from './read-files'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'find_files'
const endsAgentStep = true
const inputSchema = z
  .object({
    prompt: z
      .string()
      .min(1, 'Prompt cannot be empty')
      .describe(
        `A brief natural language description of the files or the name of a function or class you are looking for. It's also helpful to mention a directory or two to look within.`,
      ),
  })
  .describe(
    `Find several files related to a brief natural language description of the files or the name of a function or class you are looking for.`,
  )
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    prompt: 'The implementation of function foo',
  },
  endsAgentStep,
})}

Purpose: Better fulfill the user request by reading files which could contain information relevant to the user's request.
Use cases:
- If you are calling a function or creating a class and want to know how it works, use this tool to get the implementation.
- If you need to understand a section of the codebase, read more files in that directory or subdirectories.
- Some requests require a broad understanding of multiple parts of the codebase. Consider using find_files to gain more context before making changes.

Don't use this tool if:
- You already know the exact path of the file(s) you are looking for — in this case, use read_files.
- You already read the files you need in context.
- You know the name of the file you need. Instead use run_terminal_command with \`find -name\` (or \`dir /s /b\` or \`Get-ChildItem -Recurse -Filter\`)

This tool is not guaranteed to find the correct file. In general, prefer using read_files instead of find_files.
`.trim()

export const findFilesParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      fileContentsSchema.array(),
      z.object({
        message: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
