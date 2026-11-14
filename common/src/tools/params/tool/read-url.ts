import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  jsonToolResultSchema,
  repairInput,
} from '../utils'

import type { $ToolParams } from '../../constants'

/** An out-of-range `max_chars` is clamped rather than refused. */
function clampMaxChars(input: Record<string, unknown>) {
  if (typeof input.max_chars === 'number') {
    input.max_chars = Math.min(50_000, Math.max(1_000, input.max_chars))
  }
  return input
}

const toolName = 'read_url'
const endsAgentStep = true
const urlSchema = z
  .object({
    url: z
      .url()
      .refine((value) => {
        try {
          const parsedUrl = new URL(value)
          return (
            parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
          )
        } catch {
          return false
        }
      }, 'URL must use http:// or https://')
      .describe(
        'The full http:// or https:// URL to fetch and extract readable text from.',
      ),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        'The specific information to extract. Omit to read the page in order.',
      ),
    live: z
      .boolean()
      .optional()
      .describe(
        'Request fresh content only for time-sensitive facts. Pages fetched within the last 10 minutes may be reused.',
      ),
    max_chars: z
      .number()
      .int()
      .min(1_000)
      .max(50_000)
      .default(20_000)
      .optional()
      .describe(
        'Maximum number of extracted text characters to return. Defaults to 20000.',
      ),
  })
  .describe('Fetch a URL and extract readable text from the page.')
const inputSchema = repairInput(clampMaxChars, urlSchema)

const description = `
Fetch a known public URL, or read a source when web_search excerpts lack the detail you need. Give an objective to extract the relevant passages. Omit it to read page content up to max_chars. If the search already supplies enough evidence, answer from its excerpts and cite the source.

Use read_url for web pages instead of running curl. If a source cannot be read, choose another relevant source or explain the gap.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    url: 'https://react.dev/reference/react/useActionState',
    max_chars: 12000,
  },
  endsAgentStep,
})}
`.trim()

export const readUrlParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        url: z.string(),
        finalUrl: z.string().optional(),
        status: z.number().optional(),
        contentType: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        publishDate: z.string().optional(),
        text: z.string(),
        truncated: z.boolean(),
      }),
      z.object({
        url: z.string().optional(),
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
