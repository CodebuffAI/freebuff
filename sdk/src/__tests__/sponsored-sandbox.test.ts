import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  scrubSponsoredLocalEnv,
  sponsoredLocalContainment,
} from '@codebuff/common/ads/sponsored-local-execution'

import {
  assertSponsoredCommandCwd,
  assertSponsoredReadPath,
  assertSponsoredWritePath,
  createSponsoredCodeSearchBroker,
  createSponsoredTerminalBroker,
  findXcodeDeveloperGit,
  linkDeveloperShims,
  sponsoredCodeSearchFlagsRefusal,
  sponsoredLinuxEnvArgs,
  sponsoredMacGitPath,
  sponsoredMacProfile,
  sponsoredMacSecretReadRules,
  sponsoredSecretFiles,
} from '../tools/sponsored-sandbox'
import { codeSearch, parseCodeSearchFlags } from '../tools/code-search'
import { sponsoredContainmentTestGate } from '../../test/sponsored-containment-gate'

/**
 * COD-336's two acceptance tests, at the layer that actually holds them.
 *
 * Acceptance 3 asks for "a local run cannot write outside its worktree VIA THE
 * SHELL, not only via the write tools", and acceptance 4 for "the advertiser
 * procedure cannot read the user's environment". Both are properties of the
 * broker, so both are asserted by running a REAL command through it rather
 * than by inspecting the arguments it would have used — an argument list is a
 * thing that can be right while the sandbox is not applied at all, which is
 * exactly how the macOS profile stayed broken for months.
 */

/**
 * Skip, or in CI on Linux FAIL, when no OS sandbox can be started here. The
 * rule and the reason live in `sdk/test/sponsored-containment-gate.ts`.
 */
const CONTAINMENT_USABLE = sponsoredContainmentTestGate()
const containedIt = it.skipIf(!CONTAINMENT_USABLE)

function workspace(): { root: string; runtime: string; parent: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsored-sandbox-'))
  const root = path.join(parent, 'worktree')
  const runtime = path.join(parent, 'runtime')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  return { root, runtime, parent }
}

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += String(chunk)
  return out
}

/**
 * What `echo x > /dev/stderr` answers on THIS host with NO sandbox, spawned the
 * way the broker spawns -- `'pipe'` stdio, which Bun backs with a socketpair.
 * On Linux `/dev/stderr` is `/proc/self/fd/2` and open() on a socket through
 * `/proc` is ENXIO, so the honest expectation for the contained run is "the
 * same as the host", not "ok". Measured identical with and without bwrap.
 */
