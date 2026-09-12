import { EventEmitter } from 'events'

import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'

import {
  applyOverridesToSessionState,
  getGitChanges,
  isTestFilePath,
} from '../run-state'

import { getInitialSessionState } from '@codebuff/common/types/session-state'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import { getStubProjectFileContext } from '@codebuff/common/util/file'

/** Fake ChildProcess: streams the given stdout in fixed-size chunks after
 *  spawn returns, then closes with code 0 — unless killed first, in which
 *  case it closes with a null code like a real SIGTERM'd child. */
function fakeProc(stdout: string, chunkSize = 1_000_000) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  let killed = false
  proc.kill = () => {
    killed = true
    setImmediate(() => proc.emit('close', null))
    return true
  }
  setImmediate(() => {
    for (let i = 0; i < stdout.length; i += chunkSize) {
      if (killed) return
      proc.stdout.emit('data', Buffer.from(stdout.slice(i, i + chunkSize)))
    }
    if (!killed) proc.emit('close', 0)
  })
  return proc
}

function makeLogger(events: Array<{ data: unknown; msg?: string }>): Logger {
  const record = (data: unknown, msg?: string) => events.push({ data, msg })
  return { debug: record, info: record, warn: record, error: record }
}

function makeSpawn(outputs: Record<string, string>): CodebuffSpawn {
  return ((command: string, args?: readonly string[]) => {
    const key = [command, ...(args ?? [])].join(' ')
    return fakeProc(outputs[key] ?? '')
  }) as CodebuffSpawn
}

