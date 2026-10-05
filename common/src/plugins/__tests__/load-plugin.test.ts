import path from 'node:path'

import { rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, test } from 'bun:test'

import { loadPlugin } from '../load-plugin'

import { expectPluginOk, expectPluginRejected } from './fixtures/load-plugin'
import { INVALID_JSON_TEXT, makeMCPRoot } from './fixtures/mcp'
import { MINIMAL_NAME } from './fixtures/manifest'
import { SKILL_NAME, makeRootWithSkill } from './fixtures/skills'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

// The real reader, imported by file so the barrel (and its tree-sitter
// wasm) stays out — the same care `parse-skill.ts` documents. Test-only:
// the production graph gains no common → sdk edge, because `loadPlugin`
// takes the reader as a parameter; the session wiring passes the SDK's.
import { loadSkillsSync } from '../../../../sdk/src/skills/load-skills'

afterEach(cleanUpPluginFixtures)

const readSkills = (dir: string) => loadSkillsSync({ skillsPath: dir })

describe('loadPlugin composition', () => {
  /**
   * Given a root carrying all three components, when loaded, the entity
   * carries the manifest, the loaded skills and servers, and the
   * client-managed data dir path the §9.1 `.data` rule fixes — computed,
   * not created: provisioning is the install's one mkdir.
   */
  test('composes manifest, skills, and MCP into the entity', () => {
    const root = makeRootWithSkill()
    writeFileSync(path.join(root, 'mcp.json'), INVALID_JSON_TEXT, 'utf8')

    const result = expectPluginOk(loadPlugin(root, readSkills))

    expect(result.plugin.manifest.name).toBe(MINIMAL_NAME)
    expect(Object.keys(result.plugin.skills)).toEqual([SKILL_NAME])
    expect(result.plugin.mcpServers).toEqual({})
    expect(result.plugin.dataDir).toBe(
      path.join(path.dirname(root), '.data', MINIMAL_NAME),
    )
    expect(
      result.reports.some((r) => r.message.includes('not valid JSON')),
    ).toBe(true)
  })

  /**
   * Given a root whose manifest fails, when loaded, the load itself
   * fails — the manifest alone decides whether the plugin exists (§5.3)
   * — and the failure is the manifest's, with no component work done.
   */
  test('a manifest failure is the load failure', () => {
    const root = makeRootWithSkill()
    rmSync(path.join(root, 'plugin.json'))

    expectPluginRejected(loadPlugin(root, readSkills), 'plugin.json')
  })

  /**
   * Given a root with a valid manifest and a broken mcp.json, when
   * loaded, the plugin still loads with empty servers and the refusal
   * reported — component outcomes never fail the plugin (§7.2.2).
   */
  test('a refused component rides as reports while the plugin loads', () => {
    const root = makeMCPRoot(INVALID_JSON_TEXT)

    const result = expectPluginOk(loadPlugin(root, readSkills))

    expect(result.plugin.mcpServers).toEqual({})
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.section).toBe('§7.2')
  })
})
