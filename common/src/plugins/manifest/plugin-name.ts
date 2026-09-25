/** Inclusive upper edge for plugin names (spec §5.5 Length). */
const PLUGIN_NAME_MAX_LENGTH = 64

/**
 * Plugin names: 1–64 characters of `a-z`, `0-9`, `-`, `.`; must start and
 * end alphanumeric; no consecutive hyphens or periods (spec §5.5).
 * Fragment map: the two lookaheads ban `--`/`..`; the first class requires
 * an alphanumeric start; the optional tail requires an alphanumeric end.
 */
const PLUGIN_NAME_PATTERN =
  /^(?!.*--)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

/**
 * Reads the plugin name. A name that is not a string cannot satisfy the §5.5
 * constraints at all (§5.3 requires the field); a string that leaves the
 * pattern or the length cap is the §5.5 violation itself.
 */
export function readPluginName(
  fields: Record<string, unknown>,
): { ok: true; name: string } | { ok: false; reason: string } {
  const value = fields.name
  if (typeof value !== 'string') {
    return { ok: false, reason: 'manifest.name must be a string (§5.3)' }
  }

  if (!isValidPluginName(value)) {
    return {
      ok: false,
      reason:
        'manifest.name violates the §5.5 name constraints ' +
        '(1-64 chars of a-z, 0-9, "-", "."; starts and ends alphanumeric; no "--" or "..")',
    }
  }

  return { ok: true, name: value }
}

/**
 * True when the name satisfies every §5.5 rule: the pattern covers
 * charset, alphanumeric ends, and the no-consecutive-repeats rule; the length
 * cap is checked separately as the inclusive upper edge.
 */
function isValidPluginName(name: string): boolean {
  return PLUGIN_NAME_PATTERN.test(name) && name.length <= PLUGIN_NAME_MAX_LENGTH
}
