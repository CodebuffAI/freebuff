import { isPlainObject } from '../json-value'

import type { PluginReport } from '../report'

/**
 * The closed §5.2 top-level set — the only fields a conforming manifest may
 * carry. Keys outside it are reported, and are not copied onto the parsed
 * manifest (§5.2).
 */
const MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])

/**
 * Requires the parsed manifest to be a JSON object (§5.2: "The manifest MUST
 * be JSON and MUST contain a top-level object"). An array or a primitive is
 * fatal — the plugin does not exist — and there are no fields to read from
 * it.
 *
 * Couldn't find a definition of "object" in the spec, so assume the JSON
 * object of RFC 8259 — the structured type whose members carry names. An
 * array holds its members by position instead, and §5.2's rules are written
 * about named fields.
 */
export function requireTopLevelObject(
  parsed: unknown,
):
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; reason: string } {
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      reason: 'plugin.json must contain a top-level object (§5.2)',
    }
  }

  return { ok: true, fields: parsed }
}

/**
 * Unknown top-level fields are a non-fatal §5.2 violation: one report per
 * field, and the manifest still loads when otherwise valid. The caller must
 * return these reports even when it also rejects the manifest — the spec's
 * report requirement applies whenever a manifest is examined, not only when
 * a plugin loads.
 */
export function reportUnknownFields(
  fields: Record<string, unknown>,
): PluginReport[] {
  const unknown = Object.keys(fields).filter(
    (field) => !MANIFEST_FIELDS.has(field),
  )
  return unknown.map((field) => ({
    severity: 'warning',
    section: '§5.2',
    message: `unknown top-level field "${field}" ignored`,
  }))
}
