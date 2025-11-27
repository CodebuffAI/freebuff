import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

export const updateFileResultSchema = z.union([
  z.object({
    file: z.string(),
    message: z.string(),
    unifiedDiff: z.string(),
  }),
  z.object({
    file: z.string(),
    errorMessage: z.string(),
    patch: z.string().optional(),
  }),
])

const toolName = 'str_replace'
const endsAgentStep = false
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(`The path to the file to edit.`),
    replacements: z
      .array(
        z
          .object({
            old: z
              .string()
              .min(1, 'Old cannot be empty')
              .describe(
                `The string to replace. This must be an *exact match* of the string you want to replace, including whitespace and punctuation.`,
              ),
            new: z
              .string()
              .describe(
                `The string to replace the corresponding old string with. Can be empty to delete.`,
              ),
            allowMultiple: z
              .boolean()
              .optional()
              .default(false)
              .describe(
                'Whether to allow multiple replacements of old string.',
              ),
          })
          .describe('Pair of old and new strings.'),
      )
      .min(1, 'Replacements cannot be empty')
      .describe('Array of replacements to make.'),
  })
  .describe(`Replace strings in a file with new strings.`)
const description = `
Use this tool to make edits within existing files. Prefer this tool over the write_file tool for existing files, unless you need to make major changes throughout the file, in which case use write_file.

Important:
If you are making multiple edits in a row to a file, use only one str_replace call with multiple replacements instead of multiple str_replace tool calls.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'path/to/file',
    replacements: [
      { old: 'This is the old string', new: 'This is the new string' },
      {
        old: '\n\t\t// @codebuff delete this log line please\n\t\tconsole.log("Hello, world!");\n',
        new: '\n',
      },
      {
        old: '\nfoo:',
        new: '\nbar:',
        allowMultiple: true,
      },
    ],
  },
  endsAgentStep,
})}
    `.trim()

export const strReplaceParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(updateFileResultSchema),
} satisfies $ToolParams
