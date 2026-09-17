import { readFileSync } from 'node:fs'
import path from 'node:path'

import { resolvesWithinRoot } from './containment'
import { validateExtensions } from './manifest/extensions'
import { readMetadata } from './manifest/metadata'
import { readPluginName } from './manifest/plugin-name'
import { readSchemaVersion } from './manifest/schema-version'
import {
  reportUnknownFields,
  requireTopLevelObject,
} from './manifest/top-level-fields'

import type { PluginManifest } from './manifest/plugin-manifest'
import type { PluginReport } from './report'

/**
 * Reads and validates `plugin.json` for Agent Plugins v1.0.0 — the load use
 * case of the manifest component. An invalid manifest means the plugin does
 * not exist, and nothing else may be discovered or executed (spec §5.3).
 *
 * This module owns the §5.2 fatality order: which rule runs when, and that
 * only an unknown top-level field or a non-object `extensions` keeps the load
 * going. The rules themselves live one section per module in `manifest/`, and
 * the contract they share lives in `manifest/plugin-manifest.ts`.
 *
 * Spec: github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md
 */

/**
 * Either a valid manifest with any spec-mandated reports, or the reason the
 * plugin does not exist (spec §5.3). Reports are present in both branches,
 * so callers can render them whichever way the load went.
 */
export type LoadManifestResult =
  | { ok: true; manifest: PluginManifest; reports: PluginReport[] }
  | { ok: false; reason: string; reports: PluginReport[] }

/**
 * Loads and validates the manifest at `root/plugin.json`. Per spec §5.3, the
 * manifest alone decides whether the plugin exists: an invalid one means the
 * plugin does not exist, so this is the only step whose failure stops
 * discovery entirely.
 * Failures and spec-mandated reports are returned in the result:
 * `ok: false` with a reason, or `ok: true` with reports to render.
 *
 * The two non-fatal §5.2 violations are collected before the fatal rules run,
 * because the spec requires them reported even when the manifest they sit on
 * is otherwise rejected.
 */
export function loadManifest(root: string): LoadManifestResult {
  const file = readPluginJson(root)
  if (!file.ok) return { ok: false, reason: file.reason, reports: [] }

  const json = parsePluginJson(file.raw)
  if (!json.ok) return { ok: false, reason: json.reason, reports: [] }

  const topLevel = requireTopLevelObject(json.parsed)
  if (!topLevel.ok) return { ok: false, reason: topLevel.reason, reports: [] }

  const extensions = validateExtensions(topLevel.fields)
  const reports = [
    ...reportUnknownFields(topLevel.fields),
    ...extensions.reports,
  ]

  const schema = readSchemaVersion(topLevel.fields)
  if (!schema.ok) return { ok: false, reason: schema.reason, reports }

  const name = readPluginName(topLevel.fields)
  if (!name.ok) return { ok: false, reason: name.reason, reports }

  const metadata = readMetadata(topLevel.fields)
  if (!metadata.ok) return { ok: false, reason: metadata.reason, reports }

  return {
    ok: true,
    manifest: {
      $schema: schema.schema,
      name: name.name,
      ...metadata.values,
      ...(extensions.extensions && { extensions: extensions.extensions }),
    },
    reports,
  }
}

/**
 * Reads the manifest text at `<root>/plugin.json`, or the reason it cannot be
 * used: no manifest there (§5.1), or one resolving outside the plugin root,
 * which §4.1.1's first failure boundary rejects outright. Containment is
 * settled here, before the read, so the later components inherit it instead
 * of each repeating the check.
 */
function readPluginJson(
  root: string,
): { ok: true; raw: string } | { ok: false; reason: string } {
  const file = path.join(root, 'plugin.json')

  try {
    if (!resolvesWithinRoot(root, file)) {
      return {
        ok: false,
        reason: 'plugin.json resolves outside the plugin root (§4.1.1)',
      }
    }

    return { ok: true, raw: readFileSync(file, 'utf8') }
  } catch {
    return { ok: false, reason: 'no plugin.json at the plugin root (§5.1)' }
  }
}

/** Parses the manifest text, or the §5.2 refusal when it is not JSON. */
function parsePluginJson(
  raw: string,
): { ok: true; parsed: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, parsed: JSON.parse(raw) }
  } catch {
    return { ok: false, reason: 'plugin.json is not valid JSON (§5.2)' }
  }
}
