import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  loadPlugin,
  pluginDataDirFor,
} from '@codebuff/common/plugins/load-plugin'
import { getPluginsRoot } from '../utils/plugins-root'
import { parsePluginSourceUrl } from '@codebuff/common/plugins/install-url'
import { loadSkillsSync } from '@codebuff/sdk'

import type { InstalledPlugin } from '@codebuff/common/plugins/load-plugin'
import type { PluginSource } from '@codebuff/common/plugins/install-url'
import type { PluginReport } from '@codebuff/common/plugins/report'

/**
 * The outcome of an install attempt. On success: the installed plugin's
 * name, version, skill and MCP server names, data dir, and any reports
 * gathered while loading (§5.2). On failure: `success: false` with the
 * reason in `error`, and nothing written under the plugins root.
 */
export interface PluginInstallResult {
  success: boolean
  pluginName?: string
  version?: string
  skillsCount?: number
  mcpServers?: string[]
  dataDir?: string
  reports?: PluginReport[]
  error?: string
}

/**
 * Per-seam overrides for the install pipeline, each optional:
 *
 * - `fetchImpl` fetches the plugin tarball; defaults to global `fetch`.
 * - `pluginsRoot` is where the plugin directory is created; defaults to
 *   `~/.agents/plugins`.
 * - `existingSkillNames` / `existingMcpServerNames` are the names the
 *   conflict check runs against; default to empty, so no name can clash.
 *   Pass the names already present in the user's skill and MCP roots so a
 *   clash aborts the install instead of registering a duplicate name.
 */
export interface PluginInstallOptions {
  fetchImpl?: (url: string) => Promise<Response>
  pluginsRoot?: string
  existingSkillNames?: () => Set<string>
  existingMcpServerNames?: () => Set<string>
}

/**
 * Installs a plugin from a GitHub URL: parse the URL into repo
 * coordinates, fetch the codeload tarball, extract only the plugin
 * subdirectory, load its manifest — the manifest alone decides whether a
 * plugin exists (§5.3) — check name conflicts against the user's roots,
 * and only then move it into place and provision the data dir. Any
 * failure removes the temp dir and writes nothing under the plugins root.
 */
export async function handlePluginInstall(
  url: string,
  options: PluginInstallOptions = {},
): Promise<PluginInstallResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const pluginsRoot = options.pluginsRoot ?? getPluginsRoot()
  const existingSkillNames =
    options.existingSkillNames ?? (() => new Set<string>())
  const existingMcpServerNames =
    options.existingMcpServerNames ?? (() => new Set<string>())

  const fail = (error: string): PluginInstallResult => ({
    success: false,
    error,
  })

  const parsed = parsePluginSourceUrl(url)
  if (!parsed.ok) {
    return fail(parsed.reason)
  }

  let tempDir: string | undefined
  try {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'freebuff-plugin-install-'))

    const downloaded = await downloadPluginSource(fetchImpl, {
      ...parsed.source,
      tempDir,
    })
    if (!downloaded.ok) {
      return fail(downloaded.reason)
    }

    const pluginRoot = downloaded.pluginRoot

    const load = loadPlugin(pluginRoot, (skillsDir) =>
      loadSkillsSync({ skillsPath: skillsDir }),
    )
    if (!load.ok) {
      return fail(`invalid plugin: ${load.reason}`)
    }

    const name = load.plugin.manifest.name
    const conflict = checkConflicts(load.plugin, {
      existingSkillNames: existingSkillNames(),
      existingMcpServerNames: existingMcpServerNames(),
    })
    if (conflict) {
      return fail(conflict)
    }

    const destination = path.join(pluginsRoot, name)
    if (existsSync(destination)) {
      return fail(
        `${name} is already installed at ${destination} — uninstall it first to reinstall`,
      )
    }

    const dataDir = installPluginAt(load.plugin, pluginRoot, destination)

    return {
      success: true,
      pluginName: name,
      version: load.plugin.manifest.version,
      skillsCount: Object.keys(load.plugin.skills).length,
      mcpServers: Object.keys(load.plugin.mcpServers),
      dataDir,
      reports: load.reports,
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

/**
 * Fetches the codeload tarball for the repo coordinates and extracts the
 * requested subpath into the temp dir. The tarball's entries sit under a
 * top-level `<repo>-<ref>/` directory; with a subpath, the plugin root is
 * one deeper.
 */
async function downloadPluginSource(
  fetchImpl: (url: string) => Promise<Response>,
  source: PluginSource & { tempDir: string },
): Promise<{ ok: true; pluginRoot: string } | { ok: false; reason: string }> {
  const { owner, repo, ref, subpath, tempDir } = source

  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`
  const response = await fetchImpl(archiveUrl)
  if (!response.ok) {
    return {
      ok: false,
      reason: `could not download the plugin source (${response.status} from ${archiveUrl})`,
    }
  }

  const archive = new Bun.Archive(await response.blob())
  const glob = subpath ? [`*/${subpath}/**`, `*/${subpath}/*`] : undefined
  const extractedCount = await archive.extract(tempDir, { glob })

  const pluginRoot = findPluginRoot(tempDir, subpath)
  if (!pluginRoot) {
    return {
      ok: false,
      reason: `no plugin found at ${subpath ? `${subpath} in ` : ''}${owner}/${repo}${ref === 'HEAD' ? '' : `@${ref}`} (${extractedCount} entries extracted)`,
    }
  }

  return { ok: true, pluginRoot }
}

/**
 * Locates the extracted plugin root inside the temp dir: the single
 * top-level `<repo>-<ref>/` directory, plus the subpath when one was
 * requested. Returns null when the expected directory is missing.
 */
function findPluginRoot(
  tempDir: string,
  subpath: string | null,
): string | null {
  const topLevel = readdirSync(tempDir, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  )
  if (topLevel.length !== 1) return null
  const repoDir = path.join(tempDir, topLevel[0]!.name)

  if (!subpath) return repoDir

  const pluginRoot = path.join(repoDir, ...subpath.split('/'))
  return existsSync(pluginRoot) ? pluginRoot : null
}

/**
 * Returns the skill and MCP server names that already exist in the given
 * sets, or null when none do. The plugin's own name is checked separately
 * by the caller, against the plugins root.
 */
function checkConflicts(
  plugin: {
    manifest: { name: string }
    skills: Record<string, unknown>
    mcpServers: Record<string, unknown>
  },
  existing: {
    existingSkillNames: Set<string>
    existingMcpServerNames: Set<string>
  },
): string | null {
  const skillClash = Object.keys(plugin.skills).filter((n) =>
    existing.existingSkillNames.has(n),
  )
  if (skillClash.length > 0) {
    return `skill name${skillClash.length > 1 ? 's' : ''} already in use: ${skillClash.join(', ')}`
  }

  const serverClash = Object.keys(plugin.mcpServers).filter((n) =>
    existing.existingMcpServerNames.has(n),
  )
  if (serverClash.length > 0) {
    return `MCP server name${serverClash.length > 1 ? 's' : ''} already in use: ${serverClash.join(', ')}`
  }

  return null
}

/**
 * Moves the loaded plugin into the plugins root under the manifest's name
 * and provisions the client-managed data dir, returning its path — the one
 * mkdir the load leaves to the installer (§9.1).
 */
function installPluginAt(
  plugin: InstalledPlugin,
  pluginRoot: string,
  destination: string,
): string {
  cpSync(pluginRoot, destination, { recursive: true })

  const dataDir = pluginDataDirFor(destination, plugin.manifest)
  mkdirSync(dataDir, { recursive: true })

  return dataDir
}
