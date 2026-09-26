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

const { SponsoredEditRecorder } = await import('../sponsored-receipts')

import type { SponsoredToolContext } from '../sponsored-run'
import type { SponsoredReceiptStore } from '../sponsored-receipts'

// An in-place run's workspace IS the user's project folder (#3989); the
// constant keeps its old name only because every assertion below reads it.
const FIXTURE_PARENT = mkdtempSync(join(tmpdir(), 'sponsored-cli-guards-'))
const WORKTREE = join(FIXTURE_PARENT, 'worktree')
mkdirSync(WORKTREE, { recursive: true })
afterAll(() => rmSync(FIXTURE_PARENT, { recursive: true, force: true }))

// Skip, or in CI on Linux FAIL, when no OS sandbox can be started here. The
// rule and the reason live in `sdk/test/sponsored-containment-gate.ts`.
const CONTAINMENT_USABLE = sponsoredContainmentTestGate()
const containmentUsable = () => CONTAINMENT_USABLE

function memoryReceipts(): SponsoredReceiptStore & {
  entries: Map<string, string>
} {
  const entries = new Map<string, string>()
  return {
    entries,
    read: (runId) => entries.get(runId) ?? null,
    write: (runId, value) => void entries.set(runId, value),
  }
}

function isolatedContext(root: string, parent: string): SponsoredToolContext {
  return {
    workspaceRoot: root,
    runtimeDir: join(parent, 'runtime'),
    signal: new AbortController().signal,
    recorder: new SponsoredEditRecorder(
      {
        runId: '00000000-0000-4000-8000-000000000001',
        proposalId: 'proposal-1',
        advertiserName: 'Acme Deploys',
        projectRoot: root,
      },
      memoryReceipts(),
    ),
  }
}

const context = (): SponsoredToolContext =>
  isolatedContext(WORKTREE, FIXTURE_PARENT)

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

  // A Supabase procedure declares its variables in `.env.example`; refusing
  // the template failed a correct run. Real env files stay refused.
  test('admits an env template and still refuses every real env file', () => {
    for (const path of [
      '.env.example',
      '.env.sample',
      '.env.template',
      join(WORKTREE, 'apps', 'web', '.env.example'),
    ]) {
      expect(sponsoredWriteGuard(WORKTREE, path), path).toBeNull()
    }
    for (const path of [
      '.env',
      '.env.local',
      '.env.local.example',
      '.env.production',
      '.env.example.local',
      '.env.local.',
      '.env::$DATA',
    ]) {
      expect(sponsoredWriteGuard(WORKTREE, path), path).toContain(
        'may not write environment files',
      )
    }
  })
})

describe('the real rooted filesystem passed to SDK tools', () => {
  // Since COD-642 the file layer runs no shell and needs no broker, so these
  // work with or without an OS sandbox on the host. They used to answer
  // `[FILE_READ_ERROR]` wherever no sandbox could start.
  test('reads inside the worktree without a shell or OS containment', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-fs-'))
    const root = join(parent, 'worktree')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'inside.ts'), 'export const before = 1\n')
    try {
      const tools = sponsoredOverrideTools(isolatedContext(root, parent))

      const read = await tools.read_files({ filePaths: ['src/inside.ts'] })
      expect(read['src/inside.ts']).toContain('export const before = 1')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('lists and globs inside the worktree without a shell', async () => {
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
  })

  test('writes and patches inside the worktree without a shell', async () => {
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
  })

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

  test('git that moves history or config is refused; reading it is not', async () => {
    // An in-place run delivers UNCOMMITTED edits and the undo reverse-applies
    // them; a commit, a checkout or a config change would move work out from
    // under both (#3989). The sandbox also denies `.git` writes outright.
    const tools = sponsoredOverrideTools(context())
    for (const command of [
      'git commit -am "x"',
      'git -C . checkout -- .',
      'git stash',
      'git config core.hooksPath /tmp',
      'echo hi && git push origin main',
    ]) {
      const result = await tools.run_terminal_command({ command })
      expect(JSON.stringify(result), command).toContain('Refusing `git')
    }
  })

  test('WSL, destructive database and container commands are refused (COD-665)', async () => {
    const tools = sponsoredOverrideTools(context())
    for (const command of [
      'wsl ls ~',
      'npx prisma migrate reset --force',
      'docker compose up -d',
    ]) {
      const result = await tools.run_terminal_command({ command })
      expect(JSON.stringify(result), command).toContain(
        'Stop here and tell the user',
      )
    }
  })
})

describe('in place: the user’s real folder', () => {
  test('secret-bearing files are unreadable; env templates are readable', () => {
    // A worktree cut from a commit could never contain `.env.local`; the
    // user's own folder does, and macOS egress is allowed.
    for (const path of [
      '.env',
      '.env.local',
      'apps/web/.env.production',
      '.npmrc',
    ]) {
      expect(sponsoredReadGuard(WORKTREE, path), path).not.toBeNull()
    }
    for (const path of ['.env.example', 'src/index.ts', 'package.json']) {
      expect(sponsoredReadGuard(WORKTREE, path), path).toBeNull()
    }
  })

  test('read_files names the refusal for a secret file instead of its content', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-secret-'))
    const root = join(parent, 'project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.env.local'), 'SUPABASE_KEY=real-secret\n')
    try {
      const tools = sponsoredOverrideTools(isolatedContext(root, parent))
      const out = await tools.read_files({ filePaths: ['.env.local'] })
      expect(out['.env.local']).not.toContain('real-secret')
      expect(out['.env.local']).toContain('may not read environment files')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('every file-tool write is receipted with its before-image', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-receipts-'))
    const root = join(parent, 'project')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'existing.ts'), 'export const a = 1\n')
    try {
      const context = isolatedContext(root, parent)
      const tools = sponsoredOverrideTools(context)
      await tools.write_file({
        type: 'file',
        path: 'src/existing.ts',
        content: 'export const a = 2\n',
      })
      await tools.write_file({
        type: 'file',
        path: 'src/new.ts',
        content: 'export const b = 1\n',
      })
      const changed = context.recorder.changed()
      expect(changed.map((receipt) => receipt.path).sort()).toEqual([
        'src/existing.ts',
        'src/new.ts',
      ])
      const created = changed.find((receipt) => receipt.path === 'src/new.ts')
      expect(created?.before).toBeNull()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('a write the undo could not reverse is refused, not performed', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sponsored-cli-big-'))
    const root = join(parent, 'project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'huge.json'), 'x'.repeat(5 * 1024 * 1024 + 1))
    try {
      const tools = sponsoredOverrideTools(isolatedContext(root, parent))
      const result = await tools.write_file({
        type: 'file',
        path: 'huge.json',
        content: '{}',
      })
      expect(JSON.stringify(result)).toContain('larger than 5 MB')
      expect(readFileSync(join(root, 'huge.json'), 'utf8').length).toBe(
        5 * 1024 * 1024 + 1,
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
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
    expect(plain.systemPrompt).toContain('UNCOMMITTED')
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
