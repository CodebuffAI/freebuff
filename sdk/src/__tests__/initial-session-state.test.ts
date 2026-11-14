import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, test, beforeEach, spyOn } from 'bun:test'
import { z } from 'zod/v4'

import { getAllFilePaths } from '@codebuff/common/project-file-tree'

import {
  applyOverridesToSessionState,
  generateInitialRunState,
  initialSessionState,
} from '../run-state'

import type { MockStatResult } from '@codebuff/common/testing/mock-types'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

describe('Initial Session State', () => {
  let mockFs: CodebuffFileSystem
  let mockLogger: Logger

  beforeEach(() => {
    mockFs = {
      readFile: async (path: string) => {
        if (path.includes('src/index.ts')) {
          return 'console.log("Hello world");'
        }
        if (path.includes('src/utils.ts')) {
          return 'export function add(a: number, b: number) { return a + b; }'
        }
        if (path.includes('knowledge.md')) {
          return '# Knowledge\n\nThis is a knowledge file.'
        }
        if (path.includes('README.md')) {
          return '# Project\n\nThis is a readme.'
        }
        if (path.includes('.gitignore')) {
          return 'node_modules/\n.git/'
        }
        if (path.includes('.codebuffignore')) {
          return ''
        }
        if (path.includes('.manicodeignore')) {
          return ''
        }
        throw new Error(`File not found: ${path}`)
      },
      readdir: async (path: string) => {
        if (path.includes('test-project')) {
          return [
            { name: 'src', isDirectory: () => true, isFile: () => false },
            { name: '.git', isDirectory: () => true, isFile: () => false },
            {
              name: 'knowledge.md',
              isDirectory: () => false,
              isFile: () => true,
            },
            { name: 'README.md', isDirectory: () => false, isFile: () => true },
            {
              name: '.gitignore',
              isDirectory: () => false,
              isFile: () => true,
            },
          ]
        }
        if (path.includes('src')) {
          return [
            { name: 'index.ts', isDirectory: () => false, isFile: () => true },
            { name: 'utils.ts', isDirectory: () => false, isFile: () => true },
          ]
        }
        return []
      },
      stat: async (path: string): Promise<MockStatResult> => ({
        isDirectory: () => path.includes('src') || path.includes('.git'),
        isFile: () => !path.includes('src') && !path.includes('.git'),
      }),
      exists: async (path: string) => {
        if (path.includes('.gitignore')) return true
        if (path.includes('.codebuffignore')) return true
        if (path.includes('.manicodeignore')) return true
        if (path.includes('src')) return true
        if (path.includes('.git')) return true
        if (path.includes('knowledge.md')) return true
        if (path.includes('README.md')) return true
        return false
      },
      mkdir: async () => {},
      writeFile: async () => {},
    } as unknown as CodebuffFileSystem

    mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
  })

  /** A project the SDK discovers on its own; returns every path it reads. */
  const useDiscoverableProject = () => {
    mockFs.readdir = (async (dirPath: string) => {
      if (dirPath === '/test-project') {
        return ['src', '.git', 'AGENTS.md', 'README.md', '.gitignore']
      }
      if (dirPath === '/test-project/src') {
        return ['index.ts', 'utils.ts', 'generated.ts']
      }
      return []
    }) as CodebuffFileSystem['readdir']
    mockFs.stat = (async (filePath: string) =>
      ({
        isDirectory: () =>
          filePath === '/test-project/src' || filePath === '/test-project/.git',
        isFile: () =>
          filePath !== '/test-project/src' && filePath !== '/test-project/.git',
        size: filePath.endsWith('generated.ts') ? 1_000_001 : 100,
      }) as MockStatResult & { size: number }) as CodebuffFileSystem['stat']
    const readFilePaths: string[] = []
    const originalReadFile = mockFs.readFile
    mockFs.readFile = (async (filePath: string, encoding?: BufferEncoding) => {
      readFilePaths.push(filePath)
      return originalReadFile(filePath, encoding)
    }) as CodebuffFileSystem['readFile']
    return readFilePaths
  }

  test('creates initial session state with explicit projectFiles', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'src/utils.ts':
        'export function add(a: number, b: number) { return a + b; }',
      'knowledge.md': '# Knowledge\n\nThis is a knowledge file.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.fileTree).toBeDefined()
    expect(sessionState.fileContext.fileTree.length).toBeGreaterThan(0)
    expect(sessionState.fileContext.fileTokenScores).toBeDefined()
    expect(sessionState.mainAgentState.agentId).toBe('main-agent')
    expect(sessionState.mainAgentState.messageHistory).toEqual([])
  })

  test('discovers project files automatically when projectFiles is undefined', async () => {
    const readFilePaths = useDiscoverableProject()

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.fileTree).toBeDefined()
    expect(sessionState.mainAgentState.agentId).toBe('main-agent')
    expect(sessionState.mainAgentState.messageHistory).toEqual([])
    expect(readFilePaths.some((p) => p.endsWith('src/index.ts'))).toBe(true)
    expect(readFilePaths.some((p) => p.endsWith('src/utils.ts'))).toBe(true)
    expect(readFilePaths.some((p) => p.endsWith('src/generated.ts'))).toBe(
      false,
    )
    expect(readFilePaths.some((p) => p.endsWith('README.md'))).toBe(false)
    expect(readFilePaths.some((p) => p.endsWith('AGENTS.md'))).toBe(true)
  })

  test('skipSymbolIndex builds the file tree without reading a source file', async () => {
    const readFilePaths = useDiscoverableProject()

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      knowledgeFiles: {},
      skipSymbolIndex: true,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(getAllFilePaths(sessionState.fileContext.fileTree).sort()).toEqual([
      '.gitignore',
      'AGENTS.md',
      'README.md',
      'src/generated.ts',
      'src/index.ts',
      'src/utils.ts',
    ])
    expect(sessionState.fileContext.fileTokenScores).toEqual({})
    expect(sessionState.fileContext.tokenCallers).toEqual({})
    // Only the walk's ignore files are read, never a file to parse.
    expect(readFilePaths.some((p) => p.endsWith('.ts'))).toBe(false)
  })

  test('skipSymbolIndex also holds when a later run passes projectFiles', async () => {
    const base = await initialSessionState({
      cwd: '/test-project',
      projectFiles: {},
      fs: mockFs,
      logger: mockLogger,
    })
    const projectFiles = {
      'src/utils.ts':
        'export function add(a: number, b: number) { return a + b; }',
    }
    const parsed = await applyOverridesToSessionState('/test-project', base, {
      projectFiles,
    })
    expect(parsed.fileContext.fileTokenScores).not.toEqual({})

    const skipped = await applyOverridesToSessionState('/test-project', base, {
      projectFiles,
      skipSymbolIndex: true,
    })
    expect(getAllFilePaths(skipped.fileContext.fileTree)).toEqual([
      'src/utils.ts',
    ])
    expect(skipped.fileContext.fileTokenScores).toEqual({})
    expect(skipped.fileContext.tokenCallers).toEqual({})
  })

  test('derives knowledgeFiles from projectFiles when not provided', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'AGENTS.md': '# Knowledge\n\nThis is a knowledge file.',
      'claude.md': '# Claude context\n\nThis is claude context.',
      'README.md': '# Project\n\nThis is a readme.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      knowledgeFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.knowledgeFiles).toBeDefined()
    expect(sessionState.fileContext.knowledgeFiles['AGENTS.md']).toBe(
      '# Knowledge\n\nThis is a knowledge file.',
    )
    expect(sessionState.fileContext.knowledgeFiles['claude.md']).toBeUndefined()
    expect(sessionState.fileContext.knowledgeFiles['README.md']).toBeUndefined()
  })

  test('derives reads knowledgeFiles from claude.md when AGENTS.md is not present', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'claude.md': '# Claude context\n\nThis is claude context.',
      'README.md': '# Project\n\nThis is a readme.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      knowledgeFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.knowledgeFiles).toBeDefined()
    expect(
      sessionState.fileContext.knowledgeFiles['AGENTS.md'],
    ).toBeUndefined()
    expect(sessionState.fileContext.knowledgeFiles['claude.md']).toEqual(
      '# Claude context\n\nThis is claude context.',
    )
    expect(sessionState.fileContext.knowledgeFiles['README.md']).toBeUndefined()
  })

  test('respects explicit knowledgeFiles when provided', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'knowledge.md': '# Knowledge\n\nThis is a knowledge file.',
    }

    const knowledgeFiles = {
      'custom-knowledge.md': '# Custom Knowledge\n\nThis is custom knowledge.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      knowledgeFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.knowledgeFiles).toEqual(knowledgeFiles)
    expect(
      sessionState.fileContext.knowledgeFiles['AGENTS.md'],
    ).toBeUndefined()
  })

  test('sets maxAgentSteps when provided', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      maxAgentSteps: 10,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.mainAgentState.stepsRemaining).toBe(10)
  })

  test('includes custom agent definitions', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const agentDefinitions = [
      {
        id: 'custom-agent',
        displayName: 'Custom Agent',
        spawnerPrompt: 'A custom agent',
        model: 'anthropic/claude-4-sonnet-20250522',
        outputMode: 'last_message' as const,
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        inputSchema: {},
        systemPrompt: 'Custom system prompt',
        instructionsPrompt: '',
        stepPrompt: '',
      },
    ]

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      agentDefinitions,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.agentTemplates).toBeDefined()
    expect(
      sessionState.fileContext.agentTemplates['custom-agent'],
    ).toBeDefined()
    expect(
      sessionState.fileContext.agentTemplates['custom-agent'].displayName,
    ).toBe('Custom Agent')
  })

  test('includes custom tool definitions', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const inputSchema = z.object({ input: z.string() })
    const customToolDefinitions = [
      {
        toolName: 'custom_tool',
        inputSchema,
        description: 'A custom tool',
        endsAgentStep: false,
        exampleInputs: [],
        execute: async (input: any) => [],
      },
    ]

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      customToolDefinitions,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.customToolDefinitions).toBeDefined()
    expect(
      sessionState.fileContext.customToolDefinitions?.['custom_tool'],
    ).toBeDefined()
    expect(
      sessionState.fileContext.customToolDefinitions?.['custom_tool']
        ?.description,
    ).toBe('A custom tool')
  })

  test('populates system info correctly', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.systemInfo).toBeDefined()
    expect(sessionState.fileContext.systemInfo.platform).toBe(process.platform)
    expect(sessionState.fileContext.systemInfo.shell).toBeDefined()
    expect(sessionState.fileContext.systemInfo.nodeVersion).toBe(
      process.version,
    )
    expect(sessionState.fileContext.systemInfo.cpus).toBeGreaterThan(0)
  })

  test('loads skills from skillsDir when provided', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-test-'))
    try {
      const skillDir = path.join(tmpDir, 'my-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: my-skill',
          'description: A test skill',
          '---',
          '',
          '# My Skill',
          '',
          'Some instructions here.',
        ].join('\n'),
      )

      const sessionState = await initialSessionState({
        cwd: '/test-project',
        skillsDir: tmpDir,
        projectFiles: { 'src/index.ts': 'console.log("hello");' },
        fs: mockFs,
        logger: mockLogger,
      })

      expect(sessionState.fileContext.skills).toBeDefined()
      expect(sessionState.fileContext.skills!['my-skill']).toBeDefined()
      expect(sessionState.fileContext.skills!['my-skill'].name).toBe('my-skill')
      expect(sessionState.fileContext.skills!['my-skill'].description).toBe(
        'A test skill',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('skillsDir with no valid skills results in empty skills map', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-test-'))
    try {
      const sessionState = await initialSessionState({
        cwd: '/test-project',
        skillsDir: tmpDir,
        projectFiles: { 'src/index.ts': 'console.log("hello");' },
        fs: mockFs,
        logger: mockLogger,
      })

      expect(sessionState.fileContext.skills).toBeDefined()
      expect(Object.keys(sessionState.fileContext.skills!)).toHaveLength(0)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  /**
   * Hosts that embed this runner in a different process from the repo (Freebuff
   * Cloud: runner in the web server, repo in a Daytona sandbox) must be able to
   * replace the filesystem walk outright. Without that, the default loader
   * reads the SERVER's disk and home directory — see `skillsLoader` docs.
   */
  describe('skillsLoader', () => {
    test('replaces the filesystem walk entirely', async () => {
      const remoteSkill = {
        name: 'remote-skill',
        description: 'Came from another machine',
        content: '---\nname: remote-skill\ndescription: x\n---\nbody',
        filePath: '/home/daytona/codebase/.agents/skills/remote-skill/SKILL.md',
      }

      const sessionState = await initialSessionState({
        // A path that does not exist on this machine, exactly as Cloud passes.
        cwd: '/home/daytona/codebase',
        skillsLoader: async () => ({ 'remote-skill': remoteSkill }),
        projectFiles: { 'src/index.ts': 'console.log("hello");' },
        fs: mockFs,
        logger: mockLogger,
      })

      expect(Object.keys(sessionState.fileContext.skills!)).toEqual([
        'remote-skill',
      ])
      expect(sessionState.fileContext.skills!['remote-skill'].filePath).toBe(
        remoteSkill.filePath,
      )
    })

    test('wins over skillsDir rather than merging with it', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-test-'))
      try {
        const skillDir = path.join(tmpDir, 'local-skill')
        mkdirSync(skillDir, { recursive: true })
        writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          '---\nname: local-skill\ndescription: On this disk\n---\n\nbody\n',
        )

        const sessionState = await initialSessionState({
          cwd: '/test-project',
          skillsDir: tmpDir,
          skillsLoader: async () => ({}),
          projectFiles: { 'src/index.ts': 'console.log("hello");' },
          fs: mockFs,
          logger: mockLogger,
        })

        expect(Object.keys(sessionState.fileContext.skills!)).toHaveLength(0)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    /**
     * `skillsLoader` is the per-run fix; this is the backstop for a host that
     * never sets it. Freebuff Cloud reaches the runner through
     * initialSessionState, so the guard has to hold at THIS entry point and not
     * only inside loadSkills.
     */
    test('a run that sets nothing still cannot read the home directory', async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'sdk-home-guard-'))
      const fakeHome = path.join(tempRoot, 'home')
      const skillDir = path.join(fakeHome, '.claude', 'skills', 'server-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: server-skill\ndescription: Lives on the server\n---\n\nbody\n',
      )

      const homedirSpy = spyOn(os, 'homedir').mockReturnValue(fakeHome)
      try {
        const sessionState = await initialSessionState({
          cwd: '/home/daytona/codebase',
          projectFiles: { 'src/index.ts': 'console.log("hello");' },
          fs: mockFs,
          logger: mockLogger,
        })

        expect(Object.keys(sessionState.fileContext.skills!)).toHaveLength(0)

        // Same call, opted in: proves the seed was discoverable and this test
        // is not passing because the fixture was wrong.
        const optedIn = await initialSessionState({
          cwd: '/home/daytona/codebase',
          includeHomeSkills: true,
          projectFiles: { 'src/index.ts': 'console.log("hello");' },
          fs: mockFs,
          logger: mockLogger,
        })

        expect(Object.keys(optedIn.fileContext.skills!)).toEqual([
          'server-skill',
        ])
      } finally {
        homedirSpy.mockRestore()
        rmSync(tempRoot, { recursive: true, force: true })
      }
    })

    test('a rejecting loader costs the skills, not the run', async () => {
      const sessionState = await initialSessionState({
        cwd: '/home/daytona/codebase',
        skillsLoader: async () => {
          throw new Error('sandbox unreachable')
        },
        projectFiles: { 'src/index.ts': 'console.log("hello");' },
        fs: mockFs,
        logger: mockLogger,
      })

      expect(sessionState.fileContext.skills).toBeDefined()
      expect(Object.keys(sessionState.fileContext.skills!)).toHaveLength(0)
    })
  })

  test('initializes empty agent state correctly', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.mainAgentState.agentId).toBe('main-agent')
    expect(sessionState.mainAgentState.agentType).toBeNull()
    expect(sessionState.mainAgentState.agentContext).toEqual({})
    expect(sessionState.mainAgentState.ancestorRunIds).toEqual([])
    expect(sessionState.mainAgentState.subagents).toEqual([])
    expect(sessionState.mainAgentState.childRunIds).toEqual([])
    expect(sessionState.mainAgentState.messageHistory).toEqual([])
    expect(sessionState.mainAgentState.creditsUsed).toBe(0)
    expect(sessionState.mainAgentState.directCreditsUsed).toBe(0)
    expect(sessionState.mainAgentState.output).toBeUndefined()
    expect(sessionState.mainAgentState.parentId).toBeUndefined()
  })

  describe('repository .agents are never imported by default', () => {
    // The CLI resolves trusted agent dirs, then passes the resulting
    // definitions. An empty list (no agents, or the repository directory was
    // skipped as untrusted) used to fall back to `loadLocalAgents()` with its
    // defaults, importing `{cwd}/.agents`, whose files execute on import.
    const makeRepo = () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'codebuff-agent-trust-'))
      const marker = path.join(dir, 'imported')
      mkdirSync(path.join(dir, '.agents'), { recursive: true })
      writeFileSync(
        path.join(dir, '.agents', 'agent.ts'),
        `import { writeFileSync } from 'fs'\nwriteFileSync(${JSON.stringify(
          marker,
        )}, 'imported')\nexport default { id: 'repo-agent', model: 'test/model' }\n`,
      )
      return { dir, marker }
    }

    // The defaults are built from `process.cwd()`, the directory a clone
    // controls, so the tests have to stand in it.
    const inRepo = async (
      dir: string,
      run: () => Promise<void>,
    ): Promise<void> => {
      const launchDir = process.cwd()
      try {
        process.chdir(dir)
        await run()
      } finally {
        process.chdir(launchDir)
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test('an explicit empty agentDefinitions is the answer, not a cue to scan', async () => {
      const { dir, marker } = makeRepo()
      await inRepo(dir, async () => {
        const sessionState = await initialSessionState({
          cwd: dir,
          projectFiles: {},
          agentDefinitions: [],
          fs: mockFs,
          logger: mockLogger,
        })
        expect(existsSync(marker)).toBe(false)
        expect(sessionState.fileContext.agentTemplates['repo-agent']).toBe(
          undefined,
        )
      })
    })

    test('no agentDefinitions and no agentDirs does not scan the cwd either', async () => {
      const { dir, marker } = makeRepo()
      await inRepo(dir, async () => {
        await initialSessionState({
          cwd: dir,
          projectFiles: {},
          fs: mockFs,
          logger: mockLogger,
        })
        expect(existsSync(marker)).toBe(false)
      })
    })

    test('a host-supplied agentDirs is still loaded (discovery stays opt-in)', async () => {
      const { dir, marker } = makeRepo()
      await inRepo(dir, async () => {
        const sessionState = await initialSessionState({
          cwd: dir,
          projectFiles: {},
          agentDirs: [path.join(dir, '.agents')],
          fs: mockFs,
          logger: mockLogger,
        })
        expect(existsSync(marker)).toBe(true)
        expect(
          sessionState.fileContext.agentTemplates['repo-agent'],
        ).toBeDefined()
      })
    })

    test('generateInitialRunState passes agentDirs through', async () => {
      const { dir, marker } = makeRepo()
      await inRepo(dir, async () => {
        const runState = await generateInitialRunState({
          cwd: dir,
          projectFiles: {},
          agentDirs: [path.join(dir, '.agents')],
          fs: mockFs,
        })
        expect(existsSync(marker)).toBe(true)
        expect(
          runState.sessionState!.fileContext.agentTemplates['repo-agent'],
        ).toBeDefined()
      })
    })
  })
})
