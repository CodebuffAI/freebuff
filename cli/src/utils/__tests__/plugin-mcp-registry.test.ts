import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { mcpConfigSchema } from '@codebuff/common/types/mcp'

import { pluginMcpServers } from '../plugin-discovery'

import {
  cleanUpPluginTestDirs,
  makeTempDir,
  PLUGIN_JSON,
  SKILL_MD,
} from '../../__tests__/helpers/plugin-fixtures'

afterEach(cleanUpPluginTestDirs)

/**
 * Writes one plugin root: manifest, one skill directory, and the given
 * MCP server declarations — a complete plugin, so a row can also show
 * that loading its MCP servers never reaches for its skills (§7.2
 * declares none; the skills walk is a different composition).
 */
function writePluginRoot(pluginDir: string, mcpServers: object): void {
  mkdirSync(path.join(pluginDir, 'skills', 'gcloud'), { recursive: true })
  writeFileSync(path.join(pluginDir, 'skills', 'gcloud', 'SKILL.md'), SKILL_MD)
  writeFileSync(path.join(pluginDir, 'plugin.json'), PLUGIN_JSON)
  writeFileSync(
    path.join(pluginDir, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers,
    }),
  )
}

describe('plugin MCP servers for the session server map', () => {
  /**
   * Given an installed plugin declaring a spec streamable-http server —
   * a complete plugin, skills/ included — when the plugin half of the
   * server map loads, the server comes back under its own name in the
   * freebuff shape the session's server schema accepts, with the
   * plugin-only fields gone and the skill side untouched.
   */
  test("an agent plugin's MCP server arrives in the freebuff shape", () => {
    const pluginsRoot = makeTempDir('plugin-mcp-test-')
    writePluginRoot(pluginsRoot + '/test-plugin', {
      'developer-knowledge': {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
      },
    })

    const servers = pluginMcpServers({ pluginsRoot })

    const parsed = mcpConfigSchema.safeParse(servers['developer-knowledge'])
    expect(parsed.success).toBe(true)
    expect(servers['developer-knowledge']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      params: {},
      headers: {},
    })
  })

  /**
   * Given two installed plugins each declaring a server, when the plugin
   * half of the server map loads, both come back in one map.
   */
  test('servers from several plugins merge into one map', () => {
    const pluginsRoot = makeTempDir('plugin-mcp-test-')
    writePluginRoot(pluginsRoot + '/plugin-a', {
      'server-a': { type: 'streamable-http', url: 'https://a.example/mcp' },
    })
    writePluginRoot(pluginsRoot + '/plugin-b', {
      'server-b': {
        type: 'streamable-http',
        url: 'https://b.example/mcp',
      },
    })

    const servers = pluginMcpServers({ pluginsRoot })

    expect(Object.keys(servers).sort()).toEqual(['server-a', 'server-b'])
  })

  /**
   * Given no plugins root at all (a fresh machine), when the plugin half
   * of the server map loads, the result is empty — absence contributes
   * nothing.
   */
  test('a missing plugins root contributes nothing', () => {
    const servers = pluginMcpServers({
      pluginsRoot: path.join(makeTempDir('plugin-mcp-test-'), 'does-not-exist'),
    })

    expect(servers).toEqual({})
  })
})
