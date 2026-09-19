import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { handlePluginInstall } from '../plugin-install'

import {
  cleanUpPluginTestDirs,
  expectInstallOk,
  fetchReturning,
  makeTarball,
  makeTempDir,
  MCP_JSON,
  PLUGIN_JSON,
  SKILL_MD,
} from '../../__tests__/helpers/plugin-fixtures'

import type { PluginInstallOptions } from '../plugin-install'

afterEach(cleanUpPluginTestDirs)

/**
 * Installs the standard plugin — manifest, one skill, one server — into a
 * fresh plugins root, so the success rows below each claim one observable
 * of the same install.
 */
async function installStandardPlugin(pluginsRoot: string) {
  const blob = await makeTarball({
    'skills-main/plugin.json': PLUGIN_JSON,
    'skills-main/skills/gcloud/SKILL.md': SKILL_MD,
    'skills-main/mcp.json': MCP_JSON,
  })

  return handlePluginInstall('https://github.com/google/skills', {
    fetchImpl: fetchReturning(blob),
    pluginsRoot,
    existingSkillNames: () => new Set(),
    existingMcpServerNames: () => new Set(),
  })
}

describe('plugin install', () => {
  /**
   * Given a fetched tarball carrying a valid plugin, when installed, the
   * result carries what the render needs: the manifest's name and
   * version, and the component counts.
   */
  test('the result reports the installed plugin', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')

    const result = expectInstallOk(await installStandardPlugin(pluginsRoot))

    expect(result.pluginName).toBe('test-plugin')
    expect(result.version).toBe('1.0.0')
    expect(result.skillsCount).toBe(1)
    expect(result.mcpServers).toEqual(['test-server'])
  })

  /**
   * Given the same install, when it succeeds, the plugin root lands under
   * the plugins root named after the manifest and the client-managed data
   * dir is provisioned — the one mkdir the load leaves to the installer.
   */
  test('the plugin root and its data dir land under the plugins root', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')

    expectInstallOk(await installStandardPlugin(pluginsRoot))

    const pluginRoot = path.join(pluginsRoot, 'test-plugin')

    expect(existsSync(path.join(pluginRoot, 'plugin.json'))).toBe(true)
    expect(existsSync(path.join(pluginsRoot, '.data', 'test-plugin'))).toBe(
      true,
    )
  })

  /**
   * Given a 404 from the archive endpoint, when installed, the command
   * fails with the reason and nothing is written under the plugins root.
   */
  test('a failed fetch aborts clean', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')
    const fetchFailing: PluginInstallOptions['fetchImpl'] = () =>
      Promise.resolve(new Response('not found', { status: 404 }))

    const result = await handlePluginInstall(
      'https://github.com/google/skills',
      { fetchImpl: fetchFailing, pluginsRoot },
    )

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readdirSync(pluginsRoot)).toEqual([])
  })

  /**
   * Given a tarball whose subpath holds no plugin.json, when installed,
   * the load fails — the manifest alone decides whether the plugin exists
   * (§5.3) — and nothing is written.
   */
  test('a missing manifest aborts clean', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')
    const blob = await makeTarball({
      'skills-main/README.md': 'no plugin here',
    })

    const result = await handlePluginInstall(
      'https://github.com/google/skills/tree/main/nowhere',
      { fetchImpl: fetchReturning(blob), pluginsRoot },
    )

    expect(result.success).toBe(false)
    expect(readdirSync(pluginsRoot)).toEqual([])
  })

  /**
   * Given a tarball whose manifest is invalid, when installed, the load
   * fails with the manifest reason and nothing is written.
   */
  test('an invalid manifest aborts clean', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')
    const blob = await makeTarball({
      'skills-main/plugin.json': '{"name": 42}',
    })

    const result = await handlePluginInstall(
      'https://github.com/google/skills',
      { fetchImpl: fetchReturning(blob), pluginsRoot },
    )

    expect(result.success).toBe(false)
    expect(readdirSync(pluginsRoot)).toEqual([])
  })

  /**
   * Given a plugin whose name is already installed, when installed, the
   * conflict aborts before anything moves — install never shadows an
   * existing install — and the existing install is untouched.
   */
  test('an already-installed name aborts clean', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')
    const existing = path.join(pluginsRoot, 'test-plugin')
    await Bun.write(path.join(existing, 'plugin.json'), PLUGIN_JSON)

    const blob = await makeTarball({
      'skills-main/plugin.json': PLUGIN_JSON,
    })

    const result = await handlePluginInstall(
      'https://github.com/google/skills',
      { fetchImpl: fetchReturning(blob), pluginsRoot },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('already installed')
    expect(existsSync(path.join(existing, 'plugin.json'))).toBe(true)
  })

  /**
   * Given a plugin whose skill name collides with a skill in the user's
   * roots, when installed, the conflict aborts with the name and nothing
   * is written.
   */
  test('a colliding skill name aborts clean', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')

    const blob = await makeTarball({
      'skills-main/plugin.json': PLUGIN_JSON,
      'skills-main/skills/gcloud/SKILL.md': SKILL_MD,
    })

    const result = await handlePluginInstall(
      'https://github.com/google/skills',
      {
        fetchImpl: fetchReturning(blob),
        pluginsRoot,
        existingSkillNames: () => new Set(['gcloud']),
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('gcloud')
    expect(existsSync(path.join(pluginsRoot, 'test-plugin'))).toBe(false)
  })

  /**
   * Given a plugin whose server name collides with the user's mcp.json,
   * when installed, the conflict aborts with the name and nothing is
   * written.
   */
  test('a colliding MCP server name aborts clean', async () => {
    const pluginsRoot = makeTempDir('plugin-install-test-')

    const blob = await makeTarball({
      'skills-main/plugin.json': PLUGIN_JSON,
      'skills-main/mcp.json': MCP_JSON,
    })

    const result = await handlePluginInstall(
      'https://github.com/google/skills',
      {
        fetchImpl: fetchReturning(blob),
        pluginsRoot,
        existingMcpServerNames: () => new Set(['test-server']),
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('test-server')
    expect(existsSync(path.join(pluginsRoot, 'test-plugin'))).toBe(false)
  })
})
