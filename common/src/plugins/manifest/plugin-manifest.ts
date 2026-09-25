/**
 * The manifest contract for Agent Plugins v1.0.0 (spec §5): the value the
 * field rules accept and the loader returns.
 *
 * These types are the leaf of the manifest graph — every rule module imports
 * them and none of them imports another — because every other component in
 * the subsystem may need to name a manifest without adopting its rules.
 */

/**
 * The §5.4 author object. Every field is optional, but the object is closed:
 * a fourth field, or a value that is not a string, invalidates the manifest.
 * That is the one §5.4 constraint stricter than the JSON-type rule.
 */
export interface PluginAuthor {
  name?: string
  email?: string
  url?: string
}

/**
 * The parsed manifest (spec §5). An invalid manifest means the plugin does
 * not exist — no components may be discovered or executed (§5.3). Metadata
 * values are carried as the author declared them: their JSON type is
 * checked, never their content (§5.4).
 */
export interface PluginManifest {
  $schema: string
  name: string
  /**
   * Client extension data (§8.1): carried verbatim when present and
   * object-shaped; freebuff reads no namespace values. Undefined when
   * absent or when a non-object value was reported and ignored.
   */
  extensions?: Record<string, unknown>
  version?: string
  description?: string
  author?: PluginAuthor
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
}
