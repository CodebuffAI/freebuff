/**
 * The boundary, asserted directly rather than only through a live run.
 *
 * Every entry in `sponsoredOverrideTools` is a containment control, and a
 * control that is only ever exercised end-to-end is a control nobody tests. The
 * finding these exist for is COD-397's F1: the OS sandbox is a
 * `TerminalCommandBroker`, so it covers `run_terminal_command` and NOTHING
 * else. `read_files`, `code_search`, `list_directory` and `glob` run in the
 * CLI's own process, as the user, and the SDK honours an absolute path — so a
 * procedure with no shell command at all could read `~/.ssh/id_rsa` and hand it
 * to the granted `read_url`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { sponsoredOverrideTools, sponsoredReadGuard, sponsoredWriteGuard } =
  await import('../sponsored-run')
const { sponsoredContainmentTestGate } =
  await import('../../../../sdk/test/sponsored-containment-gate')
const { sponsoredAgentDefinition } = await import('../sponsored-agent')
const { SPONSORED_LOCAL_V1_GRANT } =
  await import('@codebuff/common/ads/sponsored-local-execution')
const { sponsoredCapabilityForTool } =
  await import('@codebuff/common/ads/sponsored-capabilities')

import type { SponsoredTurnContext } from '../sponsored-run'

const FIXTURE_PARENT = mkdtempSync(join(tmpdir(), 'sponsored-cli-guards-'))
const WORKTREE = join(FIXTURE_PARENT, 'worktree')
mkdirSync(WORKTREE, { recursive: true })
afterAll(() => rmSync(FIXTURE_PARENT, { recursive: true, force: true }))

// Skip, or in CI on Linux FAIL, when no OS sandbox can be started here. The
// rule and the reason live in `sdk/test/sponsored-containment-gate.ts`.
const CONTAINMENT_USABLE = sponsoredContainmentTestGate()
const containmentUsable = () => CONTAINMENT_USABLE

const context = (): SponsoredTurnContext => ({
  prompt: 'do the thing',
  proposalId: 'proposal-1',
  runtimeDir: join(FIXTURE_PARENT, 'runtime'),
  signal: new AbortController().signal,
  worktree: {
    path: WORKTREE,
    branch: 'freebuff/sponsored-acme-run-1',
    baseRef: 'base',
    sourceBranch: 'main',
    linked: {
      commonDir: join(FIXTURE_PARENT, '.git'),
      gitDir: join(FIXTURE_PARENT, '.git', 'worktrees', 'run-1'),
      branchNamespace: 'freebuff',
    },
  },
})

function isolatedContext(root: string, parent: string): SponsoredTurnContext {
  const base = context()
  return {
    ...base,
    runtimeDir: join(parent, 'runtime'),
    worktree: {
      ...base.worktree,
      path: root,
      linked: {
        commonDir: join(parent, '.git'),
        gitDir: join(parent, '.git', 'worktrees', 'run-1'),
        branchNamespace: 'freebuff',
      },
    },
  }
}

/** Paths a procedure would reach for if the clamp were not there. */
const OUTSIDE = [
  '/Users/owen/.ssh/id_rsa',
  '/etc/passwd',
  '../../../etc/hosts',
  '~/.aws/credentials',
  '/repo/.env',
]

describe('the read clamp', () => {
  test('refuses every path outside the worktree, by name', () => {
    for (const path of OUTSIDE) {
      const refused = sponsoredReadGuard(WORKTREE, path)
      expect(refused, path).not.toBeNull()
    }
  })

  test('admits the worktree’s own files', () => {
    for (const path of [
      'src/index.ts',
      `${WORKTREE}/package.json`,
      './README.md',
    ]) {
      expect(sponsoredReadGuard(WORKTREE, path), path).toBeNull()
    }
  })

  test('`~` is REFUSED rather than expanded', () => {
    // `path.resolve` has never heard of a tilde, so `~/.ssh/id_rsa` used to
    // come back as `<worktree>/~/.ssh/id_rsa` and PASS — an allow at the exact
    // spelling every reader of that function expects to see refused.
    expect(sponsoredReadGuard(WORKTREE, '~/.ssh/id_rsa')).not.toBeNull()
    expect(sponsoredWriteGuard(WORKTREE, '~/.bashrc')).not.toBeNull()
  })

  test('an absent path is not an error, but an empty one is', () => {
    // Absent means the tool was not given a cwd, which is the ordinary case.
    expect(sponsoredReadGuard(WORKTREE, undefined)).toBeNull()
    expect(sponsoredReadGuard(WORKTREE, '   ')).not.toBeNull()
  })

  test('read_files answers a refused path IN THE SLOT the content would occupy', async () => {
    // `getFiles` answers a missing file with a status string in exactly this
    // shape, so the run reads a sentence rather than an absence and does not
    // retry the same path three more ways.
    const tools = sponsoredOverrideTools(context())
    const out = await tools.read_files({ filePaths: ['/etc/passwd'] })
    expect(typeof out['/etc/passwd']).toBe('string')
    expect(out['/etc/passwd']).not.toBe(null)
  })

  test('every read-shaped tool has a clamp, including glob', async () => {
    // `glob` is contained by construction today. It is clamped anyway, so a
    // future implementation that resolves `cwd` cannot widen the boundary
    // silently.
    const tools = sponsoredOverrideTools(context())
    for (const name of ['code_search', 'list_directory', 'glob'] as const) {
      expect(typeof tools[name], name).toBe('function')
    }
    const refused = await tools.glob({ pattern: '**/*', cwd: '/etc' })
    expect(JSON.stringify(refused)).toContain('errorMessage')
  })
})

