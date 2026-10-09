import { describe, expect, it } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createSponsoredTerminalBroker } from '../tools/sponsored-sandbox'
import { sponsoredToolchainReadRoots } from '../tools/sponsored-toolchain'
import { sponsoredContainmentTestGate } from '../../test/sponsored-containment-gate'

/**
 * COD-825: the user's own Node toolchain, under their home folder, is
 * readable to a sponsored run, and nothing else in that home folder is.
 */

const CONTAINMENT_USABLE = sponsoredContainmentTestGate()

/** The host's own Node install, whose `node` and `npm` the layouts reuse. */
function hostNodePrefix(): string | null {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry) continue
    try {
      const real = fs.realpathSync(path.join(entry, 'node'))
      const prefix = path.dirname(path.dirname(real))
      if (fs.existsSync(path.join(prefix, 'lib', 'node_modules', 'npm'))) {
        return prefix
      }
    } catch {
      // Not here.
    }
  }
  return null
}

const HOST_NODE_PREFIX = hostNodePrefix()

/** A file in the fake home, as cheaply as the filesystem allows. */
function place(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    // Already executable; a hard link to a file someone else owns cannot be
    // chmodded, so leave it alone.
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
  }
}

/**
 * A Node prefix the way nvm, mise, fnm and volta lay one out: `bin/node`,
 * `lib/node_modules/npm`, and `bin/npm`/`bin/npx` as RELATIVE symlinks into
 * it. That last part is what made `npx` fail with EPERM while `node` ran.
 * Plus `etc/npmrc`, npm's global config, which can carry a registry token.
 */
function nodePrefix(prefix: string, hostPrefix: string): void {
  place(path.join(hostPrefix, 'bin', 'node'), path.join(prefix, 'bin', 'node'))
  // A dynamically linked node (Homebrew) loads `../lib/libnode.*.dylib`.
  for (const entry of fs.readdirSync(path.join(hostPrefix, 'lib'), {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.startsWith('libnode')) {
      place(
        path.join(hostPrefix, 'lib', entry.name),
        path.join(prefix, 'lib', entry.name),
      )
    }
  }
  fs.cpSync(
    path.join(hostPrefix, 'lib', 'node_modules', 'npm'),
    path.join(prefix, 'lib', 'node_modules', 'npm'),
    { recursive: true },
  )
  fs.symlinkSync(
    '../lib/node_modules/npm/bin/npm-cli.js',
    path.join(prefix, 'bin', 'npm'),
  )
  fs.symlinkSync(
    '../lib/node_modules/npm/bin/npx-cli.js',
    path.join(prefix, 'bin', 'npx'),
  )
  fs.mkdirSync(path.join(prefix, 'etc'), { recursive: true })
  fs.writeFileSync(
    path.join(prefix, 'etc', 'npmrc'),
    '//registry.npmjs.org/:_authToken=REAL_VALUE_GLOBAL_NPMRC\n',
  )
}

/** The user's secrets, where they really keep them. */
function homeSecrets(home: string): void {
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'REAL_VALUE_SSH\n')
  fs.writeFileSync(path.join(home, '.npmrc'), 'REAL_VALUE_NPMRC\n')
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true })
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'REAL_VALUE_AWS\n')
}

type Layout = {
  name: string
  /** Builds the layout under `home`; returns the toolchain's PATH entry. */
  build: (home: string, hostPrefix: string) => string
}

