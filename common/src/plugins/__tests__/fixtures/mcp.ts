import path from 'node:path'

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { expect } from 'bun:test'

import { linkJunction, makeOutsideDir } from './temp-roots'
import { makeManifestRoot } from './manifest'

import type { PluginReport } from '../../report'
import type { LoadMCPResult } from '../../mcp-config'
import type { MCPConfig } from '../../../types/mcp'

/**
 * The MCP-component fixtures. The plugin spec ships no reference
 * implementation to test against, so the file text below is taken from a
 * real plugin published in the wild — google/skills' google-cloud-developer
 * plugin v1.1.2 (https://github.com/google/skills/tree/main/plugins/cloud/google-cloud-developer)
 * — used only to the extent it agrees with spec §7.2. Its deviations are
 * the point of some rows: the decoys are files Google ships for *other*
 * clients' benefit, and the spec is silent on them, so the tests pin what
 * §7.2 requires of our client when it meets them.
 *
 * Root builders, the load-result assertion helpers, and the shared temp
 * machinery (in `temp-roots.ts`) live here too.
 */

/**
 * The real bundle's mcp.json text (google-cloud-developer v1.1.2), which
 * agrees with §7.2/§7.2.1 and is therefore usable as conforming input.
 */
export const REAL_BUNDLE_MCP_JSON = `{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "developer-knowledge": {
      "type": "streamable-http",
      "url": "https://developerknowledge.googleapis.com/mcp"
    }
  }
}`

/**
 * mcp_config.json, from the same real bundle: the Gemini CLI extension
 * shape (`serverUrl` + `authProviderType`) living beside mcp.json. The spec
 * says nothing about it — Google ships it for another client — and §7.2 is
 * exactly the rule that decides the question: only mcp.json is the MCP
 * configuration path, alternative core paths MUST NOT be loaded.
 */
export const REAL_BUNDLE_MCP_CONFIG_JSON = `{
  "mcpServers": {
    "developer-knowledge": {
      "serverUrl": "https://developerknowledge.googleapis.com/mcp",
      "authProviderType": "google_credentials"
    }
  }
}`

/** An mcp.json whose JSON is not valid at all. */
export const INVALID_JSON_TEXT = '{ "mcpServers": '

/**
 * An mcp.json whose server entries are one freebuff-refused entry (url of
 * the wrong JSON type) and one valid stdio sibling — the §7.2.2 rule 3
 * skip-and-report arrangement.
 */
export const MIXED_ENTRIES_JSON = `{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "broken": { "type": "streamable-http", "url": 42 },
    "working": { "type": "stdio", "command": "./bin/server" }
  }
}`

/**
 * An mcp.json with two conforming entries — the real bundle's remote one
 * plus a stdio sibling — so a row can assert both arrive: the §7.2 file is
 * a server-per-entry map, and a plugin carrying several MCP servers is
 * supported.
 */
export const TWO_SERVERS_JSON = `{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "developer-knowledge": {
      "type": "streamable-http",
      "url": "https://developerknowledge.googleapis.com/mcp"
    },
    "lint-runner": {
      "type": "stdio",
      "command": "./bin/lint-runner"
    }
  }
}`

/** An mcp.json targeting a spec version this client cannot load. */
export const UNSUPPORTED_SCHEMA_MCP_JSON = REAL_BUNDLE_MCP_JSON.replace(
  '/1.0.0/mcp.schema.json',
  '/2.0.0/mcp.schema.json',
)

/**
 * The freebuff config the adapter must produce for the real bundle's
 * `developer-knowledge` entry — `streamable-http` mapped to `http` and the
 * freebuff schema's own defaults filled, matching what the user's own
 * `~/.agents/mcp.json` parses into.
 */
export const EXPECTED_DEVELOPER_KNOWLEDGE_CONFIG: MCPConfig = {
  type: 'http',
  url: 'https://developerknowledge.googleapis.com/mcp',
  headers: {},
  params: {},
}

/**
 * The freebuff config the adapter must produce for `lint-runner` — the
 * stdio variant of `TWO_SERVERS_JSON`, with the schema's own defaults
 * filled (`args: []`, `env: {}`).
 */
export const EXPECTED_LINT_RUNNER_CONFIG: MCPConfig = {
  type: 'stdio',
  command: './bin/lint-runner',
  args: [],
  env: {},
}

/**
 * A plugin root whose mcp.json holds exactly the given text, with decoy
 * files present — the arrangement of the real bundle, so a test can show
 * neither decoy is read.
 */
export function makeMCPRoot(mcpJsonText = REAL_BUNDLE_MCP_JSON): string {
  const root = makeManifestRoot()
  writeFileSync(path.join(root, 'mcp.json'), mcpJsonText, 'utf8')
  return root
}

/** A plugin root whose mcp.json is a directory, not a regular file. */
export function makeRootWithMCPDir(): string {
  const root = makeManifestRoot()
  mkdirSync(path.join(root, 'mcp.json'))
  return root
}

/**
 * A plugin root whose mcp.json is a reparse point resolving outside the
 * plugin root — §4.1.1's boundary for the MCP component location.
 */
export function makeEscapingMCPRoot(): string {
  const root = makeMCPRoot()
  const outside = makeOutsideDir(root)
  writeFileSync(path.join(outside, 'mcp.json'), REAL_BUNDLE_MCP_JSON, 'utf8')
  rmSync(path.join(root, 'mcp.json'))
  linkJunction(path.join(root, 'mcp.json'), outside)
  return root
}

/**
 * Asserts the MCP load succeeded and returns the server map, so
 * tests assert on configs, never on the result's shape.
 */
export function expectMCPOk(result: LoadMCPResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.servers
}

/**
 * Asserts the MCP component was invalidated (not the plugin) and returns
 * the reports, so a row that also asserts on them does not need its own
 * narrowing branch. `blame` must name the § or cause the refusal cites.
 */
export function expectMCPInvalid(
  result: LoadMCPResult,
  blame: string,
): PluginReport[] {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(`expected component invalid, got ok`)
  expect(result.reason).toContain(blame)
  return result.reports
}
