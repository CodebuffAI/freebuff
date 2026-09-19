import path from 'node:path'

import { loadManifest } from './load-plugin-manifest'
import { loadPluginMCP } from './mcp-config'
import { loadPluginSkills } from './skills'

import type { SkillsMap } from '../types/skill'
import type { MCPConfig } from '../types/mcp'
import type { PluginManifest } from './manifest/plugin-manifest'
import type { PluginReport } from './report'

/**
 * The installed-plugin entity: the manifest the plugin declares, the
 * component contents the client loaded from the plugin root, and the
 * client-managed data directory (spec §9.1 leaves the data location to
 * the client).
 */
export interface InstalledPlugin {
  manifest: PluginManifest
  /** Absolute path of the installed plugin root on disk. */
  root: string
  /** Absolute path of the client-managed data directory. */
  dataDir: string
  skills: SkillsMap
  mcpServers: Record<string, MCPConfig>
}

/**
 * The composition failure: the manifest is the plugin's only mandatory
 * component, so a plugin that fails to load is one whose manifest failed.
 * Component reports ride along even on success (§7.2.2: a refused MCP
 * entry or an invalid skill never fails the plugin).
 */
export type LoadPluginResult =
  | { ok: true; plugin: InstalledPlugin; reports: PluginReport[] }
  | { ok: false; reason: string; reports: PluginReport[] }

/**
 * The data-directory layout: `<pluginsRoot>/.data/<plugin-name>`. The dot
 * is deliberate — §5.5 requires plugin names to start alphanumeric, so
 * `.data` can never collide with a plugin root, whereas a literal `data/`
 * could be a plugin named "data" (§9.1 leaves the location to the client).
 */
export function pluginDataDirFor(
  root: string,
  manifest: PluginManifest,
): string {
  return path.join(path.dirname(root), '.data', manifest.name)
}

/**
 * Loads one plugin from an on-disk root: the manifest first — its failure
 * is the load's failure — then the components, whose refusals are
 * collected rather than fatal (§7.2.2). Pure with respect to the root:
 * nothing is created or written; provisioning the data directory is the
 * installer's one mkdir. The skill reader is injected because `common`
 * cannot import the SDK — the CLI passes its own
 * `loadSkills({ skillsPath })` here, the same reader it uses for the
 * user's roots.
 */
export function loadPlugin(
  root: string,
  readSkillsDir: (skillsDir: string) => SkillsMap,
): LoadPluginResult {
  const manifestResult = loadManifest(root)
  if (!manifestResult.ok) {
    return {
      ok: false,
      reason: manifestResult.reason,
      reports: manifestResult.reports,
    }
  }

  const skillsResult = loadPluginSkills(root, readSkillsDir)
  const mcpResult = loadPluginMCP(root)

  const reports = [...skillsResult.reports, ...mcpResult.reports]

  return {
    ok: true,
    plugin: {
      manifest: manifestResult.manifest,
      root,
      dataDir: pluginDataDirFor(root, manifestResult.manifest),
      skills: skillsResult.ok ? skillsResult.skills : {},
      mcpServers: mcpResult.ok ? mcpResult.servers : {},
    },
    reports,
  }
}
