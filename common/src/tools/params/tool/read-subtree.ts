import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'read_subtree'
const endsAgentStep = true
const inputSchema = z
  .object({
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe(
        `List of paths to directories or files. Relative to the project root. If omitted, the entire project tree is used.`,
      ),
    maxTokens: z
      .number()
      .int()
      .positive()
      .default(4000)
      .describe(
        `Maximum token budget for the subtree blob; the tree will be truncated to fit within this budget by first dropping file variables and then removing the most-nested files and directories.`,
      ),
  })
  .describe(
    `Read one or more directory subtrees (as a blob including subdirectories, file names, and parsed variables within each source file) or return parsed variable names for files. If no paths are provided, returns the entire project tree.`,
  )
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    paths: ['src', 'package.json'],
    maxTokens: 4000,
  },
  endsAgentStep,
})}

Purpose: Read a directory subtree and return a blob containing subdirectories, file names, and parsed variable/functions names from source files. For files, return only the parsed variable names. If no paths are provided, returns the entire project tree. The output is truncated to fit within the provided token budget.

- Use this tool on particular subdirectories when you need to know all the nested files and directories. E.g. for a refactoring task, or to understand a particular part of the codebase.
- In normal use, don't set maxTokens beyond 10,000.
`.trim()

export const readSubtreeParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.array(
      z.union([
        z.object({
          path: z.string(),
          type: z.literal('directory'),
          printedTree: z.string(),
          tokenCount: z.number(),
          truncationLevel: z.enum([
            'none',
            'unimportant-files',
            'tokens',
            'depth-based',
          ]),
        }),
        z.object({
          path: z.string(),
          type: z.literal('file'),
          variables: z.array(z.string()),
        }),
        z.object({
          path: z.string(),
          errorMessage: z.string(),
        }),
      ]),
    ),
  ),
} satisfies $ToolParams
