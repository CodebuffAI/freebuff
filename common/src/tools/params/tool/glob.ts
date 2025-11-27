import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'glob'
const endsAgentStep = false
const inputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, 'Pattern cannot be empty')
      .describe(
        'Glob pattern to match files against (e.g., *.js, src/glob/*.ts, glob/test/glob/*.go).',
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        'Optional working directory to search within, relative to project root. If not provided, searches from project root.',
      ),
  })
  .describe(
    `Search for files matching a glob pattern. Returns matching file paths sorted by modification time.`,
  )
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    pattern: '**/*.test.ts',
  },
  endsAgentStep,
})}

Purpose: Search for files matching a glob pattern to discover files by name patterns rather than content.
Use cases:
- Find all files with a specific extension (e.g., "*.js", "*.test.ts")
- Locate files in specific directories (e.g., "src/**/*.ts")
- Find files with specific naming patterns (e.g., "**/test_*.go", "**/*-config.json")
- Discover test files, configuration files, or other files with predictable naming

Glob patterns support:
- * matches any characters except /
- ** matches any characters including /
- ? matches a single character
- [abc] matches one of the characters in brackets
- {a,b} matches one of the comma-separated patterns

This tool is fast and works well for discovering files by name patterns.
`.trim()

export const globParams = {
  toolName,
  description,
  endsAgentStep,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        files: z.array(z.string()).describe('Array of matching file paths'),
        count: z
          .number()
          .describe('Total number of files matching the pattern'),
        message: z.string().describe('Success message'),
      }),
      z.object({
        errorMessage: z.string().describe('Error message if search failed'),
      }),
    ]),
  ),
} satisfies $ToolParams
