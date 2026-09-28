import { jsonSchema as wrapJsonSchema } from 'ai'
import z from 'zod/v4'

import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * Ensures the inputSchema is a Zod schema. If it's a JSON Schema object
 * (from SDK custom tools that were serialized), converts it to Zod.
 */
export function ensureZodSchema(
  schema: z.ZodType | Record<string, unknown>,
): z.ZodType {
  // Check if it's already a Zod schema by looking for the safeParse method
  if (
    schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    return schema as z.ZodType
  }
  // JSON Schema object - convert to Zod
  return convertJsonSchemaToZod(schema as Record<string, unknown>)
}

function ensureJsonSchemaCompatible(schema: z.ZodType): z.ZodType {
  try {
    z.toJSONSchema(schema, { io: 'input' })
    return schema
  } catch {
    const fallback = z.object({}).passthrough()
    return schema.description ? fallback.describe(schema.description) : fallback
  }
}

/**
 * Prepares a custom tool's inputSchema for the AI SDK. The schema ends up in
 * two places, with different fidelity requirements:
 *
 * 1. The tool definition sent to the LLM provider. The model reads this to
 *    decide what arguments to emit, so it must match what the MCP server
 *    declared. JSON Schema inputs are therefore passed through verbatim,
 *    wrapped in ai's jsonSchema() (a pass-through container).
 * 2. Argument validation at call time (the validate callback below).
 *    Approximation is acceptable here — a wrong rejection is recoverable,
 *    the model can retry — so the zod conversion does this job.
 *
 * Converting the schema to zod and back would be lossy: schemas zod cannot
 * represent (e.g. a property typed only `{ "type": "object" }`) come back
 * as an empty object schema, and a model reading an empty argument schema
 * emits `{}` — a tool call with no arguments. Zod-typed inputSchemas
 * (internal tools defined in TypeScript) keep the
 * ensureJsonSchemaCompatible path, which converts in one direction only.
 */
export function serveInputSchema(
  inputSchema: z.ZodType | Record<string, unknown>,
  opts?: { logger?: Logger; name?: string },
): z.ZodType | ReturnType<typeof wrapJsonSchema> {
  if (
    inputSchema &&
    typeof (inputSchema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    return ensureJsonSchemaCompatible(inputSchema as z.ZodType)
  }
  const rawJsonSchema = inputSchema as Record<string, unknown>
  // Validation only. The zod conversion handles checking arguments fine;
  // its weakness is serializing back to JSON Schema, which we never do here.
  const validationSchema = ensureZodSchema(rawJsonSchema)
  const served = wrapJsonSchema(
    rawJsonSchema as unknown as Parameters<typeof wrapJsonSchema>[0],
    {
      validate: (value: unknown) => {
        const result = validationSchema.safeParse(value)
        return result.success
          ? { success: true as const, value: result.data }
          : { success: false as const, error: result.error }
      },
    },
  )
  if (
    typeof rawJsonSchema.description === 'string' &&
    rawJsonSchema.description.length > 0
  ) {
    ;(served as { description?: string }).description ??=
      rawJsonSchema.description
  }
  return served
}
