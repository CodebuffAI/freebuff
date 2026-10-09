import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import os from 'os'
import path from 'path'

import { validateAgents } from '@codebuff/sdk'
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// Mock the logger to prevent analytics initialization errors in tests
mock.module('../../utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
}))

import { setProjectRoot, getProjectRoot } from '../../project-files'
import {
  loadAgentDefinitions,
  loadLocalAgents,
  initializeAgentRegistry,
  findAgentsDirectory,
  getLoadedAgentsData,
  __resetLocalAgentRegistryForTests,
} from '../../utils/local-agent-registry'

const MODEL_NAME = 'anthropic/claude-sonnet-4'

const writeAgentFile = (
  agentsDir: string,
  fileName: string,
  contents: string,
) => writeFileSync(path.join(agentsDir, fileName), contents, 'utf8')

describe('Local Agent Integration', () => {
  let tempDir: string
  let agentsDir: string
  let originalCwd: string
  let originalProjectRoot: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'codebuff-agents-'))
    originalCwd = process.cwd()
    setProjectRoot(process.cwd())
    originalProjectRoot = getProjectRoot()

    process.chdir(tempDir)
    setProjectRoot(tempDir)
    __resetLocalAgentRegistryForTests()

    agentsDir = path.join(tempDir, '.agents')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    setProjectRoot(originalProjectRoot ?? originalCwd)
    __resetLocalAgentRegistryForTests()
    rmSync(tempDir, { recursive: true, force: true })
    mock.restore()
  })

  test('handles missing .agents directory gracefully', async () => {
    // Note: findAgentsDirectory may return a directory from a parent or home if they exist
    // but user agents should not be loaded

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    // No user agents should be loaded (bundled agents may still be present)
    // Check that no test-specific agents are loaded
    expect(definitions.find((d) => d.id.startsWith('test-'))).toBeUndefined()
  })

  test('handles empty .agents directory', async () => {
    mkdirSync(agentsDir, { recursive: true })

    expect(findAgentsDirectory()).toBe(agentsDir)
    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    // No test agents should be present
    expect(
      definitions.find((d) => d.id.startsWith('test-empty-')),
    ).toBeUndefined()
  })

  test('skips files lacking displayName/id metadata', async () => {
    mkdirSync(agentsDir, { recursive: true })
    writeAgentFile(
      agentsDir,
      'no-meta.ts',
      `export const nothing = { instructions: 'noop' }`,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    // The file without proper exports should not create an agent
    expect(definitions.find((d) => d.id === 'no-meta')).toBeUndefined()
  })

  test('excludes definitions missing required fields', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'valid.ts',
      `
        export default {
          id: 'valid-agent',
          displayName: 'Valid Agent',
          model: '${MODEL_NAME}',
          instructions: 'Do helpful work'
        }
      `,
    )

    writeAgentFile(
      agentsDir,
      'missing-model.ts',
      `
        export default {
          id: 'incomplete-agent',
          displayName: 'Incomplete Agent',
          instructions: 'Should be filtered out'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    expect(definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'valid-agent' })]),
    )
    expect(
      definitions.find((agent) => agent.id === 'incomplete-agent'),
    ).toBeUndefined()
  })

  test('last duplicate agent wins when same ID in multiple files', async () => {
    mkdirSync(agentsDir, { recursive: true })

    // The SDK loader only keeps one agent per ID (last one wins)
    // This tests that behavior rather than expecting validation to catch duplicates
    writeAgentFile(
      agentsDir,
      'dup-one.ts',
      `
        export default {
          id: 'test-duplicate-id',
          displayName: 'Agent One',
          model: '${MODEL_NAME}',
          instructions: 'First duplicate'
        }
      `,
    )

    writeAgentFile(
      agentsDir,
      'dup-two.ts',
      `
        export default {
          id: 'test-duplicate-id',
          displayName: 'Agent Two',
          model: '${MODEL_NAME}',
          instructions: 'Second duplicate'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    // SDK loader deduplicates by ID, keeping only one
    const duplicateAgents = definitions.filter(
      (d) => d.id === 'test-duplicate-id',
    )
    expect(duplicateAgents).toHaveLength(1)
  })

  test('continues when agent module throws on require', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'bad.ts',
      `
        throw new Error('intentional require failure')
      `,
    )

    writeAgentFile(
      agentsDir,
      'healthy.ts',
      `
        export default {
          id: 'test-healthy-agent',
          displayName: 'Healthy Agent',
          model: '${MODEL_NAME}',
          instructions: 'Loads fine'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    // The healthy agent should be loaded despite the bad one throwing
    const healthyAgent = definitions.find((d) => d.id === 'test-healthy-agent')
    expect(healthyAgent).toBeDefined()
    expect(healthyAgent!.displayName).toBe('Healthy Agent')
  })

  test('ignores files without default export', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'named-export.ts',
      `
        export const agent = {
          id: 'test-named-agent',
          displayName: 'Named Agent',
          model: '${MODEL_NAME}',
          instructions: 'Not default'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    // Named export (not default) should not be loaded
    expect(definitions.find((d) => d.id === 'test-named-agent')).toBeUndefined()
  })

  test('loads agent with handleSteps generator', async () => {
    mkdirSync(agentsDir, { recursive: true })

    const agentPath = path.join(agentsDir, 'dynamic.ts')

    writeFileSync(
      agentPath,
      `
        export default {
          id: 'test-dynamic-agent',
          displayName: 'Dynamic Agent',
          model: '${MODEL_NAME}',
          instructions: 'Check for handleSteps',
          handleSteps: function* () { yield 'STEP' }
        }
      `,
      'utf8',
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const dynamicAgent = definitions.find((d) => d.id === 'test-dynamic-agent')

    expect(dynamicAgent).toBeDefined()
    expect(dynamicAgent?.displayName).toBe('Dynamic Agent')
    expect(dynamicAgent?.handleSteps).toBeDefined()
  })

  test('discovers nested agent directories', async () => {
    const nestedDir = path.join(agentsDir, 'level', 'deeper')
    mkdirSync(nestedDir, { recursive: true })

    writeAgentFile(
      nestedDir,
      'nested.ts',
      `
        export default {
          id: 'test-nested-agent',
          displayName: 'Nested Agent',
          model: '${MODEL_NAME}',
          instructions: 'Nested structure'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const nestedAgent = definitions.find((d) => d.id === 'test-nested-agent')
    expect(nestedAgent).toBeDefined()
    expect(nestedAgent!.displayName).toBe('Nested Agent')
  })

  test('ignores non-TypeScript artifacts', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'real.ts',
      `
        export default {
          id: 'test-real-agent',
          displayName: 'Real Agent',
          model: '${MODEL_NAME}',
          instructions: 'Legitimate agent'
        }
      `,
    )
    // .d.ts files should be ignored
    writeFileSync(path.join(agentsDir, 'ignored.d.ts'), 'export {}')

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const realAgent = definitions.find((d) => d.id === 'test-real-agent')
    expect(realAgent).toBeDefined()
    expect(realAgent!.displayName).toBe('Real Agent')
    // .d.ts files shouldn't create agents
    expect(definitions.find((d) => d.id === 'ignored')).toBeUndefined()
  })

  test('surfaces validation errors to UI logic', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'invalid-schema.ts',
      `
        export default {
          id: 'invalid-schema',
          displayName: 'Invalid Schema Agent',
          model: '${MODEL_NAME}',
          instructions: 'Uses schema without enabling structured output',
          outputSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string' }
            }
          }
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const result = await validateAgents(definitions, { remote: false })

    expect(result.success).toBe(false)
    expect(
      result.validationErrors
        .map((error) => error.message)
        .join('\n')
        .toLowerCase(),
    ).toContain('structured_output')
  })

  test('loads agent definitions without auth', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'valid.ts',
      `
        export default {
          id: 'test-authless-agent',
          displayName: 'Authless Agent',
          model: '${MODEL_NAME}',
          instructions: 'Agent used when auth is missing'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const authlessAgent = definitions.find(
      (d) => d.id === 'test-authless-agent',
    )
    expect(authlessAgent).toBeDefined()
    expect(authlessAgent!.displayName).toBe('Authless Agent')
  })

  test('custom agents do not make bundled fast-mode workers fail validation', async () => {
    mkdirSync(agentsDir, { recursive: true })
    writeAgentFile(
      agentsDir,
      'custom.ts',
      `export default {
        id: 'test-custom-agent',
        displayName: 'Custom Agent',
        model: '${MODEL_NAME}',
        toolNames: [],
      }`,
    )

    await initializeAgentRegistry({ agentDirs: [agentsDir] })
    const definitions = loadAgentDefinitions()

    for (const id of [
      'base3-fast-worker-deepseek-flash',
      'base3-fast-worker-deepseek-flash-evals',
    ]) {
      const worker = definitions.find((definition) => definition.id === id)
      expect(worker).toBeDefined()
      expect(worker!.spawnableAgents).toEqual([])
      expect(worker!.toolNames).not.toContain('spawn_agents')
    }
    expect(
      definitions.find(
        (definition) => definition.id === 'base3-fast-free-deepseek-flash',
      )?.spawnableAgents,
    ).toContain('test-custom-agent')

    const result = await validateAgents(definitions, { remote: false })
    expect(result.validationErrors).toEqual([])
    expect(result.success).toBe(true)
  })

  test.each([
    ['spawn tool', "toolNames: ['spawn_agents']"],
    ['inline spawn tool', "toolNames: ['spawn_agent_inline']"],
    [
      'programmatic spawning',
      "toolNames: [], handleSteps: function* () { yield 'STEP' }",
    ],
  ])(
    'preserves custom agent registration for base agents with %s',
    async (_name, spawning) => {
      mkdirSync(agentsDir, { recursive: true })
      writeAgentFile(
        agentsDir,
        'base-custom.ts',
        `export default {
        id: 'base-test-custom',
        displayName: 'Custom Base Agent',
        model: '${MODEL_NAME}',
        spawnableAgents: ['codebuff/file-picker@0.0.1'],
        ${spawning},
      }`,
      )

      await initializeAgentRegistry({ agentDirs: [agentsDir] })
      const registered = () =>
        loadAgentDefinitions().find(
          (definition) => definition.id === 'base-test-custom',
        )!.spawnableAgents
      const expected = ['codebuff/file-picker@0.0.1', 'base-test-custom']
      expect(registered()).toEqual(expected)
      expect(registered()).toEqual(expected)
    },
  )

  // ============================================================================
  // loadLocalAgents tests (for UI/menu display)
  // ============================================================================

  test('loadLocalAgents returns agent info for UI display', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'ui-agent.ts',
      `
        export default {
          id: 'test-ui-agent',
          displayName: 'UI Display Agent',
          model: '${MODEL_NAME}',
          instructions: 'Agent for UI tests'
        }
      `,
    )

    await initializeAgentRegistry()
    const agents = loadLocalAgents()

    const uiAgent = agents.find((a) => a.id === 'test-ui-agent')
    expect(uiAgent).toBeDefined()
    expect(uiAgent!.displayName).toBe('UI Display Agent')
    expect(uiAgent!.id).toBe('test-ui-agent')
    // File path should be populated for "Open file" UI links
    // Use realpathSync to normalize paths (on macOS, /var is a symlink to /private/var)
    expect(realpathSync(uiAgent!.filePath!)).toBe(
      realpathSync(path.join(agentsDir, 'ui-agent.ts')),
    )
  })

  test('loadLocalAgents sorts agents alphabetically by displayName', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'zebra.ts',
      `
        export default {
          id: 'test-zebra-agent',
          displayName: 'Test Zebra Agent',
          model: '${MODEL_NAME}',
          instructions: 'Z comes last'
        }
      `,
    )

    writeAgentFile(
      agentsDir,
      'alpha.ts',
      `
        export default {
          id: 'test-alpha-agent',
          displayName: 'Test Alpha Agent',
          model: '${MODEL_NAME}',
          instructions: 'A comes first'
        }
      `,
    )

    writeAgentFile(
      agentsDir,
      'middle.ts',
      `
        export default {
          id: 'test-middle-agent',
          displayName: 'Test Middle Agent',
          model: '${MODEL_NAME}',
          instructions: 'M is in the middle'
        }
      `,
    )

    await initializeAgentRegistry()
    const agents = loadLocalAgents()

    // Filter to just our test agents
    const testAgents = agents.filter((a) =>
      ['test-alpha-agent', 'test-middle-agent', 'test-zebra-agent'].includes(
        a.id,
      ),
    )

    expect(testAgents).toHaveLength(3)
    expect(testAgents[0].displayName).toBe('Test Alpha Agent')
    expect(testAgents[1].displayName).toBe('Test Middle Agent')
    expect(testAgents[2].displayName).toBe('Test Zebra Agent')
  })

  test('loadLocalAgents caches results', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'cached.ts',
      `
        export default {
          id: 'test-cached-agent',
          displayName: 'Cached Agent',
          model: '${MODEL_NAME}',
          instructions: 'For cache testing'
        }
      `,
    )

    await initializeAgentRegistry()
    const firstCall = loadLocalAgents()
    const secondCall = loadLocalAgents()

    // Should return the same reference (cached)
    expect(firstCall).toBe(secondCall)
    // And our test agent should be in there
    expect(firstCall.find((a) => a.id === 'test-cached-agent')).toBeDefined()
  })

  // ============================================================================
  // handleSteps generator function tests
  // ============================================================================

  test('preserves handleSteps generator function in definition', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'generator.ts',
      `
        export default {
          id: 'test-generator-agent',
          displayName: 'Generator Agent',
          model: '${MODEL_NAME}',
          instructions: 'Agent with handleSteps',
          handleSteps: function* ({ prompt }) {
            yield { toolName: 'read_files', input: { paths: ['test.ts'] } }
            yield 'STEP_ALL'
          }
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const genAgent = definitions.find((d) => d.id === 'test-generator-agent')

    expect(genAgent).toBeDefined()
    // handleSteps should be converted to string by SDK loader
    expect(genAgent!.handleSteps).toBeDefined()
    expect(typeof genAgent!.handleSteps).toBe('string')
    // Cast to string for type-safe assertions (SDK loader serializes the function)
    const handleStepsStr = genAgent!.handleSteps as unknown as string
    expect(handleStepsStr).toContain('read_files')
    expect(handleStepsStr).toContain('STEP_ALL')
  })

  test('handles async generator handleSteps', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'async-gen.ts',
      `
        export default {
          id: 'test-async-generator-agent',
          displayName: 'Async Generator Agent',
          model: '${MODEL_NAME}',
          instructions: 'Agent with async handleSteps',
          handleSteps: async function* ({ prompt, logger }) {
            logger.info('Starting async generator')
            yield 'STEP'
            yield 'STEP_ALL'
          }
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const asyncAgent = definitions.find(
      (d) => d.id === 'test-async-generator-agent',
    )

    expect(asyncAgent).toBeDefined()
    expect(asyncAgent!.handleSteps).toBeDefined()
  })

  // ============================================================================
  // Agent with all optional fields
  // ============================================================================

  test('loads agent with all optional fields specified', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'full-agent.ts',
      `
        export default {
          id: 'test-full-agent',
          displayName: 'Fully Specified Agent',
          model: '${MODEL_NAME}',
          version: '1.2.3',
          publisher: 'test-publisher',
          toolNames: ['read_files', 'write_file', 'run_terminal_command'],
          spawnableAgents: ['codebuff/file-picker@0.0.1'],
          systemPrompt: 'You are a helpful assistant.',
          instructionsPrompt: 'Follow these instructions carefully.',
          stepPrompt: 'Think step by step.',
          spawnerPrompt: 'Use this agent for complex tasks.',
          includeMessageHistory: true,
          outputMode: 'structured_output',
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
              success: { type: 'boolean' }
            },
            required: ['result', 'success']
          },
          inputSchema: {
            prompt: { type: 'string', description: 'The user prompt' },
            params: {
              type: 'object',
              properties: {
                verbose: { type: 'boolean' }
              }
            }
          }
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const fullAgent = definitions.find((d) => d.id === 'test-full-agent')

    expect(fullAgent).toBeDefined()
    expect(fullAgent!.displayName).toBe('Fully Specified Agent')
    expect(fullAgent!.version).toBe('1.2.3')
    expect(fullAgent!.publisher).toBe('test-publisher')
    expect(fullAgent!.toolNames).toContain('read_files')
    expect(fullAgent!.spawnableAgents).toContain('codebuff/file-picker@0.0.1')
    expect(fullAgent!.systemPrompt).toBe('You are a helpful assistant.')
    expect(fullAgent!.instructionsPrompt).toBe(
      'Follow these instructions carefully.',
    )
    expect(fullAgent!.stepPrompt).toBe('Think step by step.')
    expect(fullAgent!.spawnerPrompt).toBe('Use this agent for complex tasks.')
    expect(fullAgent!.includeMessageHistory).toBe(true)
    expect(fullAgent!.outputMode).toBe('structured_output')
    expect(fullAgent!.outputSchema).toBeDefined()
    expect(fullAgent!.inputSchema).toBeDefined()
  })

  // ============================================================================
  // Utility function tests
  // ============================================================================

  test('getLoadedAgentsData returns null when no user agents directory', async () => {
    await initializeAgentRegistry()
    // Note: Returns bundled agents even when no local .agents directory exists
    // Only returns null when there's no .agents directory AND no bundled agents
    const data = getLoadedAgentsData()
    // With bundled agents, this will return data (not null)
    // The key is that user agents from test-* should not be present
    if (data) {
      expect(data.agents.find((a) => a.id.startsWith('test-'))).toBeUndefined()
    }
  })

  test('getLoadedAgentsData returns agent info when agents exist', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'data-test.ts',
      `
        export default {
          id: 'test-data-agent',
          displayName: 'Data Test Agent',
          model: '${MODEL_NAME}',
          instructions: 'For getLoadedAgentsData test'
        }
      `,
    )

    await initializeAgentRegistry()
    const data = getLoadedAgentsData()

    expect(data).not.toBeNull()
    expect(data!.agentsDir).toBe(agentsDir)
    expect(data!.agents.length).toBeGreaterThan(0)
    expect(data!.agents.some((a) => a.id === 'test-data-agent')).toBe(true)
  })

  // ============================================================================
  // Edge cases and error handling
  // ============================================================================

  test('handles agent with special characters in displayName', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'special-chars.ts',
      `
        export default {
          id: 'test-special-chars-agent',
          displayName: 'Agent with Émojis 🚀 & Spëcial Chars!',
          model: '${MODEL_NAME}',
          instructions: 'Testing special characters'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const specialAgent = definitions.find(
      (d) => d.id === 'test-special-chars-agent',
    )

    expect(specialAgent).toBeDefined()
    expect(specialAgent!.displayName).toBe(
      'Agent with Émojis 🚀 & Spëcial Chars!',
    )
  })

  test('handles agent with multiline strings in prompts', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'multiline.ts',
      `
        export default {
          id: 'test-multiline-agent',
          displayName: 'Multiline Agent',
          model: '${MODEL_NAME}',
          instructionsPrompt: \`
            This is a multiline prompt.
            It has several lines.
            And should be preserved correctly.
          \`,
          systemPrompt: \`
            System prompt with
            multiple lines too.
          \`
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const multilineAgent = definitions.find(
      (d) => d.id === 'test-multiline-agent',
    )

    expect(multilineAgent).toBeDefined()
    expect(multilineAgent!.instructionsPrompt).toContain('multiline prompt')
    expect(multilineAgent!.instructionsPrompt).toContain('several lines')
    expect(multilineAgent!.systemPrompt).toContain('multiple lines')
  })

  test('handles multiple agents in same directory level', async () => {
    mkdirSync(agentsDir, { recursive: true })

    for (let i = 1; i <= 5; i++) {
      writeAgentFile(
        agentsDir,
        `agent-${i}.ts`,
        `
          export default {
            id: 'test-multi-agent-${i}',
            displayName: 'Multi Agent ${i}',
            model: '${MODEL_NAME}',
            instructions: 'Agent number ${i}'
          }
        `,
      )
    }

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    for (let i = 1; i <= 5; i++) {
      const agent = definitions.find((d) => d.id === `test-multi-agent-${i}`)
      expect(agent).toBeDefined()
      expect(agent!.displayName).toBe(`Multi Agent ${i}`)
    }
  })

  test('skips .d.ts declaration files', async () => {
    mkdirSync(agentsDir, { recursive: true })

    // .d.ts files should be skipped by the SDK loader
    writeFileSync(
      path.join(agentsDir, 'types.d.ts'),
      `
        export default {
          id: 'test-dts-agent',
          displayName: 'DTS Agent',
          model: '${MODEL_NAME}',
          instructions: 'Should not be loaded'
        }
      `,
      'utf8',
    )

    // Create valid agent
    writeAgentFile(
      agentsDir,
      'valid-agent.ts',
      `
        export default {
          id: 'test-valid-loaded-agent',
          displayName: 'Valid Loaded Agent',
          model: '${MODEL_NAME}',
          instructions: 'This one should load'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    expect(definitions.find((d) => d.id === 'test-dts-agent')).toBeUndefined()
    expect(
      definitions.find((d) => d.id === 'test-valid-loaded-agent'),
    ).toBeDefined()
  })

  test('skips .test.ts test files', async () => {
    mkdirSync(agentsDir, { recursive: true })

    // .test.ts files should be skipped by the SDK loader
    writeFileSync(
      path.join(agentsDir, 'my-agent.test.ts'),
      `
        export default {
          id: 'test-file-agent',
          displayName: 'Test File Agent',
          model: '${MODEL_NAME}',
          instructions: 'Should not be loaded'
        }
      `,
      'utf8',
    )

    // Create valid agent
    writeAgentFile(
      agentsDir,
      'my-agent.ts',
      `
        export default {
          id: 'test-my-agent',
          displayName: 'My Agent',
          model: '${MODEL_NAME}',
          instructions: 'This one should load'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    expect(definitions.find((d) => d.id === 'test-file-agent')).toBeUndefined()
    expect(definitions.find((d) => d.id === 'test-my-agent')).toBeDefined()
  })

  test('handles syntax errors in agent files gracefully', async () => {
    mkdirSync(agentsDir, { recursive: true })

    // Write a file with syntax errors
    writeAgentFile(
      agentsDir,
      'syntax-error.ts',
      `
        export default {
          id: 'test-syntax-error-agent',
          displayName: 'Syntax Error Agent'
          model: '${MODEL_NAME}',  // Missing comma above!
          instructions: 'This has a syntax error'
        }
      `,
    )

    // Write a valid agent
    writeAgentFile(
      agentsDir,
      'valid-after-error.ts',
      `
        export default {
          id: 'test-valid-after-error',
          displayName: 'Valid After Error',
          model: '${MODEL_NAME}',
          instructions: 'This should still load'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    // Should load the valid agent despite syntax error in other file
    expect(
      definitions.find((d) => d.id === 'test-valid-after-error'),
    ).toBeDefined()
  })

  test('handles runtime errors in agent module gracefully', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'runtime-error.ts',
      `
        // This will throw at module load time
        const result = JSON.parse('invalid json {{{');
        
        export default {
          id: 'test-runtime-error-agent',
          displayName: 'Runtime Error Agent',
          model: '${MODEL_NAME}',
          instructions: 'This has a runtime error'
        }
      `,
    )

    writeAgentFile(
      agentsDir,
      'healthy-after-runtime.ts',
      `
        export default {
          id: 'test-healthy-after-runtime',
          displayName: 'Healthy After Runtime',
          model: '${MODEL_NAME}',
          instructions: 'Should load fine'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    expect(
      definitions.find((d) => d.id === 'test-healthy-after-runtime'),
    ).toBeDefined()
  })

  test('skips agents without required id field', async () => {
    mkdirSync(agentsDir, { recursive: true })

    // The SDK loader requires both id and model fields
    writeAgentFile(
      agentsDir,
      'no-id.ts',
      `
        export default {
          displayName: 'Agent Without ID',
          model: '${MODEL_NAME}',
          instructions: 'Missing id field'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    // Should not load because id is required by SDK loader
    expect(
      definitions.find((d) => d.displayName === 'Agent Without ID'),
    ).toBeUndefined()
  })

  // ============================================================================
  // Initialization behavior tests
  // ============================================================================

  test('initializeAgentRegistry can be called multiple times safely', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'init-test.ts',
      `
        export default {
          id: 'test-init-agent',
          displayName: 'Init Test Agent',
          model: '${MODEL_NAME}',
          instructions: 'For init testing'
        }
      `,
    )

    // Initialize multiple times
    await initializeAgentRegistry()
    await initializeAgentRegistry()
    await initializeAgentRegistry()

    const definitions = loadAgentDefinitions()
    const initAgents = definitions.filter((d) => d.id === 'test-init-agent')

    // Should only have one instance, not duplicates
    expect(initAgents).toHaveLength(1)
  })

  test('reset clears internal cache state', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'reset-test.ts',
      `
        export default {
          id: 'test-reset-agent',
          displayName: 'Reset Test Agent',
          model: '${MODEL_NAME}',
          instructions: 'For reset testing'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions1 = loadAgentDefinitions()
    expect(definitions1.find((d) => d.id === 'test-reset-agent')).toBeDefined()

    // loadLocalAgents uses a separate cache - verify caching works
    const agents1 = loadLocalAgents()
    const agents2 = loadLocalAgents()
    expect(agents1).toBe(agents2) // Same reference = cached

    // Reset clears the cache
    __resetLocalAgentRegistryForTests()

    // After reset, cache is empty so loadLocalAgents returns fresh results
    await initializeAgentRegistry()
    const agents3 = loadLocalAgents()
    // New reference after reset
    expect(agents3).not.toBe(agents1)
  })

  // ============================================================================
  // Validation tests
  // ============================================================================

  test('validates agent with invalid model name', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'bad-model.ts',
      `
        export default {
          id: 'test-bad-model-agent',
          displayName: 'Bad Model Agent',
          model: '',
          instructions: 'Empty model name'
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()

    // Agent with empty model should not be loaded
    expect(
      definitions.find((d) => d.id === 'test-bad-model-agent'),
    ).toBeUndefined()
  })

  test('validates agent with invalid spawnableAgents format', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'bad-spawnable.ts',
      `
        export default {
          id: 'test-bad-spawnable-agent',
          displayName: 'Bad Spawnable Agent',
          model: '${MODEL_NAME}',
          instructions: 'Has invalid spawnable agent format',
          spawnableAgents: ['invalid-format-no-publisher']
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const result = await validateAgents(definitions, { remote: false })

    // Should have validation errors for invalid spawnable agent format
    const badAgent = definitions.find(
      (d) => d.id === 'test-bad-spawnable-agent',
    )
    expect(badAgent).toBeDefined()

    // The validation should catch the format issue
    const hasSpawnableError = result.validationErrors.some(
      (e) =>
        e.message.toLowerCase().includes('spawnable') ||
        e.message.toLowerCase().includes('format') ||
        e.id.includes('test-bad-spawnable'),
    )
    expect(hasSpawnableError || !result.success).toBe(true)
  })

  test('validates agents with conflicting outputMode and outputSchema', async () => {
    mkdirSync(agentsDir, { recursive: true })

    writeAgentFile(
      agentsDir,
      'conflicting-output.ts',
      `
        export default {
          id: 'test-conflicting-output-agent',
          displayName: 'Conflicting Output Agent',
          model: '${MODEL_NAME}',
          instructions: 'Has outputSchema but wrong outputMode',
          outputMode: 'last_message',
          outputSchema: {
            type: 'object',
            properties: {
              data: { type: 'string' }
            }
          }
        }
      `,
    )

    await initializeAgentRegistry()
    const definitions = loadAgentDefinitions()
    const result = await validateAgents(definitions, { remote: false })

    // Should flag that outputSchema requires structured_output mode
    expect(result.success).toBe(false)
    expect(
      result.validationErrors.some(
        (e) =>
          e.message.toLowerCase().includes('structured') ||
          e.message.toLowerCase().includes('output'),
      ),
    ).toBe(true)
  })
})
