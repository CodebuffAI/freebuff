import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'web_search'
const endsAgentStep = true
const inputSchema = z
  .object({
    query: z
      .string()
      .min(1, 'Query cannot be empty')
      .describe(
        `A concise English keyword query of 1–50 words. No slashes (including package/import names, URLs, or paths), numbers with commas, or non-Latin scripts. Rewrite unsupported terms as English keywords.`,
      ),
    depth: z
      .enum(['standard', 'deep'])
      .optional()
      .default('standard')
      .describe(
        `Search depth - 'standard' for quick results, 'deep' for more comprehensive search. Default is 'standard'.`,
      ),
  })
  .describe(`Search the web for current information.`)
const description = `
Purpose: Search the web for current, up-to-date information on any topic.

Use cases:
- Finding current information about technologies, libraries, or frameworks
- Researching best practices and solutions
- Getting up-to-date news or documentation
- Finding examples and tutorials
- Checking current status of services or APIs

Use concise English keyword queries of at most 50 words. Search covers English pages. Queries cannot contain slashes (including package/import names, URLs, or file paths), numbers with commas, or non-Latin scripts.
Rewrite identifiers into useful keywords: "next/navigation useRouter" → "Nextjs useRouter", "@tanstack/react-query" → "tanstack react-query". Write "101342" instead of "101,342". Translate non-English queries into English and transliterate names. Use read_url directly for a known URL. If web_search returns query guidance, reformulate the query before retrying.
If a search returns no results, try simpler keywords or alternate spellings, such as "Nextjs" for "Next.js".

The tool returns JSON containing a results array with title, url, and snippet fields. Read source pages with read_url to verify the snippets.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    query: 'Nextjs useRouter',
    depth: 'standard',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    query: 'React Server Components tutorial',
    depth: 'deep',
  },
  endsAgentStep,
})}
`.trim()

export const webSearchParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        result: z.string(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
