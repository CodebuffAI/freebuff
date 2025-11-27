import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

export const questionSchema = z.object({
  question: z.string().describe('The question to ask the user'),
  header: z
    .string()
    .max(12)
    .optional()
    .describe(
      'Short label (max 12 chars) displayed as a chip/tag. Example: "Auth method"',
    ),
  options: z
    .object({
      label: z.string().describe('The display text for this option'),
      description: z
        .string()
        .optional()
        .describe('Explanation shown when option is focused'),
    })
    .array()
    .refine((opts) => opts.length >= 2, {
      message: 'Each question must have at least 2 options',
    })
    .describe('Array of answer options with label and optional description.'),

  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      'If true, allows selecting multiple options (checkbox). If false, single selection only (radio).',
    ),
  validation: z
    .object({
      maxLength: z
        .number()
        .optional()
        .describe('Maximum length for "Other" text input'),
      minLength: z
        .number()
        .optional()
        .describe('Minimum length for "Other" text input'),
      pattern: z
        .string()
        .optional()
        .describe('Regex pattern for "Other" text input'),
      patternError: z
        .string()
        .optional()
        .describe('Custom error message when pattern fails'),
    })
    .optional()
    .describe('Validation rules for "Other" text input'),
})

export type AskUserQuestion = z.infer<typeof questionSchema>

const toolName = 'ask_user'
const endsAgentStep = true
const inputSchema = z
  .object({
    questions: z
      .array(questionSchema)
      .min(1, 'Must provide at least one question')
      .describe('List of multiple choice questions to ask the user'),
  })
  .describe(
    'Ask the user a list of multiple choice questions. Each question must have at least 2 options. The agent execution will pause until the user submits their answers.',
  )

const outputSchema = z.object({
  answers: z
    .array(
      z.object({
        questionIndex: z.number(),
        selectedOption: z
          .string()
          .optional()
          .describe('The selected option text (single-select mode)'),
        selectedOptions: z
          .array(z.string())
          .optional()
          .describe('Array of selected option texts (multi-select mode)'),
        otherText: z
          .string()
          .optional()
          .describe('Custom text input (if user typed their own answer)'),
      }),
    )
    .optional()
    .describe(
      'Array of user answers, one per question. Each answer has either selectedOption (single), selectedOptions (multi), or otherText.',
    ),
  skipped: z
    .boolean()
    .optional()
    .describe('True if user skipped the questions'),
})

const description = `
Ask the user multiple choice questions and pause execution until they respond. Supports both single-select (radio) and multi-select (checkbox) modes.

The user can either:
- Select one option (single-select mode, default)
- Select multiple options (multi-select mode, set multiSelect: true)
- Type a custom answer in the "Other" text field
- Skip the questions to provide different instructions instead

Single-select example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    questions: [
      {
        question: 'Which authentication method should we use?',
        header: 'Auth method',
        options: [
          {
            label: 'JWT tokens',
            description: 'Stateless tokens stored in localStorage',
          },
          {
            label: 'Session cookies',
            description: 'Server-side sessions with httpOnly cookies',
          },
          {
            label: 'OAuth2',
            description: 'Third-party authentication (Google, GitHub, etc.)',
          },
        ],
      },
    ],
  },
  endsAgentStep,
})}

Multi-select example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    questions: [
      {
        question: 'Which features should we implement?',
        header: 'Features',
        options: [
          { label: 'Rate limiting' },
          { label: 'Caching' },
          { label: 'Logging' },
          { label: 'Monitoring' },
        ],
        multiSelect: true,
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const askUserParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(outputSchema),
} satisfies $ToolParams