const LAYOUTS: Layout[] = [
  {
    name: 'nvm',
    build: (home, host) => {
      const prefix = path.join(home, '.nvm', 'versions', 'node', 'v22.0.0')
      nodePrefix(prefix, host)
      return path.join(prefix, 'bin')
    },
  },
  {
    name: 'mise (activated)',
    build: (home, host) => {
      const prefix = path.join(
        home,
        '.local',
        'share',
        'mise',
        'installs',
        'node',
        '22',
      )
      nodePrefix(prefix, host)
      return path.join(prefix, 'bin')
    },
  },
  {
    // fnm's PATH entry is a per-shell SYMLINK to the install, so the run must
    // see it at that spelling, not only at its real path.
    name: 'fnm',
    build: (home, host) => {
      const install = path.join(
        home,
        '.local',
        'share',
        'fnm',
        'node-versions',
        'v22.0.0',
        'installation',
      )
      nodePrefix(install, host)
      const multishell = path.join(
        home,
        '.local',
        'state',
        'fnm_multishells',
        '1234_5678',
      )
      fs.mkdirSync(path.dirname(multishell), { recursive: true })
      fs.symlinkSync(install, multishell)
      return path.join(multishell, 'bin')
    },
  },
  {
    // volta's image folder on PATH. volta's own `~/.volta/bin` shims find
    // their data through $HOME and are out of scope (see the helper).
    name: 'volta (image on PATH)',
    build: (home, host) => {
      const prefix = path.join(
        home,
        '.volta',
        'tools',
        'image',
        'node',
        '22.0.0',
      )
      nodePrefix(prefix, host)
      return path.join(prefix, 'bin')
    },
  },
]

function fakeHome(): { home: string; parent: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsored-toolchain-'))
  const home = path.join(parent, 'home', 'user')
  fs.mkdirSync(home, { recursive: true })
  return { home, parent }
}

function fakeNodePrefix(prefix: string): void {
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin'), {
    recursive: true,
  })
  fs.writeFileSync(path.join(prefix, 'bin', 'node'), '#!/bin/sh\n')
  fs.chmodSync(path.join(prefix, 'bin', 'node'), 0o755)
  fs.writeFileSync(
    path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    '',
  )
  fs.chmodSync(
    path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    0o755,
  )
  fs.symlinkSync(
    '../lib/node_modules/npm/bin/npx-cli.js',
    path.join(prefix, 'bin', 'npx'),
  )
}

