import { readdirSync } from 'node:fs'

import type { Dirent } from 'node:fs'
import path from 'node:path'

import { loadSkillsSync } from '@codebuff/sdk'

import { loadManifest } from '@codebuff/common/plugins/load-plugin-manifest'
import { loadPluginSkills } from '@codebuff/common/plugins/skills'
import { loadPluginMCP } from '@codebuff/common/plugins/mcp-config'

import { getPluginsRoot } from './plugins-root'

import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { SkillsMap } from '@codebuff/common/types/skill'

/**
 * Reads one skills directory into the SDK's skill shape.
 */
export type ReadSkillsDir = (skillsDir: string) => SkillsMap

/** Test overrides; production runs the SDK reader over the real root. */
export interface PluginSkillsOptions {
  readSkillsDir?: ReadSkillsDir
  pluginsRoot?: string
}

/**
 * The plugin directories directly under the root, name order. A missing
 * or unreadable root is no plugins (a fresh machine, not an error).
 */
function installedPluginRoots(pluginsRoot: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => path.join(pluginsRoot, entry.name))
}

/**
 * Skills from every installed plugin, for the registry to assign over its
 * cache. The join is plugin-last: a plugin skill wins a same-name skill
 * added to the user's roots after install — the precedence question
 * recorded for the maintainers.
 */
export function pluginSkills(options: PluginSkillsOptions = {}): SkillsMap {
  const readSkillsDir = options.readSkillsDir ?? sdkReadSkillsDir

  const skills = installedPluginRoots(
    options.pluginsRoot ?? getPluginsRoot(),
  ).map((root) => {
    if (!loadManifest(root).ok) return {}
    const result = loadPluginSkills(root, readSkillsDir)
    return result.ok ? result.skills : {}
  })

  return Object.assign({}, ...skills)
}

/**
 * The production reader: the SDK's sync loader pointed at one directory.
 */
const sdkReadSkillsDir = (skillsPath: string): SkillsMap =>
  loadSkillsSync({ skillsPath, verbose: false })

/** Test override for the plugins root; production reads the real one. */
export interface PluginMcpOptions {
  pluginsRoot?: string
}

/**
 * MCP servers from every installed plugin, for the registry to assign
 * over its cache. The join is plugin-last: a plugin server wins a
 * same-name server added to the user's own mcp.json after install (the
 * same precedence question). The configs are freebuff shapes, so the
 * session cannot tell a plugin server from one the user wrote.
 */
export function pluginMcpServers(
  options: PluginMcpOptions = {},
): Record<string, MCPConfig> {
  const servers = installedPluginRoots(
    options.pluginsRoot ?? getPluginsRoot(),
  ).map((root) => {
    if (!loadManifest(root).ok) return {}
    const result = loadPluginMCP(root)
    return result.ok ? result.servers : {}
  })

  return Object.assign({}, ...servers)
}
