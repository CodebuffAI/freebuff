import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'web_search'
const endsAgentStep = true
const keywordQuery = z.string().trim().min(1).max(200)
const inputSchema = z
  .object({
    query: keywordQuery.describe(
      'Primary keyword query, usually 3–6 words. Include the entity, exact package name, or error you are looking for.',
    ),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        'What you need to establish. Include relevant context, version, or source preferences.',
      ),
    additional_queries: z
      .array(keywordQuery)
      .max(2)
      .optional()
      .describe(
        'Up to two alternate keyword queries for the same objective. Submit them together in this search.',
      ),
    live: z
      .boolean()
      .optional()
      .describe(
        'Request fresh pages only when the answer is time-sensitive. Slower; pages fetched within the last 10 minutes may be reused.',
      ),
  })
  .describe('Search the web for relevant source excerpts and URLs.')
const description = `
Start web research with web_search. Give a short keyword query and describe the information you need in objective. For multiple angles on the same question, add related queries in the same call. Keep exact identifiers, numbers, and names in the relevant language.

Read the returned excerpts first. Answer with their source URLs when they provide the evidence you need. Use read_url for a known URL or when an excerpt lacks necessary detail. Indexed content is fine for most searches. Set live only if recently changed information matters.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    query: '@tanstack/react-query staleTime',
    objective:
      'Find the documented default staleTime in TanStack Query v5 and what it means for background refetches.',
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