describe('sponsoredToolchainReadRoots', () => {
  it("grants a Node prefix's bin and lib, never the prefix itself", () => {
    const { home, parent } = fakeHome()
    try {
      const prefix = path.join(home, '.nvm', 'versions', 'node', 'v22.0.0')
      fakeNodePrefix(prefix)
      const real = fs.realpathSync(prefix)
      const { roots } = sponsoredToolchainReadRoots(
        { PATH: `${path.join(prefix, 'bin')}:/usr/bin:/bin` },
        home,
      )
      // Real paths, plus their spelling when the temp folder is itself a
      // link (macOS `/var` -> `/private/var`); never the prefix.
      expect(roots).toContain(path.join(real, 'bin'))
      expect(roots).toContain(path.join(real, 'lib'))
      expect(roots.every((root) => /\/(bin|lib)$/.test(root))).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('grants a plain bin folder (bun) as itself', () => {
    const { home, parent } = fakeHome()
    try {
      const bin = path.join(home, '.bun', 'bin')
      fs.mkdirSync(bin, { recursive: true })
      fs.writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\n')
      fs.chmodSync(path.join(bin, 'bun'), 0o755)
      fs.mkdirSync(path.join(home, '.bun', 'install', 'cache'), {
        recursive: true,
      })
      const { roots } = sponsoredToolchainReadRoots({ PATH: bin }, home)
      expect(roots).toContain(fs.realpathSync(bin))
      expect(roots.every((root) => root.endsWith('/.bun/bin'))).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('grants a symlinked PATH entry under its spelling and its real path', () => {
    const { home, parent } = fakeHome()
    try {
      const install = path.join(home, '.local', 'share', 'fnm', 'v22')
      fakeNodePrefix(install)
      const link = path.join(home, '.local', 'state', 'fnm_multishells', '1')
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(install, link)
      const { roots } = sponsoredToolchainReadRoots(
        { PATH: path.join(link, 'bin') },
        home,
      )
      const real = fs.realpathSync(install)
      expect(roots).toContain(path.join(real, 'bin'))
      expect(roots).toContain(path.join(real, 'lib'))
      expect(roots).toContain(path.join(link, 'bin'))
      // `bin/npx -> ../lib/...` resolves from the spelling.
      expect(roots).toContain(path.join(link, 'lib'))
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses home, its ancestors, secret folders and missing entries, and says why', () => {
    const { home, parent } = fakeHome()
    try {
      homeSecrets(home)
      fs.mkdirSync(path.join(home, '.config', 'tool', 'bin'), {
        recursive: true,
      })
      // A tool folder with a credential file at its top.
      const leaky = path.join(home, 'tools', 'bin')
      fs.mkdirSync(leaky, { recursive: true })
      fs.writeFileSync(path.join(leaky, '.npmrc'), 'REAL_VALUE\n')
      const logged: string[] = []
      const { roots, skipped } = sponsoredToolchainReadRoots(
        {
          PATH: [
            home,
            path.dirname(home),
            path.join(home, '.ssh'),
            path.join(home, '.config', 'tool', 'bin'),
            leaky,
            path.join(home, '.nvm', 'versions', 'node', 'gone', 'bin'),
            '/usr/bin',
            'relative/bin',
          ].join(path.delimiter),
        },
        home,
        (skip) => logged.push(skip.reason),
      )
      expect(roots).toEqual([])
      expect(skipped.map((skip) => skip.reason).sort()).toEqual([
        'credential_file',
        // Home itself. Its parent is outside home: never a candidate at all.
        'home_or_ancestor',
        'missing',
        'secret_location',
        'secret_location',
      ])
      expect(logged.length).toBe(skipped.length)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("grants pnpm's macOS default under Library, and not Library", () => {
    const { home, parent } = fakeHome()
    try {
      const pnpm = path.join(home, 'Library', 'pnpm')
      fs.mkdirSync(pnpm, { recursive: true })
      fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true })
      const { roots } = sponsoredToolchainReadRoots(
        { PATH: [pnpm, path.join(home, 'Library')].join(path.delimiter) },
        home,
      )
      expect(roots).toContain(fs.realpathSync(pnpm))
      expect(roots.every((root) => root.endsWith('/Library/pnpm'))).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('never throws on an empty or missing PATH or home', () => {
    expect(sponsoredToolchainReadRoots({}, os.homedir()).roots).toEqual([])
    expect(
      sponsoredToolchainReadRoots({ PATH: '/usr/bin' }, '/nonexistent-home')
        .roots,
    ).toEqual([])
  })
})

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += String(chunk)
  return out
}

describe('the toolchain inside the sandbox (COD-825 acceptance)', () => {
  const containedIt = it.skipIf(!CONTAINMENT_USABLE || !HOST_NODE_PREFIX)

  for (const layout of LAYOUTS) {
    containedIt(
      `${layout.name}: node, npx and a local npx package run; secrets stay refused`,
      async () => {
        const { home, parent } = fakeHome()
        const root = path.join(parent, 'worktree')
        const runtime = path.join(parent, 'runtime')
        fs.mkdirSync(runtime, { recursive: true })
        // A project with a local package for `npx <pkg> --help`.
        const pkg = path.join(root, 'node_modules', 'hello-sponsored')
        fs.mkdirSync(pkg, { recursive: true })
        fs.writeFileSync(
          path.join(pkg, 'package.json'),
          JSON.stringify({
            name: 'hello-sponsored',
            version: '1.0.0',
            bin: { 'hello-sponsored': 'cli.js' },
          }),
        )
        fs.writeFileSync(
          path.join(pkg, 'cli.js'),
          "#!/usr/bin/env node\nconsole.log('HELLO_HELP', process.argv.slice(2).join(' '))\n",
        )
        fs.chmodSync(path.join(pkg, 'cli.js'), 0o755)
        fs.mkdirSync(path.join(root, 'node_modules', '.bin'), {
          recursive: true,
        })
        fs.symlinkSync(
          '../hello-sponsored/cli.js',
          path.join(root, 'node_modules', '.bin', 'hello-sponsored'),
        )
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'project', version: '1.0.0' }),
        )
        homeSecrets(home)
        try {
          const bin = layout.build(home, HOST_NODE_PREFIX!)
          const env = { PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter) }
          const { roots } = sponsoredToolchainReadRoots(env, home)
          const handle = createSponsoredTerminalBroker({
            workspaceRoot: root,
            runtimeDir: runtime,
            readOnlyGitDir: true,
            additionalReadRoots: roots,
          }).start({
            executable: 'bash',
            args: [
              '-c',
              [
                'echo "NODE=$(node --version)"',
                'echo "NPX=$(npx --version)"',
                'npx --no -- hello-sponsored --help',
                `cat ${JSON.stringify(path.join(home, '.ssh', 'id_rsa'))}`,
                `cat ${JSON.stringify(path.join(home, '.npmrc'))}`,
                `cat ${JSON.stringify(path.join(home, '.aws', 'credentials'))}`,
                `cat ${JSON.stringify(path.join(path.dirname(bin), 'etc', 'npmrc'))}`,
                // The grant is read-only.
                `touch ${JSON.stringify(path.join(bin, 'planted'))} 2>/dev/null && echo WROTE_TOOLCHAIN`,
                'true',
              ].join('\n'),
            ],
            cwd: root,
            env: env as NodeJS.ProcessEnv,
          })
          const stdout = drain(handle.stdout)
          const stderr = drain(handle.stderr)
          const exitCode = await handle.completion
          const [out, err] = await Promise.all([stdout, stderr])
          const context = `${out}\n${err}`
          expect(out, context).toMatch(/NODE=v\d+\./)
          expect(out, context).toMatch(/NPX=\d+\.\d+\.\d+/)
          expect(out, context).toContain('HELLO_HELP --help')
          expect(out, context).not.toContain('REAL_VALUE')
          expect(out, context).not.toContain('WROTE_TOOLCHAIN')
          expect(exitCode).toBe(0)
        } finally {
          fs.rmSync(parent, { recursive: true, force: true })
        }
      },
      60_000,
    )
  }

  // `bun test` runs under bun, so its own binary stands in for the user's.
  it.skipIf(!CONTAINMENT_USABLE || !process.versions.bun)(
    'bun: a bun installed under ~/.bun runs inside the sandbox',
    async () => {
      const { home, parent } = fakeHome()
      const root = path.join(parent, 'worktree')
      const runtime = path.join(parent, 'runtime')
      fs.mkdirSync(root, { recursive: true })
      fs.mkdirSync(runtime, { recursive: true })
      homeSecrets(home)
      try {
        const bin = path.join(home, '.bun', 'bin')
        place(fs.realpathSync(process.execPath), path.join(bin, 'bun'))
        const env = { PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter) }
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
          readOnlyGitDir: true,
          additionalReadRoots: sponsoredToolchainReadRoots(env, home).roots,
        }).start({
          executable: 'bash',
          args: [
            '-c',
            [
              'echo "BUN=$(bun --version)"',
              `cat ${JSON.stringify(path.join(home, '.ssh', 'id_rsa'))}`,
              `cat ${JSON.stringify(path.join(home, '.npmrc'))}`,
              'true',
            ].join('\n'),
          ],
          cwd: root,
          env: env as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        const stderr = drain(handle.stderr)
        await handle.completion
        const [out, err] = await Promise.all([stdout, stderr])
        expect(out, `${out}\n${err}`).toMatch(/BUN=\d+\.\d+\.\d+/)
        expect(out).not.toContain('REAL_VALUE')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
    60_000,
  )

  containedIt(
    'without the grant the same layout has no node (the bug)',
    async () => {
      const { home, parent } = fakeHome()
      const root = path.join(parent, 'worktree')
      const runtime = path.join(parent, 'runtime')
      fs.mkdirSync(root, { recursive: true })
      fs.mkdirSync(runtime, { recursive: true })
      try {
        const bin = LAYOUTS[0]!.build(home, HOST_NODE_PREFIX!)
        const handle = createSponsoredTerminalBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
        }).start({
          executable: 'bash',
          args: [
            '-c',
            `${JSON.stringify(path.join(bin, 'node'))} --version || echo NO_NODE`,
          ],
          cwd: root,
          env: { PATH: `${bin}:/usr/bin:/bin` } as NodeJS.ProcessEnv,
        })
        const stdout = drain(handle.stdout)
        void drain(handle.stderr)
        await handle.completion
        expect(await stdout).toContain('NO_NODE')
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
