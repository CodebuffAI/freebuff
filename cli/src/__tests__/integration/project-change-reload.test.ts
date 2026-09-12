import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const debugMock = mock(() => {})

// Mock the logger to capture debug calls and avoid analytics initialization errors in tests
mock.module('../../utils/logger', () => ({
  logger: {
    debug: debugMock,
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
}))

import { setProjectRoot, tryGetProjectRoot } from '../../project-files'
import {
  __resetLocalAgentRegistryForTests,
  findAgentsDirectory,
  getLoadedMCPServers,
  initializeAgentRegistry,
  loadAgentDefinitions,
  loadLocalAgents,
} from '../../utils/local-agent-registry'
import {
  __resetSkillRegistryForTests,
  getLoadedSkills,
  getSkillByName,
  initializeSkillRegistry,
} from '../../utils/skill-registry'

describe('Project Change Registry Reload (Issue #957)', () => {
  let baseTempDir: string
  let initialEmptyDir: string
  let targetProjectDir: string
  let originalCwd: string
  let originalProjectRoot: string | undefined

  beforeEach(() => {
    baseTempDir = mkdtempSync(path.join(os.tmpdir(), 'freebuff-reload-test-'))
    initialEmptyDir = path.join(baseTempDir, 'initial-project')
    targetProjectDir = path.join(baseTempDir, 'target-project')

    mkdirSync(initialEmptyDir, { recursive: true })
    mkdirSync(targetProjectDir, { recursive: true })

    // Setup target project with .agents/mcp.json
    const targetAgentsDir = path.join(targetProjectDir, '.agents')
    mkdirSync(targetAgentsDir, { recursive: true })

    const mcpConfig = {
      mcpServers: {
        'test-mcp-server': {
          command: 'node',
          args: ['server.js'],
        },
      },
    }
    writeFileSync(
      path.join(targetAgentsDir, 'mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
      'utf8',
    )

    // Setup target project with .agents/skills/test-skill/SKILL.md
    const targetSkillDir = path.join(targetAgentsDir, 'skills', 'test-skill')
    mkdirSync(targetSkillDir, { recursive: true })

    const skillContent = `---
name: test-skill
description: A test skill loaded from the target project
---

You are a test skill.
`
    writeFileSync(
      path.join(targetSkillDir, 'SKILL.md'),
      skillContent,
      'utf8',
    )

    originalCwd = process.cwd()
    originalProjectRoot = tryGetProjectRoot()

    process.chdir(initialEmptyDir)
    setProjectRoot(initialEmptyDir)
    __resetLocalAgentRegistryForTests()
    __resetSkillRegistryForTests()
    debugMock.mockClear()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalProjectRoot) {
      setProjectRoot(originalProjectRoot)
    }
    __resetLocalAgentRegistryForTests()
    __resetSkillRegistryForTests()
    rmSync(baseTempDir, { recursive: true, force: true })
    mock.restore()
  })

  test('reproduces bug: changing cwd/projectRoot without reinitializing leaves registries empty', async () => {
    // 1. Start from directory without .agents/
    await initializeAgentRegistry()
    await initializeSkillRegistry()

    expect(getLoadedMCPServers()['test-mcp-server']).toBeUndefined()
    expect(getSkillByName('test-skill')).toBeUndefined()

    // 2. Change cwd and project root (simulating handleProjectChange without reinitializing)
    process.chdir(targetProjectDir)
    setProjectRoot(targetProjectDir)

    // Without calling initializeAgentRegistry() and initializeSkillRegistry(),
    // the registries still hold the old state
    expect(getLoadedMCPServers()['test-mcp-server']).toBeUndefined()
    expect(getSkillByName('test-skill')).toBeUndefined()
  })

  test('reloads MCP servers and skills after changing project and reinitializing registries', async () => {
    // 1. Start from directory without .agents/
    await initializeAgentRegistry()
    await initializeSkillRegistry()

    expect(getLoadedMCPServers()['test-mcp-server']).toBeUndefined()
    expect(getSkillByName('test-skill')).toBeUndefined()

    // 2. Switch to project containing .agents/mcp.json and .agents/skills/
    process.chdir(targetProjectDir)
    setProjectRoot(targetProjectDir)

    // 3. Reinitialize the registries (the fix)
    await initializeAgentRegistry()
    await initializeSkillRegistry()

    // 4. Verify the new MCP server is loaded
    const mcpServers = getLoadedMCPServers()
    expect(mcpServers['test-mcp-server']).toBeDefined()
    expect('command' in mcpServers['test-mcp-server'] && mcpServers['test-mcp-server'].command).toBe('node')

    // Verify MCP server is also merged into base agents
    const agentDefs = loadAgentDefinitions()
    const baseAgent = agentDefs.find((d) => d.id.startsWith('base'))
    expect(baseAgent?.mcpServers?.['test-mcp-server']).toBeDefined()

    // 5. Verify that the skill from the new project's .agents/ is loaded
    const skill = getSkillByName('test-skill')
    expect(skill).toBeDefined()
    expect(skill?.name).toBe('test-skill')
    expect(skill?.description).toBe('A test skill loaded from the target project')

    const loadedSkills = getLoadedSkills()
    expect(loadedSkills['test-skill']).toBeDefined()
  })

  test('switching between projects with different MCP servers and skills updates properly', async () => {
    // Create second project with different MCP server and skill
    const secondProjectDir = path.join(baseTempDir, 'second-project')
    const secondAgentsDir = path.join(secondProjectDir, '.agents')
    mkdirSync(path.join(secondAgentsDir, 'skills', 'second-skill'), { recursive: true })

    writeFileSync(
      path.join(secondAgentsDir, 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'second-mcp-server': {
              command: 'python',
              args: ['second.py'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    writeFileSync(
      path.join(secondAgentsDir, 'skills', 'second-skill', 'SKILL.md'),
      `---\nname: second-skill\ndescription: Second skill description\n---\nSecond skill body`,
      'utf8',
    )

    // Start at targetProjectDir
    process.chdir(targetProjectDir)
    setProjectRoot(targetProjectDir)
    await initializeAgentRegistry()
    await initializeSkillRegistry()

    expect(getLoadedMCPServers()['test-mcp-server']).toBeDefined()
    expect(getSkillByName('test-skill')).toBeDefined()
    expect(getLoadedMCPServers()['second-mcp-server']).toBeUndefined()

    // Switch to secondProjectDir
    process.chdir(secondProjectDir)
    setProjectRoot(secondProjectDir)
    await initializeAgentRegistry()
    await initializeSkillRegistry()

    // Verify targetProject's server is gone and secondProject's server is present
    expect(getLoadedMCPServers()['second-mcp-server']).toBeDefined()
    expect(getLoadedMCPServers()['test-mcp-server']).toBeUndefined()

    // Verify skill from second project is loaded
    expect(getSkillByName('second-skill')).toBeDefined()
    expect(getSkillByName('test-skill')).toBeUndefined()
  })

  test('clears cached agent directory and local agents cache when reinitializing', async () => {
    // Write a custom agent to targetProjectDir
    const targetAgentsDir = path.join(targetProjectDir, '.agents')
    writeFileSync(
      path.join(targetAgentsDir, 'custom-agent.ts'),
      `export default {
        id: 'custom-target-agent',
        displayName: 'Custom Target Agent',
        instructions: 'Custom agent instructions',
        model: 'anthropic/claude-sonnet-4',
      }`,
      'utf8',
    )

    // Initially in empty project: call findAgentsDirectory and loadLocalAgents to populate caches
    findAgentsDirectory()
    const initialAgents = loadLocalAgents()
    expect(initialAgents.find((a) => a.id === 'custom-target-agent')).toBeUndefined()

    // Switch to targetProjectDir and reinitialize
    process.chdir(targetProjectDir)
    setProjectRoot(targetProjectDir)
    await initializeAgentRegistry()
    await initializeSkillRegistry()

    // findAgentsDirectory should find the new agents directory
    expect(findAgentsDirectory()).toBe(targetAgentsDir)

    // loadLocalAgents should return the newly discovered local agent
    const updatedAgents = loadLocalAgents()
    expect(updatedAgents.find((a) => a.id === 'custom-target-agent')).toBeDefined()
  })
})
