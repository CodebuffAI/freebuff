import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { describe, test, expect, mock } from 'bun:test'

import { PLACEHOLDER } from '../types'
import { formatCurrentDate, getAgentPrompt } from '../strings'
import { getGitChangesPrompt } from '../../system-prompt/prompts'

import type { AgentTemplate } from '../types'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'

/** Create a mock logger using bun:test mock() for better test consistency */
const createMockLogger = () => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
})

const createMockFileContext = (): ProjectFileContext => ({
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
  gitChanges: {
    status: '',
    diff: '',
    diffCached: '',
    lastCommitMessages: '',
  },
  changesSinceLastChat: {},
  shellConfigFiles: {},
  agentTemplates: {},
  customToolDefinitions: {},
  systemInfo: {
    platform: 'test',
    shell: 'test',
    nodeVersion: 'test',
    arch: 'test',
    homedir: '/home/test',
    cpus: 1,
    chromeAvailable: false,
  },
})

const createMockAgentState = (agentType: string): AgentState => ({
  agentId: 'test-agent-id',
  agentType,
  runId: 'test-run-id',
  parentId: undefined,
  messageHistory: [],
  output: undefined,
  stepsRemaining: 10,
  creditsUsed: 0,
  directCreditsUsed: 0,
  childRunIds: [],
  ancestorRunIds: [],
  contextTokenCount: 0,
  agentContext: {},
  subagents: [],
  systemPrompt: '',
  toolDefinitions: {},
})

const createMockAgentTemplate = (
  overrides: Partial<AgentTemplate> = {},
): AgentTemplate => ({
  id: 'test-agent',
  displayName: 'Test Agent',
  model: 'gpt-4o-mini',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: [],
  spawnableAgents: [],
  systemPrompt: '',
  instructionsPrompt: 'Test instructions',
  stepPrompt: '',
  ...overrides,
})

