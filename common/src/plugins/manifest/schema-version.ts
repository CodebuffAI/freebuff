/** The canonical manifest `$schema` id for Agent Plugins v1.0.0 (spec §5.2). */
const PLUGIN_MANIFEST_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/**
 * Reads the specification version the manifest declares. A `$schema` that is
 * not a string cannot name a supported version (§5.3 requires the field);
 * one that names anything but the canonical 1.0.0 id is a version this client
 * does not support, and §5.2 requires reporting the version it declared
 * rather than refusing without naming it.
 *
 * This module is everything a new supported version touches: the id above,
 * the selection below, and their tests.
 */
export function readSchemaVersion(
  fields: Record<string, unknown>,
): { ok: true; schema: string } | { ok: false; reason: string } {
  const value = fields.$schema
  if (typeof value !== 'string') {
    return { ok: false, reason: 'manifest.$schema must be a string (§5.3)' }
  }

  if (value !== PLUGIN_MANIFEST_SCHEMA_ID) {
    return {
      ok: false,
      reason: `unsupported manifest $schema "${value}" (§5.2)`,
    }
  }

  return { ok: true, schema: value }
}
