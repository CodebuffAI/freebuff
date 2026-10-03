import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { loadPluginMCP } from '../mcp-config'

import {
  EXPECTED_DEVELOPER_KNOWLEDGE_CONFIG,
  EXPECTED_LINT_RUNNER_CONFIG,
  INVALID_JSON_TEXT,
  MIXED_ENTRIES_JSON,
  REAL_BUNDLE_MCP_CONFIG_JSON,
  REAL_BUNDLE_MCP_JSON,
  TWO_SERVERS_JSON,
  UNSUPPORTED_SCHEMA_MCP_JSON,
  expectMCPInvalid,
  expectMCPOk,
  makeEscapingMCPRoot,
  makeMCPRoot,
  makeRootWithMCPDir,
} from './fixtures/mcp'

import { expectManifestOk, makeManifestRoot } from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('mcp component (spec §7.2)', () => {
  /**
   * Given a plugin root with no mcp.json, when loaded, MCP contributes no
   * servers and no error (§6.2: an absent fixed location is not an error),
   * and the same holds when mcp.json exists but is a directory rather than
   * a regular file — wrong kind, not absence, but the component result
   * the session needs is identical.
   */
  test('missing mcp.json is not an error', () => {
    const root = makeManifestRoot()

    const result = loadPluginMCP(root)

    const servers = expectMCPOk(result)
    expect(servers).toEqual({})
    expect(result.reports).toEqual([])
  })

  /**
   * Given an mcp.json that is a directory, when loaded, the component
   * yields no servers without an error and without reading anything —
   * §6.2 treats the wrong filesystem kind as component-invalid; the walk
   * answers it with an empty set so the plugin still loads.
   */
  test('a directory at mcp.json yields no servers', () => {
    const root = makeRootWithMCPDir()

    const result = loadPluginMCP(root)

    const servers = expectMCPOk(result)
    expect(servers).toEqual({})
  })

  /**
   * Given an mcp.json that is a reparse point resolving outside the plugin
   * root, when loaded, MCP is refused under §4.1.1 — this component has
   * its own read path, so its containment wiring is proved here rather
   * than inherited from the manifest's.
   */
  test('an mcp.json resolving outside the root is refused', () => {
    const root = makeEscapingMCPRoot()

    const result = loadPluginMCP(root)

    expectMCPInvalid(result, '§4.1.1')
  })

  /**
   * Given an mcp.json that is not valid JSON, when loaded, MCP is disabled
   * for the plugin with a report while skills still load — §7.2.2 rules 2.
   */
  test('mcp.json that is not valid JSON disables MCP with a report', () => {
    const root = makeMCPRoot(INVALID_JSON_TEXT)

    const result = loadPluginMCP(root)

    const reports = expectMCPInvalid(result, 'not valid JSON')
    expect(reports).toHaveLength(1)
    expect(reports[0]?.severity).toBe('warning')
  })

  /**
   * Given an mcp.json targeting a spec version the client cannot load,
   * when loaded, MCP is disabled with a report — §7.2.2 rule 2, the
   * unsupported-$schema branch of the readability failures.
   */
  test('an unrecognized $schema disables MCP with a report', () => {
    const root = makeMCPRoot(UNSUPPORTED_SCHEMA_MCP_JSON)

    const result = loadPluginMCP(root)

    expectMCPInvalid(result, '$schema')
  })

  /**
   * Given two server entries where one does not satisfy the freebuff
   * server shape, when loaded, the refused one is skipped with a report and
   * sibling loads — §7.2.2 rule 3, the skip-and-report invariant the scope
   * cut relies on for its mitigation.
   */
  test('one refused entry is skipped and its sibling loads', () => {
    const root = makeMCPRoot(MIXED_ENTRIES_JSON)

    const result = loadPluginMCP(root)

    const servers = expectMCPOk(result)
    expect(Object.keys(servers)).toEqual(['working'])
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.message).toContain('broken')
  })

  /**
   * Given an mcp.json with two conforming entries — one remote, one stdio
   * — when loaded, both arrive mapped and no report is written: §7.2's
   * `mcpServers` is a map, so a plugin carrying several MCP servers is the
   * bare-bones contract, not an edge case.
   */
  test('two conforming entries both load', () => {
    const root = makeMCPRoot(TWO_SERVERS_JSON)

    const result = loadPluginMCP(root)

    const servers = expectMCPOk(result)
    expect(servers).toEqual({
      'developer-knowledge': EXPECTED_DEVELOPER_KNOWLEDGE_CONFIG,
      'lint-runner': EXPECTED_LINT_RUNNER_CONFIG,
    })
    expect(result.reports).toEqual([])
  })

  /**
   * Given the real bundle's root — mcp.json present alongside
   * mcp_config.json (the Gemini CLI extension shape, which the spec says
   * nothing about; Google ships it for another client) — when loaded,
   * exactly one server arrives and no report mentions either decoy: only
   * mcp.json is the MCP configuration path (§7.2), so a foreign plugin's
   * extra files are invisible, not noise.
   */
  test('only mcp.json loads and the decoys stay invisible', () => {
    const root = makeMCPRoot()
    writeFileSync(
      path.join(root, 'mcp_config.json'),
      REAL_BUNDLE_MCP_CONFIG_JSON,
      'utf8',
    )

    const result = loadPluginMCP(root)

    const servers = expectMCPOk(result)
    expect(servers).toEqual({
      'developer-knowledge': EXPECTED_DEVELOPER_KNOWLEDGE_CONFIG,
    })
    expect(result.reports).toEqual([])
  })
})
