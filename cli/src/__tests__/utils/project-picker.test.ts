import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, test, expect } from 'bun:test'

import {
  getProjectRoot,
  setProjectRoot,
  tryGetProjectRoot,
} from '../../project-files'
import {
  __resetLocalAgentRegistryForTests,
  findAgentsDirectory,
  getLoadedMCPServers,
  initializeAgentRegistry,
  loadAgentDefinitions,
  loadLocalAgents,
} from '../../utils/local-agent-registry'
import {
  activateProject,
  shouldShowProjectPicker,
} from '../../utils/project-picker'

describe('cli/utils/project-picker', () => {
  test('returns true when start cwd is home directory', () => {
    const root = path.parse(process.cwd()).root
    const homeDir = path.join(root, 'home', 'test-user')

    expect(shouldShowProjectPicker(homeDir, homeDir)).toBe(true)
  })

  test('returns true when start cwd is a parent of home directory', () => {
    const root = path.parse(process.cwd()).root
    const homeDir = path.join(root, 'home', 'test-user')
    const parentDir = path.dirname(homeDir)

    expect(shouldShowProjectPicker(parentDir, homeDir)).toBe(true)
    expect(shouldShowProjectPicker(root, homeDir)).toBe(true)
  })

  test('returns false when start cwd is a child of home directory', () => {
    const root = path.parse(process.cwd()).root
    const homeDir = path.join(root, 'home', 'test-user')
    const childDir = path.join(homeDir, 'projects')

    expect(shouldShowProjectPicker(childDir, homeDir)).toBe(false)
  })

  test('returns false when start cwd is a sibling of home directory', () => {
    const root = path.parse(process.cwd()).root
    const homeDir = path.join(root, 'home', 'test-user')
    const siblingDir = path.join(root, 'home', 'other-user')

    expect(shouldShowProjectPicker(siblingDir, homeDir)).toBe(false)
  })

  test('reloads local agents and MCP servers after selecting a project', async () => {
    const originalCwd = process.cwd()
    const originalProjectRoot = tryGetProjectRoot()
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'freebuff-project-'))
    const launchDir = path.join(tempDir, 'launch')
    const launchAgentsDir = path.join(launchDir, '.agents')
    const projectDir = path.join(tempDir, 'project')
    const agentsDir = path.join(projectDir, '.agents')

    mkdirSync(launchAgentsDir, { recursive: true })
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      path.join(launchAgentsDir, 'launch-agent.ts'),
      `export default {
        id: 'launch-project-agent',
        displayName: 'Launch Project Agent',
        model: 'anthropic/claude-sonnet-4',
        instructions: 'Loaded from the launch project'
      }`,
    )
    writeFileSync(
      path.join(agentsDir, 'selected-agent.ts'),
      `export default {
        id: 'selected-project-agent',
        displayName: 'Selected Project Agent',
        model: 'anthropic/claude-sonnet-4',
        instructions: 'Loaded from the selected project'
      }`,
    )
    writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectPickerServer: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
    )

    try {
      process.chdir(launchDir)
      setProjectRoot(launchDir)
      __resetLocalAgentRegistryForTests()
      await initializeAgentRegistry()

      expect(findAgentsDirectory()).toBe(launchAgentsDir)
      expect(
        loadLocalAgents().find((agent) => agent.id === 'launch-project-agent'),
      ).toBeDefined()
      expect(getLoadedMCPServers().projectPickerServer).toBeUndefined()

      await activateProject(projectDir)

      expect(process.cwd()).toBe(projectDir)
      expect(getProjectRoot()).toBe(projectDir)
      expect(findAgentsDirectory()).toBe(agentsDir)
      const localAgents = loadLocalAgents()
      expect(
        localAgents.find((agent) => agent.id === 'launch-project-agent'),
      ).toBeUndefined()
      expect(
        localAgents.find((agent) => agent.id === 'selected-project-agent'),
      ).toBeDefined()
      expect(getLoadedMCPServers().projectPickerServer).toMatchObject({
        command: 'node',
        args: ['server.js'],
      })

      const baseAgent = loadAgentDefinitions().find((definition) =>
        definition.id.startsWith('base'),
      )
      expect(baseAgent).toBeDefined()
      expect(baseAgent?.mcpServers?.projectPickerServer).toMatchObject({
        command: 'node',
        args: ['server.js'],
      })
    } finally {
      process.chdir(originalCwd)
      setProjectRoot(originalProjectRoot ?? originalCwd)
      __resetLocalAgentRegistryForTests()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('leaves the registry alone when reloadAgentRegistry is false', async () => {
    const originalCwd = process.cwd()
    const originalProjectRoot = tryGetProjectRoot()
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'freebuff-override-'))
    const launchDir = path.join(tempDir, 'launch')
    const launchAgentsDir = path.join(launchDir, '.agents')
    const projectDir = path.join(tempDir, 'project')
    const agentsDir = path.join(projectDir, '.agents')

    mkdirSync(launchAgentsDir, { recursive: true })
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      path.join(launchAgentsDir, 'launch-agent.ts'),
      `export default {
        id: 'override-launch-agent',
        displayName: 'Override Launch Agent',
        model: 'anthropic/claude-sonnet-4',
        instructions: 'Loaded from the launch project'
      }`,
    )
    writeFileSync(
      path.join(agentsDir, 'selected-agent.ts'),
      `export default {
        id: 'override-selected-agent',
        displayName: 'Override Selected Agent',
        model: 'anthropic/claude-sonnet-4',
        instructions: 'Loaded from the selected project'
      }`,
    )

    try {
      process.chdir(launchDir)
      setProjectRoot(launchDir)
      __resetLocalAgentRegistryForTests()
      await initializeAgentRegistry()

      expect(
        loadLocalAgents().find((agent) => agent.id === 'override-launch-agent'),
      ).toBeDefined()

      await activateProject(projectDir, { reloadAgentRegistry: false })

      // The move still happens, only the registry is left as the caller found it,
      // which is what an --agent override relies on
      expect(process.cwd()).toBe(projectDir)
      expect(getProjectRoot()).toBe(projectDir)

      const localAgents = loadLocalAgents()
      expect(
        localAgents.find((agent) => agent.id === 'override-launch-agent'),
      ).toBeDefined()
      expect(
        localAgents.find((agent) => agent.id === 'override-selected-agent'),
      ).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
      setProjectRoot(originalProjectRoot ?? originalCwd)
      __resetLocalAgentRegistryForTests()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
