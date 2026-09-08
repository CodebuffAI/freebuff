/**
 * Repairs values the model string-encoded against its schema. When a
 * parameter's declared schema is a union containing an object variant, a
 * model may emit the object as a JSON-encoded string (a string is
 * unambiguously valid for the union, so nothing downstream fails). The
 * schema-guided decode below restores the object the model meant; plain
 * strings and params without an object variant are never touched, so
 * tools whose string parameters legitimately contain JSON (script
 * sources, file contents) are unaffected.
 */
export function repairStringEncodedUnionMembers(
  parameters: Record<string, any>,
  rawSchema: unknown,
): void {
  if (!rawSchema || typeof rawSchema !== 'object') return
  const properties = (rawSchema as { properties?: Record<string, unknown> })
    .properties
  if (!properties) return
  for (const [param, value] of Object.entries(parameters)) {
    if (typeof value !== 'string') continue
    const propSchema = properties[param]
    if (!propSchema || typeof propSchema !== 'object') continue
    const union =
      (propSchema as { anyOf?: unknown[] }).anyOf ??
      (propSchema as { oneOf?: unknown[] }).oneOf
    if (!Array.isArray(union)) continue
    const hasObjectVariant = union.some(
      (variant) =>
        variant &&
        typeof variant === 'object' &&
        (variant as { type?: unknown }).type === 'object',
    )
    if (!hasObjectVariant) continue
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
    try {
      const decoded = JSON.parse(trimmed)
      if (decoded && typeof decoded === 'object') {
        parameters[param] = decoded
      }
    } catch {
      // Not JSON after all - the string is a legitimate value.
    }
  }
}
