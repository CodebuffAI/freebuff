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

export const updateFileResultSchema = z.union([
  z.object({
    file: z.string(),
    message: z.string(),
  }),
  z.object({
    file: z.string(),
    errorMessage: z.string(),
    patch: z.string().optional(),
  }),
])

const toolName = 'str_replace'
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
  .describe(`Replace strings in a file with new strings.`)
const inputSchema = repairInput(liftSingleReplacement, editsSchema)
const description = `
Use this tool to make edits within existing files.

Important:
If you are making multiple edits in a row to a file, use only one str_replace call with multiple replacements instead of multiple str_replace tool calls.

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
        oldString:
          '\n\t\t// @codebuff delete this log line please\n\t\tconsole.log("Hello, world!");\n',
        newString: '\n',
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

export const strReplaceParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(updateFileResultSchema),
} satisfies $ToolParams