describe('getGitChanges', () => {
  it('summarizes repository scale and all kinds of changed paths', async () => {
    const events: Array<{ data: unknown; msg?: string }> = []
    const result = await getGitChanges({
      cwd: '/repo',
      spawn: makeSpawn({
        'git rev-parse --abbrev-ref HEAD': 'main\n',
        'git diff --name-only --': 'src/b.ts\nsrc/a.ts\n',
        'git diff --cached --name-only --': 'src/a.ts\nsrc/c.ts\n',
        'git ls-files --others --exclude-standard': 'src/new.ts\n',
        'git rev-list --count HEAD': '1234\n',
        'git log --use-mailmap --format=%aN%x09%aE%x09%cs%x09%s HEAD': [
          'Ada Lovelace\tada@example.com\t2020-01-01\tFix engine (#101)',
          'A. Lovelace\tada@example.com\t2020-02-01\tFollow up (#101)',
          'Grace Hopper\tgrace@example.com\t2020-03-01\tMerge pull request #102 from grace/feature',
          'github-actions[bot]\t41898282+github-actions[bot]@users.noreply.github.com\t2020-04-01\tRelease',
          'GitHub Actions\tgithub-actions[bot]@users.noreply.github.com\t2020-05-01\tRelease follow-up',
          'Renovate Bot\trenovate@whitesourcesoftware.com\t2020-06-01\tBump deps (pull request #103)',
        ].join('\n'),
        'git rev-parse --is-shallow-repository': 'false\n',
        'gh repo view --json visibility --jq .visibility': 'PRIVATE\n',
      }),
      logger: makeLogger(events),
      fileCount: 87,
      testFileCount: 12,
    })

    expect(result).toEqual({
      gitAvailable: true,
      branch: 'main',
      changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/new.ts'],
      changedFileCount: 4,
      changedFileScanTruncated: false,
      repositoryVisibility: 'private',
      commitCount: 1234,
      historyIsShallow: false,
      commitDatePercentiles: {
        p0: '2020-01-01',
        p25: '2020-02-01',
        p50: '2020-03-01',
        p75: '2020-05-01',
        p100: '2020-06-01',
      },
      mergedPullRequestCount: 3,
      humanContributorCount: 2,
      botContributorCount: 2,
      historyScanTruncated: false,
      fileCount: 87,
      fileCountIsLowerBound: undefined,
      testFileCount: 12,
    })
    expect(events).toEqual([])
  })

  it('renders no more than 25 changed file names', async () => {
    const changedFiles = Array.from(
      { length: 60 },
      (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`,
    )
    const result = await getGitChanges({
      cwd: '/repo',
      spawn: makeSpawn({
        'git diff --name-only --': changedFiles.join('\n'),
      }),
      logger: makeLogger([]),
    })

    expect(result.changedFiles).toHaveLength(25)
    expect(result.changedFileCount).toBe(60)
    expect(result.changedFileScanTruncated).toBe(false)
  })

  it('labels a partial clone without discarding its available timeline', async () => {
    const result = await getGitChanges({
      cwd: '/repo',
      spawn: makeSpawn({
        'git rev-parse --is-shallow-repository': 'true\n',
        'git rev-list --count HEAD': '25\n',
        'git log --use-mailmap --format=%aN%x09%aE%x09%cs%x09%s HEAD':
          'Ada Lovelace\tada@example.com\t2024-01-01\tRecent commit',
      }),
      logger: makeLogger([]),
    })

    expect(result.historyIsShallow).toBe(true)
    expect(result.commitCount).toBe(25)
    expect(result.commitDatePercentiles).toEqual({
      p0: '2024-01-01',
      p25: '2024-01-01',
      p50: '2024-01-01',
      p75: '2024-01-01',
      p100: '2024-01-01',
    })
    expect(result.repositoryVisibility).toBe('unknown')
  })

  it('stops pathological changed-path output at the subprocess cap', async () => {
    const events: Array<{ data: unknown; msg?: string }> = []

    const result = await getGitChanges({
      cwd: '/repo',
      spawn: makeSpawn({
        'git diff --name-only --': 'repeated-path\n'.repeat(100_000),
      }),
      logger: makeLogger(events),
    })

    expect(result.changedFileScanTruncated).toBe(true)

    const truncationLogs = events.filter(
      (e) => e.msg === 'Git command output truncated at cap',
    )
    expect(truncationLogs.length).toBe(1)
    expect((truncationLogs[0]!.data as any).command).toBe(
      'git unstaged file names',
    )
  })
})

describe('repository snapshot persistence', () => {
  it('preserves the initial Git snapshot when a thread applies turn overrides', async () => {
    const gitChanges = {
      gitAvailable: true,
      branch: 'main',
      changedFiles: ['src/original.ts'],
      changedFileCount: 1,
      changedFileScanTruncated: false,
      repositoryVisibility: 'private' as const,
      commitCount: 123,
    }
    const baseSessionState = getInitialSessionState({
      ...getStubProjectFileContext(),
      gitChanges,
    })

    const continuedSessionState = await applyOverridesToSessionState(
      '/repo',
      baseSessionState,
      { knowledgeFiles: { 'AGENTS.md': 'Updated instructions' } },
    )

    expect(continuedSessionState.fileContext.gitChanges).toEqual(gitChanges)
    expect(continuedSessionState.fileContext.knowledgeFiles).toEqual({
      'AGENTS.md': 'Updated instructions',
    })
  })

  it('clones a resumed state whose run state carries a cycle', async () => {
    // Resuming used to die on the second interaction with "JSON.stringify
    // cannot serialize cyclic structures". The state carries the previous
    // turn's tool blocks, and a recursive zod `lazy` schema in one of them is
    // self-referential, so the clone has to survive a cycle.
    const baseSessionState = getInitialSessionState(getStubProjectFileContext())
    const circular: Record<string, unknown> = {}
    circular.self = circular
    ;(baseSessionState.mainAgentState as any).output = circular

    const continuedSessionState = await applyOverridesToSessionState(
      '/repo',
      baseSessionState,
      { maxAgentSteps: 7 },
    )

    // The overrides still apply...
    expect(continuedSessionState.mainAgentState.stepsRemaining).toBe(7)
    // ...and the result is an independent copy whose cycle came across intact.
    expect(continuedSessionState.mainAgentState).not.toBe(
      baseSessionState.mainAgentState,
    )
    const clonedOutput = (continuedSessionState.mainAgentState as any).output
    expect(clonedOutput.self).toBe(clonedOutput)
  })

  it('keeps a live zod schema intact when the fallback clone runs', async () => {
    // The fallback runs exactly when the state is cyclic, and what makes it
    // cyclic is a zod schema: mcp.ts stores MCP tools as live zod schemas, and
    // a zod schema is self-referential. lodash copies own *enumerable*
    // properties only, while zod keeps its internals on a non-enumerable
    // `_zod`, so a plain cloneDeep hands back something that still looks like a
    // schema -- `safeParse` comes from the prototype -- but throws on the first
    // zod call with "undefined is not an object (evaluating '_zod.parent')".
    const schema = z.object({ path: z.string() })
    const baseSessionState = getInitialSessionState(getStubProjectFileContext())
    const circular: Record<string, unknown> = { schema }
    circular.self = circular
    ;(baseSessionState.mainAgentState as any).output = circular

    const continuedSessionState = await applyOverridesToSessionState(
      '/repo',
      baseSessionState,
      {},
    )

    const clonedSchema = (continuedSessionState.mainAgentState as any).output
      .schema
    expect(clonedSchema._zod).toBeDefined()
    expect(z.toJSONSchema(clonedSchema, { io: 'input' })).toMatchObject({
      type: 'object',
    })
  })

  it('falls back to a deep copy for values JSON.stringify rejects (BigInt)', async () => {
    // The fallback is broader than "cycles only": BigInt makes JSON.stringify
    // throw too, and cloneDeep preserves it rather than dropping the key.
    const baseSessionState = getInitialSessionState(getStubProjectFileContext())
    ;(baseSessionState.mainAgentState as any).output = { token: 10n }

    const continuedSessionState = await applyOverridesToSessionState(
      '/repo',
      baseSessionState,
      {},
    )

    expect((continuedSessionState.mainAgentState as any).output.token).toBe(10n)
    expect(continuedSessionState.mainAgentState).not.toBe(
      baseSessionState.mainAgentState,
    )
  })
})

describe('isTestFilePath', () => {
  const testFiles = [
    'src/foo.test.ts',
    'src/foo.spec.jsx',
    'src/widget.cy.ts',
    'python/test_parser.py',
    'python/parser_test.py',
    'pkg/parser_test.go',
    'spec/models/user_spec.rb',
    'tests/integration.rs',
    '__tests__/helper.ts',
    'src/FooTest.java',
    'src/FooTests.kt',
    'src/FooTestCase.cs',
  ]
  const sourceFiles = [
    'src/latest.ts',
    'src/contest.py',
    'src/testing-utils.ts',
    'src/testimony.rs',
    'src/FooTestData.java',
    'fixtures/foo.ts',
  ]

  for (const filePath of testFiles) {
    it(`detects ${filePath}`, () => {
      expect(isTestFilePath(filePath)).toBe(true)
    })
  }

  for (const filePath of sourceFiles) {
    it(`does not mistake ${filePath} for a test`, () => {
      expect(isTestFilePath(filePath)).toBe(false)
    })
  }
})
