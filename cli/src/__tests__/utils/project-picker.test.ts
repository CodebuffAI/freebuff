import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { getDefaultAgentDirs } from '@codebuff/sdk'
import { describe, test, expect } from 'bun:test'

import {
  getProjectRoot,
  setProjectRoot,
  tryGetProjectRoot,
} from '../../project-files'
import {
  resolveTrustedAgentDirs,
  trustAgentDir,
} from '../../utils/agent-dir-trust'
import {
  __resetLocalAgentRegistryForTests,
  findAgentsDirectory,
  initializeAgentRegistry,
  loadAgentDefinitions,
  loadLocalAgents,
} from '../../utils/local-agent-registry'
import {
  activateProject,
  shouldShowProjectPicker,
} from '../../utils/project-picker'
import {
  __resetSkillRegistryForTests,
  getSkillByName,
} from '../../utils/skill-registry'

const agentSource = (id: string) => `export default {
  id: '${id}',
  displayName: '${id}',
  model: 'anthropic/claude-sonnet-4',
  instructions: 'test agent'
}`

interface Fixture {
  launchDir: string
  launchAgentsDir: string
  projectDir: string
  projectAgentsDir: string
  storePath: string
}

/**
 * A launch directory and a selected project, each with its own `.agents`
 * agent, the project also with an `mcp.json` server and a skill. The registry
 * starts loaded from the launch directory, as it is at startup.
 */
async function withProjectFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const originalCwd = process.cwd()
  const originalProjectRoot = tryGetProjectRoot()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'freebuff-project-'))
  const fixture: Fixture = {
    launchDir: path.join(tempDir, 'launch'),
    launchAgentsDir: path.join(tempDir, 'launch', '.agents'),
    projectDir: path.join(tempDir, 'project'),
    projectAgentsDir: path.join(tempDir, 'project', '.agents'),
    storePath: path.join(tempDir, 'config', 'trusted-agent-dirs.json'),
  }
  const skillDir = path.join(fixture.projectAgentsDir, 'skills', 'picker-skill')

  mkdirSync(fixture.launchAgentsDir, { recursive: true })
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    path.join(fixture.launchAgentsDir, 'launch-agent.ts'),
    agentSource('launch-project-agent'),
  )
  writeFileSync(
    path.join(fixture.projectAgentsDir, 'selected-agent.ts'),
    agentSource('selected-project-agent'),
  )
  writeFileSync(
    path.join(fixture.projectAgentsDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        projectPickerServer: { command: 'node', args: ['server.js'] },
      },
    }),
  )
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: picker-skill\ndescription: Loaded from the selected project\n---\n\n# Picker skill',
  )

  try {
    process.chdir(fixture.launchDir)
    setProjectRoot(fixture.launchDir)
    __resetLocalAgentRegistryForTests()
    __resetSkillRegistryForTests()
    await initializeAgentRegistry()
    expect(
      loadLocalAgents().find((agent) => agent.id === 'launch-project-agent'),
    ).toBeDefined()

    await run(fixture)
  } finally {
    process.chdir(originalCwd)
    setProjectRoot(originalProjectRoot ?? originalCwd)
    __resetLocalAgentRegistryForTests()
    __resetSkillRegistryForTests()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/** The server `mcp.json` adds to the base agent, which is how it reaches a run. */
const projectMcpServer = () =>
  loadAgentDefinitions().find((definition) => definition.id.startsWith('base'))
    ?.mcpServers?.projectPickerServer

/** The trust gate as the TUI runs it on a project switch: non-interactive. */
const gate =
  (storePath: string, notes: string[] = []) =>
  async () => {
    const { agentDirs } = await resolveTrustedAgentDirs({
      candidateDirs: getDefaultAgentDirs(),
      homeAgentsDir: path.join(os.homedir(), '.agents'),
      interactive: false,
      trustAll: false,
      storePath,
      prompt: async () => {
        throw new Error('the project switch must not prompt')
      },
      notify: (message) => notes.push(message),
    })
    return agentDirs
  }

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

  test('loads the agents and MCP servers of a trusted project after selecting it', async () => {
    await withProjectFixture(async (fixture) => {
      trustAgentDir({
        dir: fixture.projectAgentsDir,
        storePath: fixture.storePath,
      })

      await activateProject(fixture.projectDir, {
        resolveAgentDirs: gate(fixture.storePath),
      })

      expect(process.cwd()).toBe(fixture.projectDir)
      expect(getProjectRoot()).toBe(fixture.projectDir)
      expect(findAgentsDirectory()).toBe(fixture.projectAgentsDir)
      const localAgents = loadLocalAgents()
      expect(
        localAgents.find((agent) => agent.id === 'launch-project-agent'),
      ).toBeUndefined()
      expect(
        localAgents.find((agent) => agent.id === 'selected-project-agent'),
      ).toBeDefined()
      expect(projectMcpServer()).toMatchObject({
        command: 'node',
        args: ['server.js'],
      })
    })
  })

  test('does not import agents or mcp.json from an untrusted project', async () => {
    await withProjectFixture(async (fixture) => {
      const notes: string[] = []

      await activateProject(fixture.projectDir, {
        resolveAgentDirs: gate(fixture.storePath, notes),
      })

      expect(process.cwd()).toBe(fixture.projectDir)
      const localAgents = loadLocalAgents()
      expect(
        localAgents.find((agent) => agent.id === 'selected-project-agent'),
      ).toBeUndefined()
      expect(
        localAgents.find((agent) => agent.id === 'launch-project-agent'),
      ).toBeUndefined()
      expect(projectMcpServer()).toBeUndefined()
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain(fixture.projectAgentsDir)
    })
  })

  test('leaves the agent registry alone without a resolver (--agent)', async () => {
    await withProjectFixture(async (fixture) => {
      trustAgentDir({
        dir: fixture.projectAgentsDir,
        storePath: fixture.storePath,
      })

      await activateProject(fixture.projectDir)

      // The move still happens; only the registry is left as the caller found
      // it, which is what an --agent override relies on.
      expect(process.cwd()).toBe(fixture.projectDir)
      expect(getProjectRoot()).toBe(fixture.projectDir)
      const localAgents = loadLocalAgents()
      expect(
        localAgents.find((agent) => agent.id === 'launch-project-agent'),
      ).toBeDefined()
      expect(
        localAgents.find((agent) => agent.id === 'selected-project-agent'),
      ).toBeUndefined()
    })
  })

  test('loads the skills of the selected project, trusted or not', async () => {
    await withProjectFixture(async (fixture) => {
      expect(getSkillByName('picker-skill')).toBeUndefined()

      await activateProject(fixture.projectDir, {
        resolveAgentDirs: gate(fixture.storePath),
      })

      expect(getSkillByName('picker-skill')).toMatchObject({
        name: 'picker-skill',
      })
    })
  })
})
