/**
 * JSON value predicates the plugin component rules share. Nothing here knows
 * about plugins: a rule that needs to ask "is this a JSON object?" should not
 * have to import the rules of an unrelated component to find out.
 */

/**
 * True for a JSON object: not a primitive, not null, not an array. The null
 * check is required because `typeof null === 'object'`.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
