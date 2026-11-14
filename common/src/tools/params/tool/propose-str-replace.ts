import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  coerceToArray,
  jsonToolResultSchema,
  liftSingleReplacement,
  normalizeReplacementAliases,
  repairInput,
} from '../utils'

import type { $ToolParams } from '../../constants'

export const proposeUpdateFileResultSchema = z.union([
  z.object({
    file: z.string(),
    message: z.string(),
    unifiedDiff: z.string(),
  }),
  z.object({
    file: z.string(),
    errorMessage: z.string(),
  }),
])

const toolName = 'propose_str_replace'
const endsAgentStep = false
const editsSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(`The path to the file to edit.`),
    replacements: z
      .preprocess(
        coerceToArray,
        z
          .array(
            z
              .preprocess(
                normalizeReplacementAliases,
                z.object({
                  oldString: z
                    .string()
                    .min(1, 'oldString cannot be empty')
                    .describe(
                      `The string to replace. This must be an *exact match* of the string you want to replace, including whitespace and punctuation.`,
                    ),
                  newString: z
                    .string()
                    .describe(
                      `The string to replace the corresponding oldString with. Can be empty to delete.`,
                    ),
                  allowMultiple: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                      'Whether to allow multiple replacements of oldString.',
                    ),
                }),
              )
              .describe('Pair of oldString and newString values.'),
          )
          .min(1, 'Replacements cannot be empty'),
      )
      .describe('Array of replacements to make.'),
  })
  .describe(
    `Propose string replacements in a file without actually applying them.`,
  )
const inputSchema = repairInput(liftSingleReplacement, editsSchema)
const description = `
Propose edits to a file without actually applying them. Use this tool when you want to draft changes that will be reviewed before being applied.

This tool works identically to str_replace but the changes are not written to disk. Instead, it returns the unified diff of what would change. Multiple propose calls on the same file will stack correctly.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'path/to/file',
    replacements: [
      {
        oldString: 'This is the old string',
        newString: 'This is the new string',
      },
      {
        oldString: '\nfoo:',
        newString: '\nbar:',
        allowMultiple: true,
      },
    ],
  },
  endsAgentStep,
})}
    `.trim()

export const proposeStrReplaceParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(proposeUpdateFileResultSchema),
} satisfies $ToolParams