describe('getAgentPrompt', () => {
  test('replaces CURRENT_DATE when formatting prompts', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'date-agent',
      systemPrompt: `Today is ${PLACEHOLDER.CURRENT_DATE}.`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'date-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext(),
      agentState: createMockAgentState('date-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toBe(`Today is ${formatCurrentDate(new Date())}.`)
    expect(result).not.toContain(PLACEHOLDER.CURRENT_DATE)
  })

  test('renders compact repository stats and changed paths without patch content', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'git-agent',
      systemPrompt: PLACEHOLDER.GIT_CHANGES_PROMPT,
    })
    const fileContext: ProjectFileContext = {
      ...createMockFileContext(),
      gitChanges: {
        gitAvailable: true,
        branch: 'main',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        changedFileCount: 52,
        changedFileScanTruncated: false,
        repositoryVisibility: 'private',
        commitCount: 1200,
        historyIsShallow: false,
        commitDatePercentiles: {
          p0: '2019-01-01',
          p25: '2020-06-15',
          p50: '2022-03-10',
          p75: '2024-07-20',
          p100: '2026-08-24',
        },
        mergedPullRequestCount: 900,
        humanContributorCount: 6,
        botContributorCount: 2,
        historyScanTruncated: false,
        fileCount: 340,
        fileCountIsLowerBound: true,
        testFileCount: 75,
        // A legacy run state can still contain these, but they must not be
        // injected into the compact base3 repository context.
        diff: 'SECRET PATCH CONTENT',
      },
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext,
      agentState: createMockAgentState('git-agent'),
      agentTemplates: { 'git-agent': agentTemplate },
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toContain('indexed_project_files: at least 340')
    expect(result).toContain('detected_test_files: at least 75')
    expect(result).toContain('repository_visibility: private')
    expect(result).toContain('total_commits: 1200')
    expect(result).toContain(
      'commit_dates: first=2019-01-01, p25=2020-06-15, p50=2022-03-10, p75=2024-07-20, p100=2026-08-24',
    )
    expect(result).toContain('merged_pull_requests_detected: 900')
    expect(result).toContain('human_contributors: 6')
    expect(result).toContain('bot_contributors: 2')
    expect(result).toContain('Changed file paths (showing 2 of 52)')
    expect(result).toContain('src/a.ts\nsrc/b.ts')
    expect(result).not.toContain('SECRET PATCH CONTENT')

    const unavailableResult = getGitChangesPrompt({
      ...fileContext,
      gitChanges: { gitAvailable: false, fileCount: 340 },
    })
    expect(unavailableResult).toContain('Changed file paths (unavailable)')
    expect(unavailableResult).toContain('repository_visibility: unknown')
    expect(unavailableResult).toContain(
      '(Git metadata unavailable to this host)',
    )
    expect(unavailableResult).not.toContain('(none)')

    const truncatedResult = getGitChangesPrompt({
      ...fileContext,
      gitChanges: {
        humanContributorCount: 6,
        botContributorCount: 2,
        mergedPullRequestCount: 900,
        historyScanTruncated: true,
      },
    })
    expect(truncatedResult).toContain('human_contributors: at least 6')
    expect(truncatedResult).toContain('bot_contributors: at least 2')
    expect(truncatedResult).toContain(
      'merged_pull_requests_detected: at least 900',
    )

    const shallowResult = getGitChangesPrompt({
      ...fileContext,
      gitChanges: {
        commitCount: 25,
        historyIsShallow: true,
        humanContributorCount: 3,
        botContributorCount: 1,
        mergedPullRequestCount: 10,
        commitDatePercentiles: {
          p0: '2024-01-01',
          p25: '2024-02-01',
          p50: '2024-03-01',
          p75: '2024-04-01',
          p100: '2024-05-01',
        },
      },
    })
    expect(shallowResult).toContain('commits_in_shallow_clone: 25')
    expect(shallowResult).toContain(
      'commit_dates_available_history: first=2024-01-01',
    )
    expect(shallowResult).toContain('human_contributors: at least 3')
    expect(shallowResult).toContain('bot_contributors: at least 1')
    expect(shallowResult).toContain(
      'merged_pull_requests_detected: at least 10',
    )
  })

  test('formats current date for prompts', () => {
    expect(formatCurrentDate(new Date(2026, 4, 22, 12))).toBe('May 22, 2026')
  })

  describe('spawnerPrompt inclusion in instructionsPrompt', () => {
    test('includes spawnerPrompt for each spawnable agent with spawnerPrompt defined', async () => {
      const filePickerTemplate = createMockAgentTemplate({
        id: 'file-picker',
        displayName: 'File Picker',
        spawnerPrompt: 'Spawn to find relevant files in a codebase',
      })

      const codeSearcherTemplate = createMockAgentTemplate({
        id: 'code-searcher',
        displayName: 'Code Searcher',
        spawnerPrompt: 'Mechanically runs multiple code search queries',
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        toolNames: ['spawn_agents'],
        spawnableAgents: ['file-picker', 'code-searcher'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'file-picker': filePickerTemplate,
        'code-searcher': codeSearcherTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).toContain('You can spawn the following agents:')
      expect(result).toContain(
        '- file-picker: Spawn to find relevant files in a codebase',
      )
      expect(result).toContain(
        '- code-searcher: Mechanically runs multiple code search queries',
      )
    })

    test('includes only agent name when spawnerPrompt is not defined', async () => {
      const agentWithoutSpawnerPrompt = createMockAgentTemplate({
        id: 'no-prompt-agent',
        displayName: 'No Prompt Agent',
        // spawnerPrompt is not defined
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        toolNames: ['spawn_agents'],
        spawnableAgents: ['no-prompt-agent'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'no-prompt-agent': agentWithoutSpawnerPrompt,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).toContain('You can spawn the following agents:')
      expect(result).toContain('- no-prompt-agent')
      // Should not have a colon after the agent name when there's no spawnerPrompt
      expect(result).not.toContain('- no-prompt-agent:')
    })

    test('handles mix of agents with and without spawnerPrompt', async () => {
      const agentWithPrompt = createMockAgentTemplate({
        id: 'with-prompt',
        displayName: 'Agent With Prompt',
        spawnerPrompt: 'This agent has a description',
      })

      const agentWithoutPrompt = createMockAgentTemplate({
        id: 'without-prompt',
        displayName: 'Agent Without Prompt',
        // spawnerPrompt is not defined
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        toolNames: ['spawn_agents'],
        spawnableAgents: ['with-prompt', 'without-prompt'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'with-prompt': agentWithPrompt,
        'without-prompt': agentWithoutPrompt,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).toContain('- with-prompt: This agent has a description')
      expect(result).toContain('- without-prompt')
      expect(result).not.toContain('- without-prompt:')
    })

    test('does not include spawnable agents section when no spawnable agents defined', async () => {
      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: [],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).not.toContain('You can spawn the following agents:')
    })

    test('does not list agents the model has no spawn tool for', async () => {
      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        toolNames: [],
        spawnableAgents: ['file-lister'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates: {
          'main-agent': mainAgentTemplate,
          'file-lister': createMockAgentTemplate({
            id: 'file-lister',
            spawnerPrompt: 'Lists files',
          }),
        },
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).not.toContain('You can spawn the following agents:')
      expect(result).not.toContain('file-lister')
    })

    test('does not include spawnable agents for non-instructionsPrompt types', async () => {
      const filePickerTemplate = createMockAgentTemplate({
        id: 'file-picker',
        displayName: 'File Picker',
        spawnerPrompt: 'Spawn to find relevant files in a codebase',
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['file-picker'],
        systemPrompt: 'System prompt content.',
        stepPrompt: 'Step prompt content.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'file-picker': filePickerTemplate,
      }

      // Test systemPrompt - should not include spawnable agents
      const systemResult = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'systemPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(systemResult).toBeDefined()
      expect(systemResult).not.toContain('You can spawn the following agents:')

      // Test stepPrompt - should not include spawnable agents
      const stepResult = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'stepPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(stepResult).toBeDefined()
      expect(stepResult).not.toContain('You can spawn the following agents:')
    })
  })

  describe('KNOWLEDGE_FILES_CONTENTS placeholder', () => {
    const renderWith = async (
      knowledgeFiles: Record<string, string>,
      userKnowledgeFiles: Record<string, string> = {},
    ): Promise<string | undefined> => {
      const agentTemplate = createMockAgentTemplate({
        id: 'knowledge-agent',
        systemPrompt: `You are an agent.\n${PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS}`,
      })
      const fileContext = {
        ...createMockFileContext(),
        knowledgeFiles,
        userKnowledgeFiles,
      }
      return await getAgentPrompt({
        agentTemplate,
        promptType: { type: 'systemPrompt' },
        fileContext,
        agentState: createMockAgentState('knowledge-agent'),
        agentTemplates: { 'knowledge-agent': agentTemplate },
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })
    }

    test('no knowledge files renders nothing — no dangling header claiming instructions exist', async () => {
      const result = await renderWith({})
      expect(result).toBe('You are an agent.')
    })

    test('a root file renders under a boundary that names the file by its path', async () => {
      const result = await renderWith({ 'AGENTS.md': 'MARKER: use bun\n' })
      expect(result).toContain('Project instructions:')
      expect(result).toContain('```AGENTS.md\nMARKER: use bun\n```')
    })

    test('non-root project files are filtered out; home files always render', async () => {
      const result = await renderWith(
        { 'AGENTS.md': 'root rules', 'packages/sub/AGENTS.md': 'nested rules' },
        { '~/.AGENTS.md': 'home rules' },
      )
      expect(result).toContain('```AGENTS.md\nroot rules\n```')
      expect(result).toContain('```~/.AGENTS.md\nhome rules\n```')
      expect(result).not.toContain('nested rules')
    })
  })
})
