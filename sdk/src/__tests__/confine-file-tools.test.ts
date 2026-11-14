import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as databaseModule from '../impl/database'

import type { RunOptions } from '../run'
import type {
  RequestFilesFn,
  RequestImageFileFn,
  RequestToolCallFn,
} from '@codebuff/common/types/contracts/client'

type Hooks = {
  requestFiles: RequestFilesFn
  requestToolCall: RequestToolCallFn
  requestImageFile?: RequestImageFileFn
}

let base: string
let project: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'confine-'))
  project = path.join(base, 'project')
  outside = path.join(base, 'outside')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(project, 'package.json'), '{"name":"app"}')
  writeFileSync(path.join(project, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(path.join(project, 'logo.png'), 'not really a png')
  writeFileSync(path.join(project, 'blob.dat'), 'abc\u0000def')
  writeFileSync(path.join(project, 'uv.lock'), 'version = 1\n')
  writeFileSync(path.join(project, 'big.json'), `"${'x'.repeat(150 * 1024)}"`)
  writeFileSync(path.join(outside, 'secret.txt'), 'SECRET')
  writeFileSync(path.join(outside, 'other.ts'), 'export {}')
  symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link.txt'))
  symlinkSync(outside, path.join(project, 'linked-dir'))
})

afterEach(() => {
  mock.restore()
  rmSync(base, { recursive: true, force: true })
})

/** Run the client with a stubbed main prompt and hand its tool hooks to `body`. */
async function withHooks(
  options: Partial<RunOptions>,
  body: (hooks: Hooks) => Promise<void>,
) {
  spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
    id: 'user-123',
    email: 'test@example.com',
    name: null,
    discord_id: null,
    stripe_customer_id: null,
    banned: false,
    created_at: new Date('2024-01-01T00:00:00Z'),
  })
  spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
  spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
  spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
  spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
  let failure: unknown
  spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
    async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
      const sessionState = getInitialSessionState(getStubProjectFileContext())
      try {
        await body(params as unknown as Hooks)
      } catch (error) {
        failure = error
      }
      await params.sendAction({
        action: {
          type: 'prompt-response',
          promptId: params.promptId,
          sessionState,
          output: { type: 'lastMessage', value: [] },
        },
      })
      return {
        sessionState,
        output: { type: 'lastMessage' as const, value: [] },
      }
    },
  )
  const client = new CodebuffClient({ apiKey: 'test-key', cwd: project })
  await client.run({
    agent: 'base2',
    prompt: 'go',
    projectFiles: {},
    knowledgeFiles: {},
    skillsLoader: async () => ({}),
    ...options,
  })
  if (failure) throw failure
}

const call = (hooks: Hooks, toolName: string, input: Record<string, unknown>) =>
  hooks.requestToolCall({ userInputId: 'u', toolName, input })

const json = (result: { output: Array<{ type: string; value?: unknown }> }) =>
  result.output[0]!.value as Record<string, any>

