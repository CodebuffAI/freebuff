import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import * as projectFileTree from '@codebuff/common/project-file-tree'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { MAX_READ_FILES_CHARS } from '@codebuff/common/util/file-read-limits'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

import type { FileFilter } from '../tools/read-files'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { PathLike } from 'node:fs'

interface NodeError extends Error {
  code?: string
}

const createNodeError = (message: string, code: string): NodeError => {
  const error: NodeError = new Error(message)
  error.code = code
  return error
}

function createMockFs(config: {
  files?: Record<string, { content: string; size?: number }>
}): CodebuffFileSystem {
  const { files = {} } = config

  return {
    readFile: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (files[pathStr]) {
        return files[pathStr].content
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${pathStr}`,
        'ENOENT',
      )
    },
    stat: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (files[pathStr]) {
        return {
          size: files[pathStr].size ?? files[pathStr].content.length,
          isDirectory: () => false,
          isFile: () => true,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
        }
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${pathStr}`,
        'ENOENT',
      )
    },
    readdir: async () => [],
    mkdir: async () => undefined,
    writeFile: async () => undefined,
  } as unknown as CodebuffFileSystem
}

describe('CodebuffClientOptions fileFilter', () => {
  afterEach(() => {
    mock.restore()
  })

  it('should enforce the env policy before invoking a read_files override', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        '/project/src/index.ts': { content: 'console.log("hello")' },
      },
    })

    let requestedFiles: Record<string, string | null> = {}
    let windowedFiles: Record<string, string | null> = {}
    const optionalFileResult = { current: null as string | null }

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles, requestOptionalFile } =
          params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        // Simulate agent requesting files
        requestedFiles = await requestFiles({
          filePaths: [
            '',
            '.ENV',
            '.env/./',
            '.env ',
            '.env:$DATA',
            'config/.Env.Local',
            '.env.example',
            'src/index.ts',
          ],
        })
        optionalFileResult.current = await requestOptionalFile({
          filePath: '.ENV',
        })
        // A windowedFileReads agent (base3) sends line windows. Overrides own
        // the remote workspace and their own read budget, so the windows have
        // to reach them rather than being applied here.
        windowedFiles = await requestFiles({
          filePaths: ['src/index.ts'],
          fileWindows: { 'src/index.ts': [{ offset: 5, limit: 2 }] },
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const overrideCalls: string[][] = []
    const overrideInputs: Array<Record<string, unknown>> = []

    const client = new CodebuffClient({
      apiKey: 'test-key',
      cwd: '/project',
      fsSource: mockFs,
      overrideTools: {
        read_files: async (input) => {
          const { filePaths } = input
          overrideCalls.push(filePaths)
          overrideInputs.push(input as Record<string, unknown>)
          return Object.fromEntries([
            ...filePaths.map((filePath) => [filePath, `contents:${filePath}`]),
            ['unexpected/.ENV.LOCAL', 'SECRET=leaked-by-override'],
            ['unexpected/.env:$DATA', 'SECRET=leaked-by-override-stream'],
          ])
        },
      },
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(overrideCalls).toEqual([
      ['.env.example', 'src/index.ts'],
      ['.ENV'],
      ['src/index.ts'],
    ])
    // Windows are forwarded verbatim, and only when the agent sends them: a
    // base2 read must reach the override with no fileWindows key at all.
    expect(overrideInputs[0]?.fileWindows).toBeUndefined()
    expect(overrideInputs[2]?.fileWindows).toEqual({
      'src/index.ts': [{ offset: 5, limit: 2 }],
    })
    expect(windowedFiles['src/index.ts']).toBe('contents:src/index.ts')
    expect(requestedFiles['.ENV']).toBe(FILE_READ_STATUS.IGNORED)
    expect(Object.hasOwn(requestedFiles, '')).toBe(false)
    expect(requestedFiles['.env/./']).toBe(FILE_READ_STATUS.IGNORED)
    expect(requestedFiles['.env ']).toBe(FILE_READ_STATUS.IGNORED)
    expect(requestedFiles['.env:$DATA']).toBe(FILE_READ_STATUS.IGNORED)
    expect(requestedFiles['config/.Env.Local']).toBe(FILE_READ_STATUS.IGNORED)
    expect(requestedFiles['.env.example']).toBe('contents:.env.example')
    expect(requestedFiles['src/index.ts']).toBe('contents:src/index.ts')
    expect(requestedFiles['unexpected/.ENV.LOCAL']).toBe(
      FILE_READ_STATUS.IGNORED,
    )
    expect(requestedFiles['unexpected/.env:$DATA']).toBe(
      FILE_READ_STATUS.IGNORED,
    )
    expect(optionalFileResult.current).toBe('contents:.ENV')
  })

  it('should keep env templates subject to gitignore with allow-example', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    // Env templates remain subject to gitignore even when the custom filter
    // classifies them as examples.
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(true)

    const mockFs = createMockFs({
      files: {
        '/project/.env.example': { content: 'API_KEY=your_key_here' },
      },
    })

    let requestedFiles: Record<string, string | null> = {}

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        requestedFiles = await requestFiles({
          filePaths: ['.env.example'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const fileFilter: FileFilter = (filePath) => {
      if (filePath.endsWith('.example')) {
        return { status: 'allow-example' }
      }
      return { status: 'allow' }
    }

    const client = new CodebuffClient({
      apiKey: 'test-key',
      cwd: '/project',
      fsSource: mockFs,
      fileFilter,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(
      requestedFiles['.env.example']!.startsWith(FILE_READ_STATUS.IGNORED),
    ).toBe(true)
  })

  it('should pass fileFilter to requestOptionalFile as well', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        '/project/secret.key': { content: 'private key content' },
      },
    })

    let optionalFileResult: string | null = null

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestOptionalFile } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        // Use requestOptionalFile which should also use the fileFilter
        optionalFileResult = await requestOptionalFile({
          filePath: 'secret.key',
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const filterCalls: string[] = []
    const fileFilter: FileFilter = (filePath) => {
      filterCalls.push(filePath)
      if (filePath.endsWith('.key')) {
        return { status: 'blocked' }
      }
      return { status: 'allow' }
    }

    const client = new CodebuffClient({
      apiKey: 'test-key',
      cwd: '/project',
      fsSource: mockFs,
      fileFilter,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read optional file',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(filterCalls).toContain('secret.key')
    // Optional file should return null for blocked files (via toOptionalFile)
    expect(optionalFileResult).toBeNull()
  })

  it('should read complete files through absolute requestOptionalFile paths inside cwd', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const largeContent = `${'x'.repeat(MAX_READ_FILES_CHARS + 1)}\nneedle-at-end`
    const mockFs = createMockFs({
      files: {
        '/project/src/index.ts': { content: largeContent },
      },
    })

    const optionalFileResult: { current: string | null } = { current: null }

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestOptionalFile } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        optionalFileResult.current = await requestOptionalFile({
          filePath: '/project/src/index.ts',
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
      cwd: '/project',
      fsSource: mockFs,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read optional file',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(optionalFileResult.current).toBe(largeContent)
  })

  it('should allow all files when no fileFilter is provided', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        '/project/src/index.ts': { content: 'normal file content' },
      },
    })

    let requestedFiles: Record<string, string | null> = {}

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        requestedFiles = await requestFiles({
          filePaths: ['src/index.ts'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    // No fileFilter provided
    const client = new CodebuffClient({
      apiKey: 'test-key',
      cwd: '/project',
      fsSource: mockFs,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(requestedFiles['src/index.ts']).toBe('normal file content')
  })

  it('should run fileFilter before gitignore check', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    const isFileIgnoredSpy = spyOn(
      projectFileTree,
      'isFileIgnored',
    ).mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        '/project/blocked.ts': { content: 'blocked content' },
      },
    })

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        await requestFiles({
          filePaths: ['blocked.ts'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const fileFilter: FileFilter = () => {
      // Block all files
      return { status: 'blocked' }
    }

    const client = new CodebuffClient({
      apiKey: 'test-key',
      cwd: '/project',
      fsSource: mockFs,
      fileFilter,
    })

    await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    // isFileIgnored should not be called since fileFilter blocks the file first
    expect(isFileIgnoredSpy).not.toHaveBeenCalled()
  })
})
