/**
 * Every agent definition the CLI binary ships must pass the validation the CLI
 * runs before EVERY send (`use-agent-validation.ts` -> SDK `validateAgents`,
 * which is the same `DynamicAgentTemplateSchema` check `/api/agents/validate`
 * runs after resolving spawnable ids). One invalid definition anywhere in the
 * bundle blocks every message, whatever agent the user picked.
 *
 * Freebuff 0.2.13 shipped exactly that: its two `base3-fast-worker-*`
 * definitions were valid on their own, but `loadAgentDefinitions` appended the
 * user's `.agents/` ids to every `base*` agent's `spawnableAgents`, workers
 * included, and a worker has no `spawn_agents` tool (fixed in #4961). So this
 * checks the bundle twice: as built, and as the registry actually sends it
 * once a project has custom agents and an mcp.json.
 *
 * Reads `bundled-agents.generated.ts`, which CI regenerates from `agents/`
 * (`bun run prebuild:agents`) before this suite runs, so a new or changed
 * agent file is covered with no edit here.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { AgentTemplateTypes } from '@codebuff/common/types/session-state'
import { validateAgents } from '@codebuff/sdk'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
}))

import { bundledAgents } from '../agents/bundled-agents.generated'
import { getProjectRoot, setProjectRoot } from '../project-files'
import { freebuffCatalogRootAgent } from '../utils/freebuff-catalog-agent'
import {
  __resetLocalAgentRegistryForTests,
  initializeAgentRegistry,
  loadAgentDefinitions,
} from '../utils/local-agent-registry'
import { catalogRow } from '../utils/__tests__/freebuff-catalog-fixtures'

import type { AgentDefinition } from '@codebuff/sdk'

const bundled = Object.values(bundledAgents) as AgentDefinition[]

/** Validated locally: the same schema the server applies, minus the network. */
const validationErrors = async (definitions: AgentDefinition[]) =>
  (await validateAgents(definitions, { remote: false })).validationErrors

describe('bundled agent definitions', () => {
  test('the bundle is generated and non-trivial', () => {
    expect(bundled.length).toBeGreaterThan(50)
    for (const [id, definition] of Object.entries(bundledAgents)) {
      expect((definition as AgentDefinition).id).toBe(id)
    }
  })

  test('every bundled agent passes the schema the CLI validates with', async () => {
    expect(await validationErrors(bundled)).toEqual([])
  })

  test('the catalog-mode root built at send time passes too', async () => {
    const root = freebuffCatalogRootAgent(
      catalogRow('m-flash', {
        handle: 'fbm1.opaque-handle',
        displayName: 'DeepSeek V4.1 Flash',
      }),
    )
    expect(await validationErrors([...bundled, root])).toEqual([])
  })

  // `/api/agents/validate` rejects an unqualified spawnable id that is not
  // among the definitions sent ("Invalid agent ID: … Not found"), and a
  // qualified one costs a registry lookup on every send. Bundled agents must
  // only spawn what ships beside them.
  test('every spawnable id resolves inside the bundle', () => {
    const known = new Set<string>([
      ...Object.keys(bundledAgents),
      ...Object.values(AgentTemplateTypes),
    ])
    const unresolved = bundled.flatMap((definition) =>
      (definition.spawnableAgents ?? [])
        .filter((id) => !known.has(id))
        .map((id) => `${definition.id} -> ${id}`),
    )
    expect(unresolved).toEqual([])
  })
})

describe('bundled agent definitions as the registry sends them', () => {
  let tempDir: string
  let originalCwd: string
  let originalProjectRoot: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'codebuff-bundle-validate-'))
    originalCwd = process.cwd()
    setProjectRoot(originalCwd)
    originalProjectRoot = getProjectRoot()
    process.chdir(tempDir)
    setProjectRoot(tempDir)
    __resetLocalAgentRegistryForTests()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    setProjectRoot(originalProjectRoot ?? originalCwd)
    __resetLocalAgentRegistryForTests()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('still validate with project custom agents and an mcp.json loaded', async () => {
    const agentsDir = path.join(tempDir, '.agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      path.join(agentsDir, 'custom.ts'),
      `export default {
        id: 'test-custom-agent',
        displayName: 'Custom Agent',
        model: 'anthropic/claude-sonnet-4',
        toolNames: [],
      }`,
    )
    writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { testServer: { command: 'node', args: ['server.js'] } },
      }),
    )

    await initializeAgentRegistry({ agentDirs: [agentsDir] })
    const definitions = loadAgentDefinitions()

    // The scenario is real: the custom agent loaded beside the whole bundle.
    expect(definitions.some((d) => d.id === 'test-custom-agent')).toBe(true)
    for (const id of Object.keys(bundledAgents)) {
      expect(definitions.some((d) => d.id === id)).toBe(true)
    }
    expect(await validationErrors(definitions)).toEqual([])
  })
})
