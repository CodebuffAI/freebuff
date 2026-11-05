import { parseToolJson } from '@codebuff/common/tools/repair-tool-json'

/**
 * Repairs a custom tool's input against its JSON schema where a value's meaning is plain and only
 * its form is wrong:
 * - An object or array sent as a JSON-encoded string, where the schema wants an array or object,
 *   or a union with an object variant (`run_integration_tools` `calls`).
 *   Decoded with `parseToolJson`, so its repairs apply. Only values that start like JSON are
 *   decoded, so a union's legitimate string, or a string parameter holding code, is never touched.
 * - A number above the schema's `maximum`, clamped to it (`preview_wait` `timeoutMs: 90000`,
 *   `terminal_read` `maxChars: 32000`; ~140 calls/day in Nov 2026 traces).
 */
export function repairCustomToolInput(
  parameters: Record<string, any>,
  rawSchema: unknown,
): void {
  const properties = (rawSchema as { properties?: unknown } | null)?.properties
  if (!properties || typeof properties !== 'object') return
  for (const [param, value] of Object.entries(parameters)) {
    const schema = (properties as Record<string, any>)[param]
    if (!schema || typeof schema !== 'object') continue
    if (
      typeof value === 'number' &&
      typeof schema.maximum === 'number' &&
      value > schema.maximum
    ) {
      parameters[param] = schema.maximum
      continue
    }
    if (typeof value !== 'string') continue
    const union: unknown[] | undefined = schema.anyOf ?? schema.oneOf
    const wantsStructure =
      schema.type === 'array' ||
      schema.type === 'object' ||
      union?.some((variant: any) => variant?.type === 'object')
    const trimmed = value.trim()
    if (!wantsStructure || !/^[[{]/.test(trimmed)) continue
    const decoded = parseToolJson(trimmed)?.value
    if (decoded && typeof decoded === 'object') parameters[param] = decoded
  }
}