describe('the write guard', () => {
  test('refuses the path classes a pull request would never show', () => {
    // `.git` internals never reach the diff at all; a tracked hook directory
    // executes on the REVIEWER'S machine the moment they check the branch out.
    for (const path of [
      '.git/hooks/pre-commit',
      '.git/config',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
      '.npmrc',
      '.netrc',
    ]) {
      expect(sponsoredWriteGuard(WORKTREE, path), path).not.toBeNull()
    }
  })

  test('refuses a write outside the worktree, and an unnamed one', () => {
    for (const path of OUTSIDE) {
      expect(sponsoredWriteGuard(WORKTREE, path), path).not.toBeNull()
    }
    expect(sponsoredWriteGuard(WORKTREE, null)).not.toBeNull()
  })

  test('admits an ordinary source edit', () => {
    expect(sponsoredWriteGuard(WORKTREE, 'src/deploy.ts')).toBeNull()
  })
})

describe('the real rooted filesystem passed to SDK tools', () => {
  test('reads inside the worktree only when OS containment is available', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-fs-'))
    const root = join(parent, 'worktree')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'inside.ts'), 'export const before = 1\n')
    try {
      const tools = sponsoredOverrideTools(isolatedContext(root, parent))

      const read = await tools.read_files({ filePaths: ['src/inside.ts'] })
      if (containmentUsable()) {
        expect(read['src/inside.ts']).toContain('export const before = 1')
      } else {
        expect(read['src/inside.ts']).toBe('[FILE_READ_ERROR]')
        expect(read['src/inside.ts']).not.toContain('export const before = 1')
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test.skipIf(!containmentUsable())(
    'lists and globs inside the worktree through OS containment',
    async () => {
      const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-list-'))
      const root = join(parent, 'worktree')
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'inside.ts'), 'export const before = 1\n')
      try {
        const tools = sponsoredOverrideTools(isolatedContext(root, parent))
        const listed = await tools.list_directory({ path: 'src' })
        expect(JSON.stringify(listed)).toContain('inside.ts')

        const globbed = await tools.glob({ pattern: '**/*.ts' })
        expect(JSON.stringify(globbed)).toContain('src/inside.ts')
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(!containmentUsable())(
    'writes and patches inside the worktree through OS containment',
    async () => {
      const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-write-'))
      const root = join(parent, 'worktree')
      mkdirSync(join(root, 'src'), { recursive: true })
      try {
        const tools = sponsoredOverrideTools(isolatedContext(root, parent))
        const written = await tools.write_file({
          type: 'file',
          path: 'src/written.ts',
          content: 'export const written = true\n',
        })
        expect(JSON.stringify(written)).toContain('Created file successfully')

        const patched = await tools.apply_patch({
          operation: {
            type: 'create_file',
            path: 'src/patched.ts',
            diff: '@@ -0,0 +1 @@\n+export const patched = true\n',
          },
        })
        expect(JSON.stringify(patched)).toContain('Applied 1 patch operation')
        expect(readFileSync(join(root, 'src', 'written.ts'), 'utf8')).toContain(
          'written = true',
        )
        expect(readFileSync(join(root, 'src', 'patched.ts'), 'utf8')).toContain(
          'patched = true',
        )
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  test('refuses dangling links and a link introduced after the surface guard', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-links-'))
    const root = join(parent, 'worktree')
    const outside = join(parent, 'outside')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    try {
      const tools = sponsoredOverrideTools(isolatedContext(root, parent))
      symlinkSync(
        join(outside, 'dangling-target.ts'),
        join(root, 'dangling.ts'),
      )
      const dangling = await tools.write_file({
        type: 'file',
        path: 'dangling.ts',
        content: 'escaped',
      })
      expect(JSON.stringify(dangling)).toMatch(
        /could not safely resolve|symlink/,
      )
      expect(existsSync(join(outside, 'dangling-target.ts'))).toBe(false)

      expect(sponsoredWriteGuard(root, 'late/file.ts')).toBeNull()
      symlinkSync(outside, join(root, 'late'))
      const swapped = await tools.write_file({
        type: 'file',
        path: 'late/file.ts',
        content: 'escaped',
      })
      expect(JSON.stringify(swapped)).toMatch(/symlink/)
      expect(existsSync(join(outside, 'file.ts'))).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('sponsored code search', () => {
  test('refuses process/path-expanding flags', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-search-'))
    const root = join(parent, 'worktree')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'inside.ts'), 'export const NEEDLE = true\n')
    try {
      const tools = sponsoredOverrideTools(isolatedContext(root, parent))
      const refusedFlags = [
        '--pre cat',
        '--pre-glob *.ts',
        '--ignore-file /etc/passwd',
        '--follow',
      ]
      for (const flags of refusedFlags) {
        const refused = await tools.code_search({ pattern: 'NEEDLE', flags })
        expect(JSON.stringify(refused), flags).toContain('unsupported')
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test.skipIf(!containmentUsable())(
    'runs an allowed search through the local containment mechanism',
    async () => {
      const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-search-ok-'))
      const root = join(parent, 'worktree')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'inside.ts'), 'export const NEEDLE = true\n')
      try {
        const tools = sponsoredOverrideTools(isolatedContext(root, parent))
        const allowed = await tools.code_search({
          pattern: 'needle',
          flags: '-i -g *.ts',
        })
        expect(JSON.stringify(allowed)).toContain('NEEDLE')
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )
})

describe('the shell', () => {
  test('installs are refused, and the refusal says it is a product decision', async () => {
    // A postinstall script runs outside the tool loop entirely, so a run that
    // installs is a run whose diff the user cannot review (COD-336 item 5).
    const tools = sponsoredOverrideTools(context())
    for (const command of [
      'npm install left-pad',
      'bun add x',
      'pip3 install y',
    ]) {
      const result = await tools.run_terminal_command({ command })
      expect(JSON.stringify(result), command).toContain('Refusing to install')
    }
  })
})

describe('the toolset the run is actually offered', () => {
  test('every tool the definition offers is one the grant admits', () => {
    // The narrowing is what makes `ask_user`, `suggest_followups`, `render_ui`
    // and `skill` unreachable: three of the four are not client-executed at
    // all, so no `overrideTools` handler is ever consulted for them and the
    // toolNames of the definition are the only place they can be removed.
    const definition = sponsoredAgentDefinition({
      agentId: 'base3',
      isFreebuff: true,
    })
    expect(definition.toolNames?.length).toBeGreaterThan(0)
    for (const tool of definition.toolNames ?? []) {
      const capability = sponsoredCapabilityForTool(tool)
      expect(capability, tool).toBeDefined()
      expect(SPONSORED_LOCAL_V1_GRANT.has(capability!), tool).toBe(true)
    }
  })

  test('the four tools the CLI root adds beyond the grant are gone', () => {
    const definition = sponsoredAgentDefinition({
      agentId: 'base3',
      isFreebuff: true,
    })
    for (const tool of [
      'ask_user',
      'suggest_followups',
      'render_ui',
      'skill',
    ]) {
      expect(definition.toolNames, tool).not.toContain(tool)
    }
    // And the ones a sponsored run genuinely needs are still there.
    for (const tool of ['read_files', 'write_file', 'run_terminal_command']) {
      expect(definition.toolNames, tool).toContain(tool)
    }
  })

  test('the system prompt is APPENDED to, never prepended', () => {
    // `hasFreebuffRootSystemPromptOpening` requires the canonical opening at
    // byte 0 and 403s every free-mode turn without it
    // (docs/freebuff-base3-harness.md).
    const plain = sponsoredAgentDefinition({
      agentId: 'base3',
      isFreebuff: true,
    })
    expect(plain.systemPrompt?.startsWith('You are Buffy')).toBe(true)
    expect(plain.systemPrompt).toContain('Do NOT push')
  })

  test('it keeps the id it was given, so free mode can still admit it', () => {
    // Free mode gates on the (agent id, model) pair, so a run started under an
    // invented id is a run that cannot be admitted at all.
    expect(
      sponsoredAgentDefinition({ agentId: 'base3-free-mimo', isFreebuff: true })
        .id,
    ).toBe('base3-free-mimo')
  })
})
