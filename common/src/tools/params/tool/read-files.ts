import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  coerceToArray,
  jsonToolResultSchema,
  repairInput,
} from '../utils'

import type { $ToolParams } from '../../constants'

export const fileContentsSchema = z.union([
  z.object({
    path: z.string(),
    content: z.string(),
    referencedBy: z.record(z.string(), z.string().array()).optional(),
  }),
  z.object({
    path: z.string(),
    contentOmittedForLength: z.literal(true),
  }),
])

const toolName = 'read_files'
const endsAgentStep = true

const pathEntrySchema = z
  .string()
  .min(1, 'Paths cannot be empty')
  .describe(
    `File path to read. Prefer paths relative to the **project root**; absolute paths inside the project are accepted, but paths outside the project will not work.`,
  )

/** Models count lines from 0: an `offset` or `limit` of 0 means "from the start" / "default length". */
function zeroWindowAsUnset(entry: Record<string, unknown>) {
  if (entry.offset === 0) delete entry.offset
  if (entry.limit === 0) delete entry.limit
  return entry
}

const windowSchema = z.object({
  path: z.string().min(1, 'Paths cannot be empty'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Line number to start reading from (1-indexed).'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of lines to read (defaults to 2,000).'),
})

const windowedEntrySchema = z.union([
  pathEntrySchema,
  repairInput(zeroWindowAsUnset, windowSchema),
])

const legacyInputSchema = z
  .object({
    paths: z
      .preprocess(coerceToArray, z.array(pathEntrySchema))
      .describe('List of file paths to read.'),
  })
  .describe(
    `Read text files and view images (PNG, JPEG, GIF, WebP) from disk. Local image reads attach the image for visual inspection rather than returning its bytes as text. Returned text content shares a 20,000 estimated-token limit and a 100,000-character hard limit. Prefer the smallest relevant set of files and use code_search for targeted discovery.`,
  )

const windowedInputSchema = z
  .object({
    paths: z
      .preprocess(coerceToArray, z.array(windowedEntrySchema))
      .describe(
        'List of files to read. Each entry is either a file path, or an object { path, offset, limit } to read a specific line range of that file.',
      ),
  })
  .describe(
    `Read text files and view images (PNG, JPEG, GIF, WebP) from disk. Local image reads attach the image for visual inspection rather than returning its bytes as text. List several paths to read several files in one call. Line ranges apply only to text files. Large text files are cut off after 2,000 lines, with a note telling you the file's total line count. Don't read a large text file whole: use code_search to locate the part you need (matches come with line numbers), then read a window around it with { path, offset, limit }. Avoid tiny repeated slices; when in doubt, take a window of a few hundred lines.`,
  )

const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema: legacyInputSchema,
  input: {
    paths: ['path/to/file.ts', 'path/to/screenshot.png'],
  },
  endsAgentStep,
})}
`.trim()

export const readFilesDisplayVariants = {
  legacy: { description, inputSchema: legacyInputSchema },
  windowed: { description, inputSchema: windowedInputSchema },
}

export function readFilePathsOf(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const result: string[] = []
  for (const entry of paths) {
    const path =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof entry.path === 'string'
          ? entry.path
          : undefined
    const trimmed = path?.trim()
    if (trimmed) result.push(trimmed)
  }
  return result
}

export const readFilesParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema: windowedInputSchema,
  // The file listing, then one media part per image that was read, so the
  // model sees the picture rather than its bytes decoded as text.
  outputSchema: jsonToolResultSchema(fileContentsSchema.array()).rest(
    z.object({
      type: z.literal('media'),
      data: z.string(),
      mediaType: z.string(),
    }),
  ),
} satisfies $ToolParams
