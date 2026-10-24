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
Purpose: Fetch a URL returned by web_search and extract the readable page text so you can answer with source-backed evidence.

Use this after web_search when snippets are not enough. Prefer authoritative, relevant pages from the search results. The tool follows redirects, extracts titles and metadata, strips scripts/styles/navigation boilerplate from HTML, and returns normalized readable text.

Do not use run_terminal_command with curl just to inspect web pages; use read_url instead. If read_url reports unsupported content or extraction failure, then choose a different search result or explain the limitation.

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
        finalUrl: z.string(),
        status: z.number(),
        contentType: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
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
