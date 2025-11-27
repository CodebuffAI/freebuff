import z from 'zod/v4'

import { terminalCommandOutputSchema } from './run-terminal-command'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'run_file_change_hooks'
const endsAgentStep = true
const inputSchema = z.object({
  files: z
    .array(z.string())
    .describe(
      `List of file paths that were changed and should trigger file change hooks`,
    ),
})
const description = `
Purpose: Trigger file change hooks defined in codebuff.json for the specified files. This tool allows the backend to request the client to run its configured file change hooks (like tests, linting, type checking) after file changes have been applied.

Use cases:
- After making code changes, trigger the relevant tests and checks
- Ensure code quality by running configured linters and type checkers
- Validate that changes don't break the build

The client will run only the hooks whose filePattern matches the provided files.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    files: ['src/components/Button.tsx', 'src/utils/helpers.ts'],
  },
  endsAgentStep,
})}
`.trim()

export const runFileChangeHooksParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z
      .union([
        terminalCommandOutputSchema.and(
          z.object({
            hookName: z.string(),
          }),
        ),
        z.object({
          errorMessage: z.string(),
        }),
      ])
      .array(),
  ),
} satisfies $ToolParams