function uncontainedStderrVerdict(): 'ok' | 'DENIED' {
  const probe = spawnSync(
    'bash',
    ['-c', 'echo x > /dev/stderr 2>/dev/null && echo ok || echo DENIED'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  )
  return probe.stdout.includes('ok') ? 'ok' : 'DENIED'
}

/** The user's environment as a sponsored run must never see it. */
const POLLUTED_ENV = {
  PATH: process.env.PATH,
  HOME: os.homedir(),
  AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
  GITHUB_TOKEN: 'gh-token-value',
  CODEBUFF_API_KEY: 'codebuff-key-value',
  NPM_TOKEN: 'npm-token-value',
  DATABASE_URL: 'postgresql://production',
}

describe('sponsored local environment (COD-336 acceptance 4)', () => {
  it('carries only the allowlist, with HOME redirected', () => {
    const env = scrubSponsoredLocalEnv(POLLUTED_ENV, {
      home: '/run/home',
      tmp: '/run/tmp',
    })
    expect(env.PATH).toBe(POLLUTED_ENV.PATH!)
    expect(env.HOME).toBe('/run/home')
    expect(env.USERPROFILE).toBe('/run/home')
    expect(env.TMPDIR).toBe('/run/tmp')
    expect(env.GIT_ASKPASS).toBe('echo')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('carries no credential-shaped variable at all', () => {
    const env = scrubSponsoredLocalEnv(POLLUTED_ENV, {
      home: '/run/home',
      tmp: '/run/tmp',
    })
    for (const key of [
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'CODEBUFF_API_KEY',
      'NPM_TOKEN',
      'DATABASE_URL',
    ]) {
      expect(env[key]).toBeUndefined()
    }
    // The allowlist is the mechanism; this is the property it exists for, so
    // it is asserted over the whole output rather than over the names above.
    // `GIT_CONFIG_KEY_0` is git's own config-through-environment protocol and
    // is exempt by name, not by pattern: it holds the string `core.hooksPath`,
    // which is what disables hooks for the run.
    expect(
      Object.keys(env).filter(
        (key) =>
          key !== 'GIT_CONFIG_KEY_0' &&
          /(^|_)(TOKEN|SECRET|PASSWORD)$|API_?KEY|ACCESS_?KEY|^AWS_/i.test(key),
      ),
    ).toEqual([])
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
  })

  containedIt(
    'is what a real shell sees, not just what the scrub returns',
    async () => {
      const { root, runtime, parent } = workspace()
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          args: [
            '-c',
            'echo "HOME=$HOME"; echo "AWS=${AWS_SECRET_ACCESS_KEY:-absent}"; echo "GH=${GITHUB_TOKEN:-absent}"',
          ],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        await handle.completion
        const output = await stdout
        expect(output).toContain(`HOME=${path.join(runtime, 'home')}`)
        expect(output).toContain('AWS=absent')
        expect(output).toContain('GH=absent')
        expect(output).not.toContain('aws-secret-value')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )
})

describe('connected run credentials (COD-665)', () => {
  const KEY = 'sk_test_connect_1234567890'

  containedIt(
    'a real shell sees exactly the declared variable, with the connected value, and no host credential',
    async () => {
      const { root, runtime, parent } = workspace()
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
          credentialEnv: { SIEVE_API_KEY: KEY },
        }).start({
          executable: 'bash',
          args: [
            '-c',
            'echo "SIEVE=${SIEVE_API_KEY:-absent}"; echo "GH=${GITHUB_TOKEN:-absent}"; echo "HOME=$HOME"',
          ],
          cwd: root,
          // The host's OWN value of the same name is not what the run gets.
          env: {
            ...POLLUTED_ENV,
            SIEVE_API_KEY: 'from-the-host-shell',
          } as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        await handle.completion
        const output = await stdout
        expect(output).toContain(`SIEVE=${KEY}`)
        expect(output).not.toContain('from-the-host-shell')
        expect(output).toContain('GH=absent')
        expect(output).toContain(`HOME=${path.join(runtime, 'home')}`)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('refuses to start a command with an undeclarable credential name', () => {
    const { root, runtime, parent } = workspace()
    try {
      const broker = createSponsoredTerminalBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
        // Linux or macOS both build the env before choosing a sandbox, so
        // the refusal is the same whichever this host is.
        platform: process.platform === 'linux' ? 'linux' : 'darwin',
        credentialEnv: { NODE_OPTIONS: '--require=/tmp/evil.js' },
      })
      expect(() =>
        broker.start({
          executable: 'bash',
          args: ['-c', 'true'],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        }),
      ).toThrow(/not a declarable credential name/)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('bubblewrap never carries a credential value in its argv', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/run/home',
      SIEVE_API_KEY: KEY,
    }
    const { args, spawnEnv } = sponsoredLinuxEnvArgs(
      env,
      new Set(['SIEVE_API_KEY']),
    )
    // /proc/<pid>/cmdline is world-readable; /proc/<pid>/environ is not.
    expect(args.join('\0')).not.toContain(KEY)
    expect(args).not.toContain('--clearenv')
    expect(spawnEnv).toEqual({ PATH: '/usr/bin', SIEVE_API_KEY: KEY })
    // Everything else is still a --setenv, which overrides bwrap's own env.
    expect(args).toEqual([
      '--setenv',
      'PATH',
      '/usr/bin',
      '--setenv',
      'HOME',
      '/run/home',
    ])
  })

  it('with no credentials the bubblewrap env argv is exactly what it always was', () => {
    const env = { PATH: '/usr/bin', HOME: '/run/home', UNSET: undefined }
    expect(sponsoredLinuxEnvArgs(env)).toEqual({
      args: [
        '--clearenv',
        '--setenv',
        'PATH',
        '/usr/bin',
        '--setenv',
        'HOME',
        '/run/home',
      ],
      spawnEnv: { PATH: '/usr/bin' },
    })
  })
})

describe('sponsored write containment (COD-336 acceptance 3)', () => {
  it('refuses a cwd outside the worktree', () => {
    const { root, parent } = workspace()
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    try {
      expect(() =>
        assertSponsoredCommandCwd(root, path.join(root, 'src')),
      ).not.toThrow()
      expect(() => assertSponsoredCommandCwd(root, parent)).toThrow(
        /inside its own worktree/,
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses a lexical escape and a symlinked one', () => {
    const { root, parent } = workspace()
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'escape'))
    try {
      expect(() => assertSponsoredWritePath(root, 'src/file.ts')).not.toThrow()
      expect(() =>
        assertSponsoredWritePath(root, '../outside/file.ts'),
      ).toThrow(/inside its own worktree/)
      expect(() => assertSponsoredWritePath(root, 'escape/file.ts')).toThrow(
        /symlink/,
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  containedIt(
    'stops a SHELL redirect outside the worktree, which no path table can',
    async () => {
      const { root, runtime, parent } = workspace()
      const target = path.join(parent, 'escaped.txt')
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          // The exact bypass COD-175's acceptance 6 was struck for: a redirect
          // never consults `evaluateSponsoredWritePath`, because that table is
          // only reached by write_file / str_replace / apply_patch.
          args: ['-c', `echo pwned > ${JSON.stringify(target)}; echo done`],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        const stderr = drain(handle.stderr)
        await handle.completion
        await Promise.all([stdout, stderr])
        expect(fs.existsSync(target)).toBe(false)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  containedIt('still allows a shell write INSIDE the worktree', async () => {
    const { root, runtime, parent } = workspace()
    try {
      const handle = createSponsoredTerminalBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
      }).start({
        executable: 'bash',
        args: ['-c', 'echo inside > allowed.txt'],
        cwd: root,
        env: POLLUTED_ENV as NodeJS.ProcessEnv,
      })
      const stderr = drain(handle.stderr)
      await handle.completion
      await stderr
      expect(
        fs.readFileSync(path.join(root, 'allowed.txt'), 'utf8').trim(),
      ).toBe('inside')
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  containedIt("cannot read the user's home directory", async () => {
    const { root, runtime, parent } = workspace()
    try {
      const handle = createSponsoredTerminalBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
      }).start({
        executable: 'bash',
        args: ['-c', `ls ${JSON.stringify(os.homedir())} 2>&1 | head -3`],
        cwd: root,
        env: POLLUTED_ENV as NodeJS.ProcessEnv,
      })
      const stdout = drain(handle.stdout)
      await handle.completion
      // Not "the command failed" — the point is that the NAMES are not
      // enumerable, which is the grant `traversableAncestors` deliberately
      // narrows from `file-read*` to `file-read-metadata`.
      expect((await stdout).trim()).not.toContain('Documents')
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('containment availability', () => {
  it('refuses rather than downgrading where there is no mechanism', () => {
    // COD-642: Windows is no longer a refusal here. It is the FLOOR arm, which
    // carries no `available: true` -- it is not a sandbox, and nothing that
    // reads `available` may take it for one. Linux without bubblewrap below
    // still refuses: the floor is never what a sandboxable OS falls back to.
    expect(sponsoredLocalContainment('win32')).toEqual({ containment: 'floor' })
    expect(sponsoredLocalContainment('freebsd')).toEqual({
      available: false,
      reason: 'unsupported-platform',
    })
    expect(
      sponsoredLocalContainment('linux', { bwrapAvailable: false }),
    ).toEqual({ available: false, reason: 'bubblewrap-missing' })
    expect(
      sponsoredLocalContainment('linux', { bwrapAvailable: true }),
    ).toEqual({
      available: true,
      mechanism: 'bubblewrap',
    })
    expect(sponsoredLocalContainment('darwin')).toEqual({
      available: true,
      mechanism: 'sandbox-exec',
    })
  })

  it('never starts a command on a platform it cannot contain', () => {
    // COD-642 kept this refusal and narrowed what reaches it: Windows WITHOUT
    // a server grant naming the floor still throws here, on every host. With
    // the grant, the floor is selected only on a real Windows host
    // (`sponsored-windows-floor.test.ts`), never by the `platform` option.
    const { root, runtime, parent } = workspace()
    try {
      expect(() =>
        createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
          platform: 'win32',
        }).start({
          executable: 'bash',
          args: ['-c', 'echo hi'],
          cwd: root,
          env: {},
        }),
      ).toThrow(/cannot be contained on win32/)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

// ----------------------------------------------------------- device nodes

/**
 * A REAL git commit, through the REAL broker, on this machine.
 *
 * This is here because every fake passed. The macOS profile listed `/dev` as
 * readable and granted `file-write*` only to the worktree and the runtime
 * directory, so `/dev/null` was read-only -- and every git binary opens it for
 * reading AND writing at startup. `git --version` died with
 *
 *   fatal: could not open '/dev/null' for reading and writing: Operation not permitted
 *
 * which put `committed`, `landed` and the pull request out of reach on every
 * Mac. Nothing above caught it: the write acceptance test is a shell redirect
 * into the worktree, which needs no device node, and the profile assertions
 * are string matches on a profile that was wrong.
 *
 * So the assertion is the PRODUCT OUTCOME, not the profile text: a sponsored
 * run's whole purpose is to leave a commit for the user to review, and the
 * only honest test of that is to make one. A profile-string test would have
 * been just as green with `/dev/null` unwritable.
 */
describe('sponsored git (the commit the whole feature exists to produce)', () => {
  containedIt(
    'runs git init, add, commit and log through the broker',
    async () => {
      const { root, runtime, parent } = workspace()
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          args: [
            '-c',
            [
              'set -e',
              'git init -q .',
              // The run's HOME is empty by design, so there is no ambient
              // identity to commit under -- exactly as a real sponsored run
              // finds it.
              'git config user.email sponsored@example.invalid',
              'git config user.name "Sponsored Run"',
              'echo sponsored-change > CHANGED.md',
              'git add CHANGED.md',
              'git commit -q -m "sponsored change" --no-verify',
              'git log --oneline -1 --format=%s',
            ].join('\n'),
          ],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        const stderr = drain(handle.stderr)
        const exitCode = await handle.completion
        const [out, err] = await Promise.all([stdout, stderr])
        // The failure text is asserted by name: if this regresses, the next
        // reader should see the device node in the test output rather than a
        // bare non-zero exit.
        expect(err).not.toContain('/dev/null')
        expect(err).not.toContain('Operation not permitted')
        expect(exitCode).toBe(0)
        expect(out.trim()).toContain('sponsored change')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  containedIt(
    'writes /dev/null and the /dev/fd stdio aliases, and nothing else in /dev',
    async () => {
      const { root, runtime, parent } = workspace()
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          args: [
            '-c',
            [
              'echo x > /dev/null && echo null=ok || echo null=DENIED',
              'echo x > /dev/stderr 2>/dev/null && echo stderr=ok || echo stderr=DENIED',
              // Granted for nobody. `/dev/zero` stands in for the rest of the
              // directory -- bpf, the raw disks, auditpipe -- which is why this
              // is a literal list and not `(subpath "/dev")`.
              'echo x > /dev/zero 2>/dev/null && echo zero=ALLOWED || echo zero=denied',
            ].join('\n'),
          ],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        const stderr = drain(handle.stderr)
        await handle.completion
        await stderr
        const out = await stdout
        expect(out).toContain('null=ok')
        if (process.platform === 'darwin') {
          // `/dev/stderr` is a symlink to `/dev/fd/2`, and seatbelt matches the
          // path the KERNEL resolves -- so this passes because `/dev/fd` is
          // granted, and would still fail if only `/dev/stderr` were.
          expect(out).toContain('stderr=ok')
          expect(out).toContain('zero=denied')
        } else {
          // Linux, where the two macOS assertions measure the wrong things:
          //
          //  - `/dev/stderr` resolves to `/proc/self/fd/2`, and the kernel
          //    refuses to open() that when fd 2 is a SOCKET (ENXIO). Bun's
          //    `spawn` hands every `'pipe'` child a socketpair, so the redirect
          //    fails with NO sandbox at all -- measured, identical under bwrap
          //    and under a bare `spawn`. The containment property is that the
          //    run gets the SAME answer the host gives, which is what the
          //    uncontained control below pins; a sandbox that DENIED something
          //    the host allows would still fail here.
          //  - `/dev/zero` stood in for the host's dangerous nodes, and on this
          //    arm there are none to stand in for: `--dev /dev` is a fresh
          //    devtmpfs, so the assertion is the whole directory listing.
          expect(out).toContain(`stderr=${uncontainedStderrVerdict()}`)
        }
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  /**
   * bubblewrap's `--dev /dev` documents its contents; this pins them. The host
   * this was first measured on had 100+ entries in `/dev` -- `vda`..`vdf`,
   * `loop0`..`loop7`, `kmsg`, `mem`-class nodes, `userfaultfd` -- and the run
   * saw exactly the fourteen below. The list is a whitelist on purpose: a new
   * bwrap adding a node shows up here as a question rather than a hole.
   */
  it.skipIf(!CONTAINMENT_USABLE || process.platform !== 'linux')(
    "the run's /dev is bubblewrap's fresh devtmpfs and carries none of the host's devices",
    async () => {
      const { root, runtime, parent } = workspace()
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          args: ['-c', 'ls -A /dev'],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        const stderr = drain(handle.stderr)
        await handle.completion
        await stderr
        const entries = (await stdout).split('\n').filter(Boolean).sort()
        const allowed = new Set([
          'console', // only when bwrap has a tty on stdin; it does not here
          'core',
          'fd',
          'full',
          'null',
          'ptmx',
          'pts',
          'random',
          'shm',
          'stderr',
          'stdin',
          'stdout',
          'tty',
          'urandom',
          'zero',
        ])
        expect(entries.length).toBeGreaterThan(0)
        for (const entry of entries)
          expect(allowed.has(entry), entry).toBe(true)
        // And the classes that matter are absent by name, so a failure reads
        // as what it is rather than as a set difference.
        for (const entry of entries) {
          expect(entry, entry).not.toMatch(
            /^(sd|vd|nvme|loop|dm-|mem|kmem|kmsg|port|bpf|userfaultfd|fuse)/,
          )
        }
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  containedIt(
    'grants /dev/fd without letting a descriptor reach outside the worktree',
    async () => {
      const { root, runtime, parent } = workspace()
      const victim = path.join(parent, 'victim.txt')
      fs.writeFileSync(victim, 'ORIGINAL\n')
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          // Re-opening an inherited read-only descriptor for writing is the one
          // way `/dev/fd` could be an escape. It is not: seatbelt evaluates the
          // UNDERLYING file, so this is refused by the same worktree bound as a
          // plain redirect.
          args: [
            '-c',
            `exec 3< ${JSON.stringify(victim)}; echo PWNED > /dev/fd/3; echo done`,
          ],
          cwd: root,
          env: POLLUTED_ENV as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        const stderr = drain(handle.stderr)
        await handle.completion
        await Promise.all([stdout, stderr])
        expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL\n')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )
})

// ------------------------------------------------------------- F1 read clamp

describe('sponsored read containment (F1)', () => {
  it('refuses an absolute path, a traversal and a symlink escape', () => {
    const { root, parent } = workspace()
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'private')
    fs.symlinkSync(outside, path.join(root, 'escape'))
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'ok.ts'), 'ok')
    try {
      expect(assertSponsoredReadPath(root, 'src/ok.ts')).toContain('ok.ts')
      expect(() =>
        assertSponsoredReadPath(root, path.join(outside, 'secret.txt')),
      ).toThrow(/inside its own worktree/)
      expect(() =>
        assertSponsoredReadPath(root, '../outside/secret.txt'),
      ).toThrow(/inside its own worktree/)
      expect(() => assertSponsoredReadPath(root, 'escape/secret.txt')).toThrow(
        /symlink/,
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses dangling symlinks and resolution loops instead of treating them as missing', () => {
    const { root, parent } = workspace()
    const outsideTarget = path.join(parent, 'outside', 'new-file.ts')
    fs.symlinkSync(outsideTarget, path.join(root, 'dangling.ts'))
    fs.symlinkSync('loop-b', path.join(root, 'loop-a'))
    fs.symlinkSync('loop-a', path.join(root, 'loop-b'))
    try {
      for (const requested of ['dangling.ts', 'loop-a']) {
        expect(() => assertSponsoredReadPath(root, requested)).toThrow(
          /could not safely resolve/,
        )
        expect(() => assertSponsoredWritePath(root, requested)).toThrow(
          /could not safely resolve/,
        )
      }
      expect(fs.existsSync(outsideTarget)).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses a leading ~ instead of resolving it inside the worktree', () => {
    // `path.resolve` has never heard of a tilde, so `~/.ssh/id_rsa` used to
    // come back as `<worktree>/~/.ssh/id_rsa` and PASS -- an ALLOW at the one
    // spelling every reader of this function expects refused. It stayed
    // inside the worktree, so it was harmless in fact and unreadable as
    // intent, which is the wrong pair of properties for the check three
    // surfaces share. Expanding it would be worse: the floor's whole point is
    // that HOME is somewhere else.
    const { root, parent } = workspace()
    try {
      for (const spelling of [
        '~',
        '~/.ssh/id_rsa',
        '~root/.ssh/id_rsa',
        '~/',
      ]) {
        expect(() => assertSponsoredReadPath(root, spelling)).toThrow(
          /worktree/,
        )
        expect(() => assertSponsoredWritePath(root, spelling)).toThrow(
          /worktree/,
        )
        expect(() => assertSponsoredCommandCwd(root, spelling)).toThrow(
          /worktree/,
        )
      }
      // A tilde that no shell expands is an ordinary filename: Word's lock
      // file is a real thing to find beside a tracked document.
      fs.writeFileSync(path.join(root, '~$report.docx'), 'x')
      expect(assertSponsoredReadPath(root, '~$report.docx')).toContain(
        '~$report.docx',
      )
      // And a tilde anywhere but the front was never a shell expansion.
      expect(() => assertSponsoredWritePath(root, 'src/backup~')).not.toThrow()
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('answers a cwd the same way it answers a write (F9)', () => {
    // The cwd check used to be purely lexical while its write sibling
    // realpathed, so `cd linked-dir` out of the worktree was refused as a
    // write target and accepted as a working directory.
    const { root, parent } = workspace()
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'escape'))
    try {
      expect(() => assertSponsoredCommandCwd(root, 'escape')).toThrow(/symlink/)
      expect(() => assertSponsoredWritePath(root, 'escape/x')).toThrow(
        /symlink/,
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('secrets inside the workspace: the shell refuses what the file tools refuse', () => {
  const SECRETS: Record<string, string> = {
    '.env': 'REAL_VALUE_ENV',
    '.env.local': 'REAL_VALUE_LOCAL',
    'apps/web/.env.production': 'REAL_VALUE_NESTED',
    '.npmrc': 'REAL_VALUE_NPMRC',
    id_rsa: 'REAL_VALUE_KEY',
    'certs/server.pem': 'REAL_VALUE_PEM',
    '.envrc': 'REAL_VALUE_DIRENV',
    // Inside the repository's own directory, which the Linux scan must walk.
    '.git/deploy.key': 'REAL_VALUE_GIT',
  }
  function withSecrets(root: string): void {
    for (const [file, body] of Object.entries(SECRETS)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), `${body}\n`)
    }
    fs.writeFileSync(path.join(root, '.env.example'), 'TEMPLATE_NAME=\n')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'ORDINARY_CODE\n')
  }

  containedIt(
    'a contained shell reads no secret, and still reads templates and code',
    async () => {
      const { root, runtime, parent } = workspace()
      withSecrets(root)
      try {
        const reads = [...Object.keys(SECRETS), '.env.example', 'src/app.ts']
          .map((file) => `cat ${JSON.stringify(file)} 2>/dev/null`)
          .join('; ')
        // And by renaming it first: a rename is a write on the source path,
        // and a read-only deny let `mv` hand the value to an innocent name.
        const { out } = await runInSandbox(
          { workspaceRoot: root, runtimeDir: runtime, readOnlyGitDir: true },
          root,
          `${reads}; mv .env.local moved 2>/dev/null && cat moved 2>/dev/null; true`,
        )
        expect(out).not.toContain('REAL_VALUE')
        expect(out).toContain('TEMPLATE_NAME=')
        expect(out).toContain('ORDINARY_CODE')
        expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).toBe(
          'REAL_VALUE_LOCAL\n',
        )
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('the Linux scan finds exactly the files the read policy refuses', () => {
    const { root, parent } = workspace()
    withSecrets(root)
    // Not walked: dependencies (public package content) and the object store.
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', '.env'), 'x')
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'objects', 'x.key'), 'x')
    try {
      expect(
        sponsoredSecretFiles(root).map((file) => path.relative(root, file)),
      ).toEqual(Object.keys(SECRETS).sort())
      // A bound, and past it a refusal rather than a partial mask.
      expect(() => sponsoredSecretFiles(root, 3)).toThrow(/too large/)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('the macOS rules deny after allowing, escape the root, and fold case', () => {
    const { root, runtime, parent } = workspace()
    try {
      const profile = sponsoredMacProfile([root, runtime], [], [], [], [root])
      const lines = profile.split('\n')
      const denyAt = lines.findIndex((line) =>
        line.startsWith('(deny file-read*'),
      )
      expect(denyAt).toBeGreaterThan(
        lines.findIndex((line) => line.startsWith('(allow file-read*')),
      )
      // The templates are granted back AFTER the deny.
      expect(lines[denyAt + 1]).toContain('[eE][xX][aA][mM][pP][lL][eE]')
      const rules = sponsoredMacSecretReadRules('/tmp/a.b(c)+d').join('\n')
      expect(rules).toContain('^/tmp/a\\.b\\(c\\)\\+d/')
      expect(rules).toContain('\\.[eE][nN][vV]')
      expect(() => sponsoredMacSecretReadRules('/tmp/"quote')).toThrow(
        /quote/,
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('sponsored code search process containment', () => {
  it('cannot smuggle --pre through a quoted glob value', () => {
    const flags = "-g 'x --pre /bin/cat'"

    expect(sponsoredCodeSearchFlagsRefusal(flags)).toBeNull()
    expect(parseCodeSearchFlags(flags)).toEqual(['-g', 'x --pre /bin/cat'])
    expect(parseCodeSearchFlags(flags)).not.toContain('--pre')
    expect(sponsoredCodeSearchFlagsRefusal('-g x --pre /bin/cat')).toContain(
      '--pre',
    )
  })

  it('refuses a symlinked runtime before staging ripgrep', () => {
    const { root, runtime, parent } = workspace()
    const outside = path.join(parent, 'outside-runtime')
    fs.rmSync(runtime, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, runtime)
    try {
      expect(() =>
        createSponsoredCodeSearchBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }),
      ).toThrow(/runtime directory.*not a symlink/)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  containedIt(
    'runs permitted ripgrep I/O through the sponsored broker',
    async () => {
      const { root, runtime, parent } = workspace()
      fs.writeFileSync(
        path.join(root, 'inside.ts'),
        'export const NEEDLE = true\n',
      )
      try {
        const result = await codeSearch({
          projectPath: root,
          pattern: 'NEEDLE',
          processBroker: createSponsoredCodeSearchBroker({
            workspaceRoot: root,
            runtimeDir: runtime,
          }),
        })
        expect(JSON.stringify(result)).toContain('NEEDLE')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )
})

// ---------------------------------------------------------- F2 loopback deny

describe('sponsored loopback containment (F2)', () => {
  it('denies loopback in the macOS profile while keeping egress', () => {
    const profile = sponsoredMacProfile(['/tmp/ws'], [])
    expect(profile).toContain('(allow network*)')
    // AFTER the allow: seatbelt takes the last matching rule, so the order is
    // the rule.
    expect(profile.indexOf('(deny network-outbound')).toBeGreaterThan(
      profile.indexOf('(allow network*)'),
    )
    expect(profile).toContain(
      '(deny network-outbound (remote ip "localhost:*"))',
    )
  })

  containedIt('cannot reach a listener on this machine', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('ORCHESTRATOR-REACHED'),
    })
    const { root, runtime, parent } = workspace()
    try {
      const handle = createSponsoredTerminalBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
      }).start({
        executable: 'bash',
        args: [
          '-c',
          `curl -s --max-time 4 http://127.0.0.1:${server.port}/ || echo BLOCKED`,
        ],
        cwd: root,
        env: POLLUTED_ENV as NodeJS.ProcessEnv,
      })
      const stdout = drain(handle.stdout)
      const stderr = drain(handle.stderr)
      await handle.completion
      await stderr
      // The orchestrator's API pushes branches and opens pull requests with
      // the user's real credentials. A sandbox that can reach its own
      // supervisor contains nothing.
      expect(await stdout).not.toContain('ORCHESTRATOR-REACHED')
    } finally {
      server.stop(true)
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------- the layout Desktop creates

/**
 * A REAL project repository with a REAL linked worktree under it, exactly as
 * `freebuff-desktop/src/server/git/worktree.ts` lays one out.
 *
 * THIS IS THE POINT OF THE WHOLE SECTION. The git test above builds a
 * standalone repository with `git init` inside the sandbox root, so its `.git`
 * is a directory inside the write allowlist — a layout Desktop never produces.
 * Desktop runs every isolated thread in a LINKED worktree at
 * `<project>/.freebuff/worktrees/<threadId>`, whose `.git` is a GITFILE
 * pointing at `<project>/.git/worktrees/<threadId>`, which is outside the
 * sandbox root entirely. With the write roots at `[workspaceRoot, runtimeDir]`
 * every git command in that layout died at repository discovery:
 *
 *   fatal: not a git repository: (null)
 *
 * exit 128, on `status`, `add` and `commit` alike. So the standalone test was
 * green while the product could not commit at all, and the two look identical
 * from the outside. Building the real layout is the only thing that tells them
 * apart.
 *
 * The refs are PACKED deliberately (`git pack-refs --all`), which is both the
 * realistic state of any repository with history and the harder case: a ref
 * transaction takes `packed-refs.lock` even when it goes on to write a loose
 * ref, and without that one grant `git commit` fails outright. A test on a
 * freshly-initialised repository passes either way and proves nothing.
 */
function desktopLayout(): {
  project: string
  worktree: string
  runtime: string
  parent: string
  branch: string
  linkedWorktree: {
    commonDir: string
    gitDir: string
    branchNamespace: string
  }
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsored-desktop-'))
  const project = path.join(parent, 'project')
  fs.mkdirSync(project, { recursive: true })
  const git = (args: string[], cwd = project) =>
    spawnSync('git', args, { cwd, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main', '.'])
  git(['config', 'user.email', 'user@example.invalid'])
  git(['config', 'user.name', 'The User'])
  // A credential in the user's own config, so the read surface is visible to
  // anybody reading this test rather than only described in a docblock.
  git([
    'config',
    'remote.origin.url',
    'https://u:SECRET-TOKEN@github.invalid/u/r.git',
  ])
  fs.writeFileSync(path.join(project, 'README.md'), 'hello\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  git(['pack-refs', '--all'])

  const threadId = 'thread-abc'
  const branch = `freebuff/sponsored-advertiser-${threadId}`
  const worktree = path.join(project, '.freebuff', 'worktrees', threadId)
  git(['worktree', 'add', '-q', '-b', branch, worktree, 'main'])
  const runtime = path.join(project, '.freebuff', 'sponsored-runtime', threadId)
  fs.mkdirSync(runtime, { recursive: true })

  const resolve = (target: string) => {
    try {
      return fs.realpathSync(target)
    } catch {
      return target
    }
  }
  const ask = (flag: string) =>
    resolve(
      spawnSync(
        'git',
        ['-C', worktree, 'rev-parse', '--path-format=absolute', flag],
        { encoding: 'utf8' },
      ).stdout.trim(),
    )
  return {
    project,
    worktree: resolve(worktree),
    runtime: resolve(runtime),
    parent,
    branch,
    linkedWorktree: {
      commonDir: ask('--git-common-dir'),
      gitDir: ask('--git-dir'),
      branchNamespace: 'freebuff',
    },
  }
}

async function runInSandbox(
  options: Parameters<typeof createSponsoredTerminalBroker>[0],
  cwd: string,
  script: string,
  pathValue: string | undefined = POLLUTED_ENV.PATH,
): Promise<{ exitCode: number | null; out: string; err: string }> {
  const handle = createSponsoredTerminalBroker(options).start({
    executable: 'bash',
    args: ['-c', script],
    cwd,
    env: { ...POLLUTED_ENV, PATH: pathValue } as NodeJS.ProcessEnv,
  })
  const stdout = drain(handle.stdout)
  const stderr = drain(handle.stderr)
  const exitCode = await handle.completion
  const [out, err] = await Promise.all([stdout, stderr])
  return { exitCode, out, err }
}

const COMMIT_SCRIPT = [
  'set -e',
  'echo sponsored-change > CHANGED.md',
  'git status --porcelain',
  'git add CHANGED.md',
  'git -c user.email=sponsored@example.invalid -c user.name="Sponsored Run" commit -q -m "sponsored change" --no-verify',
  'git log --oneline -1 --format=%s',
].join('\n')

describe('sponsored git in the layout Desktop actually creates', () => {
  containedIt(
    "commits in a linked worktree, and the commit lands in the user's repository",
    async () => {
      const layout = desktopLayout()
      try {
        const { exitCode, out, err } = await runInSandbox(
          {
            workspaceRoot: layout.worktree,
            runtimeDir: layout.runtime,
            linkedWorktree: layout.linkedWorktree,
          },
          layout.worktree,
          COMMIT_SCRIPT,
        )
        // Named, so a regression prints the reason rather than a bare exit code.
        expect(err).not.toContain('not a git repository')
        expect(err).not.toContain('packed-refs.lock')
        expect(err).not.toContain('Operation not permitted')
        expect(exitCode).toBe(0)
        expect(out).toContain('sponsored change')

        // THE PRODUCT OUTCOME, asked of the USER'S repository rather than of the
        // sandbox: the branch has to be visible from the checkout the user will
        // open the pull request from, or `committed` and `landed` are unreachable
        // however well the commit went inside the worktree.
        const tip = spawnSync(
          'git',
          ['-C', layout.project, 'log', '--oneline', '-1', layout.branch],
          { encoding: 'utf8' },
        )
        expect(tip.status).toBe(0)
        expect(tip.stdout).toContain('sponsored change')

        // And it did not damage the repository on the way.
        expect(
          spawnSync('git', ['-C', layout.project, 'rev-parse', 'main'], {
            encoding: 'utf8',
          }).status,
        ).toBe(0)
        expect(
          spawnSync('git', ['-C', layout.project, 'fsck'], { encoding: 'utf8' })
            .stderr,
        ).not.toContain('error')
      } finally {
        fs.rmSync(layout.parent, { recursive: true, force: true })
      }
    },
  )

  /**
   * The blocker itself, pinned.
   *
   * Without the grant the run cannot even ask what repository it is in. This is
   * here so that the option above can never be quietly dropped as unnecessary:
   * if this test starts passing, the sandbox has stopped bounding the common
   * dir and the one below is no longer proving anything.
   */
  containedIt(
    'cannot reach the repository at all without the grant',
    async () => {
      const layout = desktopLayout()
      try {
        const { out, err } = await runInSandbox(
          { workspaceRoot: layout.worktree, runtimeDir: layout.runtime },
          layout.worktree,
          'git status --porcelain; echo "exit=$?"',
        )
        expect(err).toContain('not a git repository')
        expect(out).toContain('exit=128')
      } finally {
        fs.rmSync(layout.parent, { recursive: true, force: true })
      }
    },
  )

  /**
   * The grant is an ALLOWLIST, and this is the half that matters.
   *
   * `.git/hooks/*` is arbitrary code execution as the user on their next git
   * operation, in a directory that never appears in the pull request they
   * review. `.git/config` is the same thing through `core.pager`,
   * `diff.external`, `core.fsmonitor` and aliases — and worse, because the
   * ORCHESTRATOR runs `git -C <worktree>` unsandboxed, as the user, to build
   * the changes panel. Granting write to the common dir to make the commit work
   * would have been a bigger hole than the one it closed.
   */
  containedIt(
    "refuses every dangerous path under the user's real .git",
    async () => {
      const layout = desktopLayout()
      const common = layout.linkedWorktree.commonDir
      try {
        const probes: [string, string][] = [
          ['hooks', `${common}/hooks/post-checkout`],
          ['config', `${common}/config`],
          ['config-worktree', `${common}/config.worktree`],
          ['info', `${common}/info/exclude`],
          ['packed-refs', `${common}/packed-refs`],
          ['common-root', `${common}/a-new-file`],
          // Another branch's tip: the grant is scoped to `refs/heads/freebuff`,
          // so the user's own branches are out of reach. Granting `refs/`
          // wholesale would let a run rewrite or delete every branch they have.
          ['other-branch', `${common}/refs/heads/main`],
          ['other-branch-log', `${common}/logs/refs/heads/main`],
        ]
        const script = probes
          .map(
            ([name, target]) =>
              `echo pwned > ${JSON.stringify(target)} 2>/dev/null && echo "${name}=ALLOWED" || echo "${name}=denied"`,
          )
          .join('\n')
        const { out } = await runInSandbox(
          {
            workspaceRoot: layout.worktree,
            runtimeDir: layout.runtime,
            linkedWorktree: layout.linkedWorktree,
          },
          layout.worktree,
          script,
        )
        // Two kinds of target. EXISTING entries of the common dir (a file, or a
        // name under an existing directory) are rebound read-only on Linux and
        // denied by the profile on macOS: `Read-only file system` inside the
        // sandbox, on both arms. NEW names at the common dir's ROOT — a file
        // that does not exist yet, `config.worktree`, and `packed-refs`, which
        // the Linux arm hides from the run — land in the Linux tmpfs: the
        // write succeeds INSIDE and reaches nothing. macOS refuses those too.
        // Either way the assertion that matters is the host's, below.
        const discardedOnLinux = new Set([
          'config-worktree',
          'packed-refs',
          'common-root',
        ])
        for (const [name] of probes) {
          if (process.platform === 'linux' && discardedOnLinux.has(name)) {
            expect(out).toContain(`${name}=ALLOWED`)
          } else {
            expect(out).toContain(`${name}=denied`)
          }
        }

        // And the user's repository is genuinely untouched by the attempt.
        expect(
          fs.readFileSync(path.join(common, 'config'), 'utf8'),
        ).not.toContain('pwned')
        expect(fs.existsSync(path.join(common, 'hooks', 'post-checkout'))).toBe(
          false,
        )
        expect(fs.existsSync(path.join(common, 'config.worktree'))).toBe(false)
        expect(fs.existsSync(path.join(common, 'a-new-file'))).toBe(false)
        const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8')
        expect(packed).toContain('refs/heads/main')
        expect(packed).not.toContain('pwned')
        expect(
          fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8'),
        ).not.toContain('pwned')
        expect(
          spawnSync('git', ['-C', layout.project, 'rev-parse', 'main'], {
            encoding: 'utf8',
          }).status,
        ).toBe(0)
      } finally {
        fs.rmSync(layout.parent, { recursive: true, force: true })
      }
    },
  )

  /**
   * `packed-refs.lock` is granted; `packed-refs` is not.
   *
   * Split deliberately, and the split is the whole reason the lock is a
   * `literal` rather than the directory being writable: git must be able to
   * CREATE the lock for a ref transaction to run at all, and rewriting the
   * packed ref table is where deleting somebody else's branch would happen.
   *
   * On Linux the same property comes from a different mechanism: the common
   * dir is a tmpfs with the real entries rebound read-only and `packed-refs`
   * left out, so the lock (a new name) is creatable, and a rewrite of the
   * table lands in the tmpfs rather than on the host. git 2.55 takes the lock
   * on an ordinary commit — the CI runner found that the first time these
   * tests ran there — so a Linux arm that could not grant it could not commit.
   */
  containedIt(
    'lets git take the packed-refs lock without letting it rewrite packed-refs',
    async () => {
      const layout = desktopLayout()
      const common = layout.linkedWorktree.commonDir
      try {
        const { out } = await runInSandbox(
          {
            workspaceRoot: layout.worktree,
            runtimeDir: layout.runtime,
            linkedWorktree: layout.linkedWorktree,
          },
          layout.worktree,
          [
            `echo x > ${JSON.stringify(`${common}/packed-refs.lock`)} 2>/dev/null && echo lock=writable || echo lock=DENIED`,
            `rm -f ${JSON.stringify(`${common}/packed-refs.lock`)}`,
            `echo x > ${JSON.stringify(`${common}/packed-refs`)} 2>/dev/null && echo table=WRITABLE || echo table=denied`,
          ].join('\n'),
        )
        expect(out).toContain('lock=writable')
        if (process.platform === 'darwin') {
          expect(out).toContain('table=denied')
        } else {
          // Linux hides `packed-refs` and gives the run a tmpfs for new names,
          // so the write succeeds INSIDE and is discarded with the sandbox.
          expect(out).toContain('table=WRITABLE')
        }
        const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8')
        expect(packed).not.toMatch(/^x$/m)
        expect(packed).toContain('refs/heads/main')
        expect(fs.existsSync(path.join(common, 'packed-refs.lock'))).toBe(false)
      } finally {
        fs.rmSync(layout.parent, { recursive: true, force: true })
      }
    },
  )

  /**
   * The run's OWN branch packed, which `git gc` does to every branch in time.
   *
   * `pack-refs` deletes `refs/heads/<namespace>/` once nothing loose is left in
   * it, so a grant expressed as a bind mount has no source directory — bwrap
   * refused to start with "Can't find source path" until the directories were
   * created ahead of the spawn. The macOS profile names paths and never
   * noticed. Asserted as the product outcome, with the failure text named.
   */
  containedIt(
    "commits when the run's own branch is packed and its ref directory is gone",
    async () => {
      const layout = desktopLayout()
      const common = layout.linkedWorktree.commonDir
      try {
        spawnSync('git', ['-C', layout.project, 'pack-refs', '--all'])
        expect(
          fs.existsSync(path.join(common, 'refs', 'heads', 'freebuff')),
        ).toBe(false)
        const { exitCode, out, err } = await runInSandbox(
          {
            workspaceRoot: layout.worktree,
            runtimeDir: layout.runtime,
            linkedWorktree: layout.linkedWorktree,
          },
          layout.worktree,
          COMMIT_SCRIPT,
        )
        expect(err).not.toContain("Can't find source path")
        expect(err).not.toContain('packed-refs.lock')
        expect(err).not.toContain('Read-only file system')
        expect(exitCode).toBe(0)
        expect(out).toContain('sponsored change')
        const tip = spawnSync(
          'git',
          ['-C', layout.project, 'log', '--oneline', '-1', layout.branch],
          { encoding: 'utf8' },
        )
        expect(tip.stdout).toContain('sponsored change')
        // The packed table itself was not rewritten by the run.
        expect(
          fs.readFileSync(path.join(common, 'packed-refs'), 'utf8'),
        ).toContain('refs/heads/main')
        // The Linux arm materialised the run's own branch as a loose ref
        // before the spawn (its packed entry stays and is shadowed); on macOS
        // git wrote the loose ref itself. Either way the user's git resolves
        // it to the sponsored commit, which the `log` above proved.
        expect(
          fs.existsSync(path.join(common, 'refs', 'heads', layout.branch)),
        ).toBe(true)
      } finally {
        fs.rmSync(layout.parent, { recursive: true, force: true })
      }
    },
  )
})

// ------------------------------------------ git on macOS: the xcode-select shim

/**
 * A fake host for the resolver: `files` maps each executable PATH candidate
 * to its realpath; anything absent is not an executable file.
 */
function gitHost(
  files: Record<string, string>,
  developerGit: string | null = null,
) {
  const calls = { developerGit: 0 }
  const reals = new Map(Object.entries(files))
  if (developerGit) reals.set(developerGit, developerGit)
  return {
    calls,
    dependencies: {
      isExecutableFile: (pathname: string) => reals.has(pathname),
      realpath: (pathname: string) => reals.get(pathname) ?? null,
      developerGit: () => {
        calls.developerGit++
        return developerGit
      },
    },
  }
}

const CLT_GIT = '/Library/Developer/CommandLineTools/usr/bin/git'
const CLT_BIN = '/Library/Developer/CommandLineTools/usr/bin'
const KEG_GIT = '/opt/homebrew/Cellar/git/2.50.1/bin/git'
const KEG_BIN = '/opt/homebrew/Cellar/git/2.50.1/bin'
/**
 * What launchd hands a Finder-launched Desktop. The login-shell repair
 * APPENDS to it, so `/usr/bin` -- and its xcode-select `git` -- stays first.
 */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('which git a contained macOS shell runs', () => {
  it('a Finder-launched PATH gets the developer git ahead of the shim', () => {
    const host = gitHost(
      { '/usr/bin/git': '/usr/bin/git', '/opt/homebrew/bin/git': KEG_GIT },
      CLT_GIT,
    )
    expect(
      sponsoredMacGitPath(
        `${FINDER_PATH}:/opt/homebrew/bin`,
        host.dependencies,
      ),
    ).toBe(`${CLT_BIN}:${FINDER_PATH}:/opt/homebrew/bin`)
  })

  it("keeps the orchestrator's own git, through its symlink, from a directory the sandbox cannot read", () => {
    // The agentic:e2e shape: its shim dir lives under the temp dir, which the
    // profile does not make readable, so bash inside the run skipped it and
    // found `/usr/bin/git`.
    const shims = '/private/var/folders/xx/T/agentic-e2e-1/shims'
    const host = gitHost(
      { [`${shims}/git`]: KEG_GIT, '/usr/bin/git': '/usr/bin/git' },
      CLT_GIT,
    )
    expect(
      sponsoredMacGitPath(`/gh/bin:${shims}:${FINDER_PATH}`, host.dependencies),
    ).toBe(`/gh/bin:${KEG_BIN}:${shims}:${FINDER_PATH}`)
    // xcrun is not asked at all when the first git is not the shim.
    expect(host.calls.developerGit).toBe(0)
  })

  it('leaves PATH alone when the first git already lives where it is found', () => {
    const host = gitHost(
      { '/opt/local/bin/git': '/opt/local/bin/git' },
      CLT_GIT,
    )
    const value = `/opt/local/bin:${FINDER_PATH}`
    expect(sponsoredMacGitPath(value, host.dependencies)).toBe(value)
  })

  it('never chooses a git the profile does not already read', () => {
    // One under HOME, and a full Xcode under /Applications: both outside the
    // read set, so both are passed over rather than granted. The readable one
    // still goes AHEAD of the shim, or the shim would win inside the run.
    const host = gitHost(
      {
        '/Users/u/.local/bin/git': '/Users/u/.local/bin/git',
        '/usr/bin/git': '/usr/bin/git',
        '/opt/homebrew/bin/git': KEG_GIT,
      },
      '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
    )
    expect(
      sponsoredMacGitPath(
        `/Users/u/.local/bin:${FINDER_PATH}:/opt/homebrew/bin`,
        host.dependencies,
      ),
    ).toBe(`${KEG_BIN}:/Users/u/.local/bin:${FINDER_PATH}:/opt/homebrew/bin`)
  })

  it('with no readable git anywhere, changes nothing and throws nothing', () => {
    // A Mac with no developer tools: only the shim, and nothing behind it.
    const host = gitHost({ '/usr/bin/git': '/usr/bin/git' }, null)
    expect(sponsoredMacGitPath(FINDER_PATH, host.dependencies)).toBe(
      FINDER_PATH,
    )
    expect(host.calls.developerGit).toBe(1)
    expect(sponsoredMacGitPath(undefined, host.dependencies)).toBeUndefined()
    expect(sponsoredMacGitPath('', host.dependencies)).toBe('')
    // A developer "git" that is itself the shim, or relative, is no answer.
    for (const answer of ['/usr/bin/git', 'usr/bin/git']) {
      const odd = gitHost({ '/usr/bin/git': '/usr/bin/git' }, answer)
      expect(sponsoredMacGitPath(FINDER_PATH, odd.dependencies)).toBe(
        FINDER_PATH,
      )
    }
  })

  it('never resolves a relative PATH entry', () => {
    // Inside the run a relative entry is relative to the worktree, which the
    // advertiser's procedure writes.
    const host = gitHost(
      {
        'node_modules/.bin/git': '/opt/planted/git',
        '/usr/bin/git': '/usr/bin/git',
      },
      CLT_GIT,
    )
    expect(
      sponsoredMacGitPath(
        `node_modules/.bin:${FINDER_PATH}`,
        host.dependencies,
      ),
    ).toBe(`node_modules/.bin:${CLT_BIN}:${FINDER_PATH}`)
  })

  it('reads the developer directory from its link, spawning nothing', () => {
    const CLT = '/Library/Developer/CommandLineTools'
    const installed = (pathname: string) => pathname === CLT_GIT
    // No link: no developer tools, and nothing that could request an install.
    expect(
      findXcodeDeveloperGit({ readlink: () => null, isExecutableFile: installed }),
    ).toBeNull()
    // The macOS 26 link names the Command Line Tools; the older one is a fallback.
    expect(
      findXcodeDeveloperGit({
        readlink: (link) => (link === '/var/select/developer_dir' ? CLT : null),
        isExecutableFile: installed,
      }),
    ).toBe(CLT_GIT)
    expect(
      findXcodeDeveloperGit({
        readlink: (link) => (link === '/var/db/xcode_select_link' ? CLT : null),
        isExecutableFile: installed,
      }),
    ).toBe(CLT_GIT)
    // A link naming a directory that no longer has git is no answer.
    expect(
      findXcodeDeveloperGit({ readlink: () => CLT, isExecutableFile: () => false }),
    ).toBeNull()
  })

  it('puts stand-ins for every /usr/bin shim right before /usr/bin, whichever git wins', () => {
    const SHIMS = '/Users/u/.freebuff/sponsored-runtime/r/developer-shims'
    const shims = () => SHIMS
    // Finder PATH: the stand-ins (their `git` is the developer git) win, and
    // the whole Command Line Tools bin is never put on PATH.
    const finder = gitHost({ '/usr/bin/git': '/usr/bin/git' }, CLT_GIT)
    expect(
      sponsoredMacGitPath(FINDER_PATH, { ...finder.dependencies, developerShims: shims }),
    ).toBe(`${SHIMS}:${FINDER_PATH}`)
    // Homebrew git first: git stays Homebrew's, and `python3`/`make` in
    // /usr/bin still get their stand-ins.
    const brew = gitHost(
      { '/opt/homebrew/bin/git': KEG_GIT, '/usr/bin/git': '/usr/bin/git' },
      CLT_GIT,
    )
    expect(
      sponsoredMacGitPath(`/opt/homebrew/bin:${FINDER_PATH}`, {
        ...brew.dependencies,
        developerShims: shims,
      }),
    ).toBe(`${KEG_BIN}:/opt/homebrew/bin:${SHIMS}:${FINDER_PATH}`)
    // No /usr/bin on PATH: nothing to stand in for, and nothing is asked.
    let asked = 0
    const none = gitHost({ '/opt/local/bin/git': '/opt/local/bin/git' }, CLT_GIT)
    expect(
      sponsoredMacGitPath('/opt/local/bin:/bin', {
        ...none.dependencies,
        developerShims: () => {
          asked++
          return SHIMS
        },
      }),
    ).toBe('/opt/local/bin:/bin')
    expect(asked).toBe(0)
  })

  it('stands in only for the names /usr/bin already provides', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-shims-')))
    try {
      // Stand-in developer and shim directories; the developer one must sit
      // under a tree the profile reads, so it is checked through a real path.
      const shimDir = path.join(root, 'usr-bin')
      fs.mkdirSync(shimDir)
      for (const name of ['git', 'python3', 'ls']) fs.writeFileSync(path.join(shimDir, name), '')
      const dir = path.join(root, 'developer-shims')
      // Outside every readable root (a temp dir): refused, nothing created.
      const developerBin = path.join(root, 'clt-bin')
      fs.mkdirSync(developerBin)
      for (const name of ['git', 'python3', 'clang-format']) {
        fs.writeFileSync(path.join(developerBin, name), '#!/bin/sh\n', { mode: 0o755 })
      }
      expect(
        linkDeveloperShims({ dir, developerGit: path.join(developerBin, 'git'), shimDir }),
      ).toBeNull()
      expect(linkDeveloperShims({ dir, developerGit: null, shimDir })).toBeNull()
      expect(fs.existsSync(dir)).toBe(false)
      // The real Command Line Tools, where this Mac has them.
      const clt = findXcodeDeveloperGit()
      if (process.platform !== 'darwin' || !clt?.startsWith('/Library/')) return
      expect(linkDeveloperShims({ dir, developerGit: clt, shimDir })).toBe(dir)
      const linked = fs.readdirSync(dir).sort()
      // Only names both hold: `ls` has no developer twin, and CLT-only names
      // are never made visible.
      expect(linked).toEqual(['git', 'python3'].filter((n) => fs.existsSync(path.join(path.dirname(clt), n))))
      // An exec by absolute path, not a link: git finds its install from it.
      expect(fs.lstatSync(path.join(dir, 'git')).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(path.join(dir, 'git'), 'utf8')).toBe(
        `#!/bin/sh\nexec '${path.join(path.dirname(fs.realpathSync(clt)), 'git')}' "$@"\n`,
      )
      // Recreated from scratch: a planted entry does not survive.
      fs.writeFileSync(path.join(dir, 'planted'), '')
      linkDeveloperShims({ dir, developerGit: clt, shimDir })
      expect(fs.existsSync(path.join(dir, 'planted'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * The developer directory's git on THIS Mac, when the profile can read it.
 * Where it cannot (a full Xcode under /Applications and nothing else), the
 * resolver deliberately does not help, so these tests have nothing to prove.
 */
const HOST_DEVELOPER_GIT =
  process.platform === 'darwin' ? findXcodeDeveloperGit() : null
const shimIt = it.skipIf(
  !CONTAINMENT_USABLE ||
    process.platform !== 'darwin' ||
    !HOST_DEVELOPER_GIT?.startsWith('/Library/'),
)

/** Every string the shim, or xcrun behind it, prints when it runs in the sandbox. */
function expectNoShim(err: string): void {
  expect(err).not.toContain('xcode-select')
  expect(err).not.toContain('requesting install')
  expect(err).not.toContain('xcrun')
  expect(err).not.toContain('Operation not permitted')
}

describe('sponsored git on the PATH a Finder-launched Desktop hands the run', () => {
  shimIt(
    'runs a real git, and commits, with /usr/bin first on PATH',
    async () => {
      const { root, runtime, parent } = workspace()
      try {
        const { exitCode, out, err } = await runInSandbox(
          { workspaceRoot: root, runtimeDir: runtime },
          root,
          [
            'set -e',
            'command -v git',
            // Where git thinks it is installed: Apple's git derives it from the
            // path it was started by, and a wrong answer falls back to
            // /Applications/Xcode.app, which the profile cannot read.
            'git --exec-path',
            // Not only git: every other /usr/bin shim runs through a stand-in.
            'make --version > /dev/null',
            'git init -q .',
            'echo sponsored-change > CHANGED.md',
            'git add CHANGED.md',
            'git -c user.email=sponsored@example.invalid -c user.name="Sponsored Run" commit -q -m "sponsored change" --no-verify',
            'git log --oneline -1 --format=%s',
          ].join('\n'),
          FINDER_PATH,
        )
        expectNoShim(err)
        expect(exitCode).toBe(0)
        // Found through the per-run stand-in for the shim, which starts the
        // developer git by its own path, so git finds its own install.
        const [found, execPath] = out.split('\n')
        expect(found).toBe(path.join(runtime, 'developer-shims', 'git'))
        expect(execPath).toBe(
          path.join(
            path.dirname(path.dirname(fs.realpathSync(HOST_DEVELOPER_GIT!))),
            'libexec',
            'git-core',
          ),
        )
        expect(out).toContain('sponsored change')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  shimIt(
    "commits in a linked worktree, and it lands in the user's repository",
    async () => {
      const layout = desktopLayout()
      try {
        const { exitCode, out, err } = await runInSandbox(
          {
            workspaceRoot: layout.worktree,
            runtimeDir: layout.runtime,
            linkedWorktree: layout.linkedWorktree,
          },
          layout.worktree,
          COMMIT_SCRIPT,
          FINDER_PATH,
        )
        expectNoShim(err)
        expect(exitCode).toBe(0)
        expect(out).toContain('sponsored change')
        const tip = spawnSync(
          'git',
          ['-C', layout.project, 'log', '--oneline', '-1', layout.branch],
          { encoding: 'utf8' },
        )
        expect(tip.stdout).toContain('sponsored change')
      } finally {
        fs.rmSync(layout.parent, { recursive: true, force: true })
      }
    },
  )

  shimIt(
    "runs the orchestrator's git even when its PATH entry is unreadable inside the sandbox",
    async () => {
      // agentic:e2e's shape: a shim dir under the temp dir, symlinking the
      // host's git. The sandbox cannot `stat` it, so before the fix the run
      // got `/usr/bin/git` instead.
      // The host's own git when it is a readable, non-shim one (Homebrew, on
      // a developer Mac), so the assertion can tell "followed the symlink"
      // from "fell through to the developer git"; else the developer git.
      const hostFirst = spawnSync('bash', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).stdout.trim()
      const hostReal = hostFirst ? fs.realpathSync(hostFirst) : ''
      const target = /^\/(opt|usr\/local)\//.test(hostReal)
        ? hostReal
        : fs.realpathSync(HOST_DEVELOPER_GIT!)
      const { root, runtime, parent } = workspace()
      const shims = path.join(parent, 'shims')
      fs.mkdirSync(shims)
      fs.symlinkSync(target, path.join(shims, 'git'))
      try {
        const { exitCode, out, err } = await runInSandbox(
          { workspaceRoot: root, runtimeDir: runtime },
          root,
          [
            'set -e',
            'command -v git',
            'git --version',
            'git init -q .',
            'echo x > A.md',
            'git add A.md',
            'git -c user.email=s@example.invalid -c user.name=S commit -q -m c --no-verify',
          ].join('\n'),
          `${shims}:${FINDER_PATH}`,
        )
        expectNoShim(err)
        expect(exitCode).toBe(0)
        const [resolved, version] = out.split('\n')
        expect(resolved).toBe(target)
        expect(version).toBe(
          spawnSync(target, ['--version'], { encoding: 'utf8' }).stdout.trim(),
        )
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('is a PATH change, not a grant: the profile never names the data link', () => {
    const profile = sponsoredMacProfile(['/tmp/w', '/tmp/r'], [])
    expect(profile).not.toContain('developer_dir')
    expect(profile).not.toContain('xcode_select_link')
    expect(profile).not.toContain('/Applications')
  })
})

// ------------------------------------------- /bin/sh's selector, and its noise

describe('the shell selector is readable, and nothing around it is', () => {
  containedIt('a plain command prints nothing on stderr', async () => {
    // `/bin/sh` reads `/private/var/select/sh` at startup. Ungranted, that emits
    //   Error opening /private/var/select/sh: Operation not permitted
    // on stderr BEFORE the command runs -- and in a sponsored run stderr is tool
    // output, so every single command handed the model a fake error. Driven
    // through `sh` on purpose: `bash` never reads the selector and would pass
    // whether or not the grant exists.
    const { root, runtime, parent } = workspace()
    try {
      const handle = createSponsoredTerminalBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
      }).start({
        executable: 'sh',
        args: ['-c', 'echo ok'],
        cwd: root,
        env: process.env,
      })
      const stdout = drain(handle.stdout)
      const stderr = drain(handle.stderr)
      await handle.completion
      const [out, err] = await Promise.all([stdout, stderr])
      expect(out.trim()).toBe('ok')
      expect(err).not.toContain('/var/select')
      expect(err.trim()).toBe('')
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  containedIt(
    'grants the one link and not the directory it sits in',
    async () => {
      // The grant must stay a readlink on one symlink whose target is already
      // readable through `(subpath "/bin")`. If it ever becomes a subpath of
      // `/var/select` or of `/private/var`, these stop failing.
      const { root, runtime, parent } = workspace()
      try {
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          args: [
            '-c',
            [
              'ls /var >/dev/null 2>&1 || echo "var:denied"',
              'ls /private/var >/dev/null 2>&1 || echo "private-var:denied"',
              'ls /var/select >/dev/null 2>&1 || echo "select:denied"',
              'cat /var/run/resolv.conf >/dev/null 2>&1 || echo "resolv:denied"',
              'cat /var/select/developer_dir >/dev/null 2>&1 || echo "xcode:denied"',
              // `cat` fails on the directory the link names whether or not the
              // link is readable; `readlink` is the call the shim makes, and it
              // stays refused -- git works through `sponsoredMacGitPath`, not
              // through a grant here.
              'readlink /var/select/developer_dir >/dev/null 2>&1 || echo "xcode-link:denied"',
            ].join('\n'),
          ],
          cwd: root,
          env: process.env,
        })
        const stdout = drain(handle.stdout)
        await handle.completion
        const out = await stdout
        for (const marker of [
          'var:denied',
          'private-var:denied',
          'select:denied',
          'resolv:denied',
          'xcode:denied',
          'xcode-link:denied',
        ]) {
          expect(out).toContain(marker)
        }
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
  )
})