describe('confineFileToolsToProject', () => {
  it('read_files refuses outside paths per file and reads the rest', async () => {
    await withHooks({ confineFileToolsToProject: true }, async (hooks) => {
      const files = await hooks.requestFiles({
        filePaths: [
          'package.json',
          path.join(outside, 'secret.txt'),
          '../outside/other.ts',
          'link.txt',
          'linked-dir/other.ts',
          path.join(project, 'src', 'index.ts'),
        ],
      })
      expect(files['package.json']).toBe('{"name":"app"}')
      expect(files['src/index.ts']).toBe('export const a = 1\n')
      for (const key of [
        path.join(outside, 'secret.txt'),
        path.join(outside, 'other.ts'),
        'link.txt',
        'linked-dir/other.ts',
      ]) {
        expect(files[key]).toStartWith(FILE_READ_STATUS.OUTSIDE_PROJECT)
      }
      expect(JSON.stringify(files)).not.toContain('SECRET')
    })
  })

  it('list_directory refuses folders outside the project, including through a symlink', async () => {
    await withHooks({ confineFileToolsToProject: true }, async (hooks) => {
      const root = json(await call(hooks, 'list_directory', { path: '.' }))
      expect(root.files).toContain('package.json')
      expect(root.path).toBe('.')
      expect(json(await call(hooks, 'list_directory', { path: 'src' })).files).toEqual([
        'index.ts',
      ])
      for (const dir of ['/', os.homedir(), '..', outside, 'linked-dir']) {
        const result = json(await call(hooks, 'list_directory', { path: dir }))
        expect(result.errorMessage).toContain('outside the project')
        expect(result.files).toBeUndefined()
      }
    })
  })

  it('glob refuses an outside cwd and drops matches through a symlinked folder', async () => {
    await withHooks({ confineFileToolsToProject: true }, async (hooks) => {
      const all = json(await call(hooks, 'glob', { pattern: '**/*.ts' }))
      expect(all.files).toContain('src/index.ts')
      expect(all.files).not.toContain('linked-dir/other.ts')
      expect(json(await call(hooks, 'glob', { pattern: '**/*', cwd: 'src' })).files).toEqual([
        'src/index.ts',
      ])
      for (const cwd of ['/', '..', outside, 'linked-dir']) {
        const result = json(await call(hooks, 'glob', { pattern: '**/*', cwd }))
        expect(result.errorMessage).toContain('outside the project')
      }
    })
  })

  it('code_search is refused', async () => {
    await withHooks({ confineFileToolsToProject: true }, async (hooks) => {
      const result = json(await call(hooks, 'code_search', { pattern: 'SECRET' }))
      expect(result.errorMessage).toContain('code_search is not available')
    })
  })
})

describe('refuseNonTextFileReads', () => {
  it('refuses non-text extensions and binary content, never attaches an image', async () => {
    await withHooks({ refuseNonTextFileReads: true }, async (hooks) => {
      expect(hooks.requestImageFile).toBeUndefined()
      const files = await hooks.requestFiles({
        filePaths: ['logo.png', 'blob.dat', 'package.json'],
      })
      expect(files['logo.png']).toStartWith(FILE_READ_STATUS.IGNORED)
      expect(files['logo.png']).toContain('Not a text file')
      expect(files['blob.dat']).toStartWith(FILE_READ_STATUS.IGNORED)
      expect(files['package.json']).toBe('{"name":"app"}')
    })
  })

  it('refuses lockfiles and files over 100 KB', async () => {
    await withHooks({ refuseNonTextFileReads: true }, async (hooks) => {
      const files = await hooks.requestFiles({
        filePaths: ['uv.lock', 'big.json', 'package.json'],
      })
      expect(files['uv.lock']).toStartWith(FILE_READ_STATUS.IGNORED)
      expect(files['uv.lock']).toContain('Lockfile')
      expect(files['big.json']).toStartWith(FILE_READ_STATUS.TOO_LARGE)
      expect(files['package.json']).toBe('{"name":"app"}')
    })
  })
})

describe('both options off (every other caller)', () => {
  it('behaves as before: outside, symlinked and binary paths are read', async () => {
    await withHooks({}, async (hooks) => {
      expect(typeof hooks.requestImageFile).toBe('function')
      const files = await hooks.requestFiles({
        filePaths: [
          path.join(outside, 'secret.txt'),
          'link.txt',
          'logo.png',
          'blob.dat',
          'uv.lock',
          'big.json',
        ],
      })
      expect(files['uv.lock']).toBe('version = 1\n')
      expect(files['big.json']).toStartWith('"xxx')
      expect(files[path.join(outside, 'secret.txt')]).toBe('SECRET')
      expect(files['link.txt']).toBe('SECRET')
      expect(files['logo.png']).toBe('not really a png')
      expect(files['blob.dat']).toBe('abc\u0000def')
      const listed = json(await call(hooks, 'list_directory', { path: outside }))
      expect(listed.files.sort()).toEqual(['other.ts', 'secret.txt'])
      expect(listed.path).toBe(outside)
      const globbed = json(await call(hooks, 'glob', { pattern: '**/*.ts' }))
      expect(globbed.files).toContain('linked-dir/other.ts')
    })
  })
})
