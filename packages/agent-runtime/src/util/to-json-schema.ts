import z from 'zod/v4'

// Convert a tool's stored inputSchema into JSON Schema suitable for Anthropic's
// count_tokens API. Built-in and MCP tools store a Zod schema here; serializing
// it raw ships Zod internals (`def`/`shape`) instead of JSON Schema, so token
// counts are computed against garbage and any schema whose top-level isn't an
// object (e.g. a union → `anyOf`) arrives without `type`, which the API rejects
// with `tools.N.custom.input_schema.type: Field required`. We convert to JSON
// Schema and guarantee a top-level `type: 'object'`.
//
// Lives in util/ (not run-agent-step) so spawn-agent-inline can use it without
// an import cycle through run-agent-step.
export function toTokenCountInputSchema(
  inputSchema: unknown,
): Record<string, unknown> | undefined {
  if (inputSchema == null) return undefined

  let jsonSchema: Record<string, unknown>
  if (
    typeof (inputSchema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    try {
      jsonSchema = z.toJSONSchema(inputSchema as z.ZodType, {
        io: 'input',
      }) as Record<string, unknown>
    } catch {
      jsonSchema = { type: 'object', properties: {} }
    }
  } else if (typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    // Already a plain object (e.g. a pre-serialized JSON Schema) — copy it.
    jsonSchema = { ...(inputSchema as Record<string, unknown>) }
  } else {
    return undefined
  }

  // `$schema` is meaningless to count_tokens; drop it to keep the payload lean.
  delete jsonSchema['$schema']
  // Anthropic requires a top-level `type: 'object'`. Object schemas already
  // carry it; union/intersection schemas (anyOf/allOf) don't — backfill it.
  // Treat missing / null / empty-string as absent (valid JSON Schema `type` is
  // always a non-empty string or array).
  if (jsonSchema.type == null || jsonSchema.type === '') {
    jsonSchema.type = 'object'
  }
  return jsonSchema
}
