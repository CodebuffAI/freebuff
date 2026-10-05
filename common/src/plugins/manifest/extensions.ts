import { isPlainObject } from '../json-value'

import type { PluginReport } from '../report'

/**
 * A non-object extensions value is a non-fatal §8.1 violation: report, ignore,
 * continue loading. Namespace values are not validated: freebuff implements no
 * extension namespaces (§8.1).
 */
export function validateExtensions(fields: Record<string, unknown>): {
  reports: PluginReport[]
  extensions: Record<string, unknown> | undefined
} {
  const value = fields.extensions
  if (value === undefined) return { reports: [], extensions: undefined }

  if (!isPlainObject(value)) {
    return {
      reports: [
        {
          severity: 'warning',
          section: '§8.1',
          message:
            'manifest.extensions must be an object of namespace entries; value ignored',
        },
      ],
      extensions: undefined,
    }
  }

  return { reports: [], extensions: value }
}
