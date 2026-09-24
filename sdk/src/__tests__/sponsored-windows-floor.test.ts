/**
 * The Windows floor broker (COD-642): no OS sandbox, the floor only.
 *
 * Two halves. The first runs on every OS and pins the DECISIONS, which are
 * pure: when the floor is selected (only a real Windows host, only under a
 * server grant naming it), which shell it runs (Windows PowerShell by absolute
 * path) and how. The second runs only on a real Windows host and pins the
 * BEHAVIOUR through the same `runTerminalCommand` path Desktop uses: the
 * profile directories, the scrubbed environment, git without a credential or
 * a hook, and the working directory.
 *
 * `SPONSORED_FLOOR_REQUIRED=1` (set by the `test-sponsored-floor-windows` job
 * in `.github/workflows/ci.yml`) turns a skip of the second half into a
 * failure, for the same reason `SPONSORED_CONTAINMENT_REQUIRED` exists: a
 * skip reads exactly like a pass in a green build.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  SPONSORED_POWERSHELL_ARGS,
  SPONSORED_POWERSHELL_PREAMBLE,
  createSponsoredCodeSearchBroker,
  createSponsoredTerminalBroker,
  sponsoredBrokerArm,
  sponsoredWindowsFloorLaunch,
  sponsoredWindowsRunPaths,
  windowsPowerShellPath,
} from '../tools/sponsored-sandbox'
import { codeSearch } from '../tools/code-search'
import { runTerminalCommand } from '../tools/run-terminal-command'

const FLOOR_GRANT = {
  executionSurface: 'desktop_windows',
  containment: 'floor',
} as const

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function workspace(): { root: string; runtime: string; parent: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsored-floor-'))
  temps.push(parent)
  const root = path.join(parent, 'worktree')
  const runtime = path.join(parent, 'runtime')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  return { root, runtime, parent }
}

// ------------------------------------------------------------ every OS

describe('which broker a run gets', () => {
  it('macOS and Linux are their sandbox whatever the grant says', () => {
    for (const hostPlatform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        sponsoredBrokerArm({
          hostPlatform,
          platform: 'darwin',
          serverGrant: FLOOR_GRANT,
        }),
      ).toBe('sandbox-exec')
      expect(
        sponsoredBrokerArm({
          hostPlatform,
          platform: 'linux',
          serverGrant: FLOOR_GRANT,
        }),
      ).toBe('bubblewrap')
    }
  })

  it('the floor needs a real Windows host AND a grant naming it', () => {
    expect(
      sponsoredBrokerArm({
        hostPlatform: 'win32',
        platform: 'win32',
        serverGrant: FLOOR_GRANT,
      }),
    ).toBe('floor')
    for (const serverGrant of [
      undefined,
      null,
      {},
      { executionSurface: 'desktop_windows' },
      { containment: 'floor' },
      { executionSurface: 'desktop_macos', containment: 'floor' },
    ]) {
      expect(
        sponsoredBrokerArm({
          hostPlatform: 'win32',
          platform: 'win32',
          serverGrant,
        }),
      ).toBeNull()
    }
  })

  it('a caller cannot select the floor on a Mac or Linux host by naming win32', () => {
    // `platform` is an option; `hostPlatform` is `process.platform`, which the
    // broker reads itself. A macOS or Linux failure never lands on the floor.
    for (const hostPlatform of ['darwin', 'linux'] as const) {
      expect(
        sponsoredBrokerArm({
          hostPlatform,
          platform: 'win32',
          serverGrant: FLOOR_GRANT,
        }),
      ).toBeNull()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'the broker refuses a floor grant on this non-Windows host',
    () => {
      const { root, runtime } = workspace()
      const broker = createSponsoredTerminalBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
        platform: 'win32',
        serverGrant: FLOOR_GRANT,
      })
      expect(broker.ownsShell).toBeUndefined()
      expect(() =>
        broker.start({
          executable: 'bash',
          args: ['-c', 'echo hi'],
          cwd: root,
          env: {},
        }),
      ).toThrow(/cannot be contained on win32/)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'a sandbox broker is never the floor, and never owns its shell',
    () => {
      const { root, runtime } = workspace()
      for (const platform of ['darwin', 'linux'] as const) {
        expect(
          createSponsoredTerminalBroker({
            workspaceRoot: root,
            runtimeDir: runtime,
            platform,
            serverGrant: FLOOR_GRANT,
          }).ownsShell,
        ).toBeUndefined()
      }
    },
  )
})

describe('what the floor runs', () => {
  it('Windows PowerShell, by absolute path under the system root', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(windowsPowerShellPath({ windir: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    // Never a bare name or a relative root: the working directory is a
    // repository the procedure edits, and Windows looks there first.
    for (const SystemRoot of [undefined, '', 'Windows', '.\\evil', '\\\\host\\share']) {
      expect(windowsPowerShellPath({ SystemRoot })).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      )
    }
  })

  it('a shell command: fixed switches, the preamble, and the command as ONE argument', () => {
    const command = `Write-Output "a b" 'c "d"'; npm pkg get name`
    const launch = sponsoredWindowsFloorLaunch(
      { executable: '', args: [], cwd: 'C:\\w', env: {}, command },
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(launch.file).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(launch.args).toEqual([
      ...SPONSORED_POWERSHELL_ARGS,
      `${SPONSORED_POWERSHELL_PREAMBLE}\n${command}`,
    ])
    expect(launch.args).toContain('-NoProfile')
    expect(launch.args).toContain('-NonInteractive')
    expect(launch.args.at(-2)).toBe('-Command')
  })

  it('anything else runs directly with no shell, and only by absolute path', () => {
    const rg = 'C:\\Program Files\\Freebuff\\rg.exe'
    expect(
      sponsoredWindowsFloorLaunch({
        executable: rg,
        args: ['--json', 'needle', '.'],
        cwd: 'C:\\w',
        env: {},
      }),
    ).toEqual({ file: rg, args: ['--json', 'needle', '.'] })
    expect(() =>
      sponsoredWindowsFloorLaunch({
        executable: 'rg.exe',
        args: [],
        cwd: 'C:\\w',
        env: {},
      }),
    ).toThrow(/absolute path/)
  })

  it('points the run at its own directories, all under the run', () => {
    const runtime = path.join(os.tmpdir(), 'run-1')
    const paths = sponsoredWindowsRunPaths(runtime)
    expect(paths.home).toBe(path.join(runtime, 'home'))
    expect(paths.tmp).toBe(path.join(runtime, 'tmp'))
    expect(paths.appData).toBe(path.join(runtime, 'home', 'AppData', 'Roaming'))
    expect(paths.localAppData).toBe(
      path.join(runtime, 'home', 'AppData', 'Local'),
    )
  })
})

// --------------------------------------------------------- Windows only

const FLOOR_HOST =
  process.platform === 'win32' && fs.existsSync(windowsPowerShellPath())
if (process.env.SPONSORED_FLOOR_REQUIRED === '1' && !FLOOR_HOST) {
  throw new Error(
    `The Windows floor tests cannot run here (${process.platform}${process.platform === 'win32' ? ', no Windows PowerShell' : ''}). SPONSORED_FLOOR_REQUIRED=1 is set, so a skip is a build error: run this job on windows-latest.`,
  )
}
/**
 * Above Bun's 5s default because a Windows runner starts PowerShell slowly,
 * and generous so that a regression in the module-cache fix below fails on
 * its own assertion (with a duration) rather than as a bare timeout.
 */
const FLOOR_TIMEOUT_MS = 180_000
const floorIt = (name: string, fn: () => unknown) =>
  it.skipIf(!FLOOR_HOST)(name, fn as () => Promise<void>, FLOOR_TIMEOUT_MS)

/** A floor broker, and a way to run a command through it the way Desktop does. */
function floor(extraEnv: Record<string, string> = {}) {
  const { root, runtime, parent } = workspace()
  const broker = createSponsoredCodeSearchBroker({
    workspaceRoot: root,
    runtimeDir: runtime,
    serverGrant: FLOOR_GRANT,
  })
  const run = async (command: string, cwd = root, timeout = 150) => {
    const started = Date.now()
    const [{ value }] = await runTerminalCommand({
      command,
      process_type: 'SYNC',
      cwd,
      timeout_seconds: timeout,
      env: extraEnv,
      terminalCommandBroker: broker,
    })
    const result = value as {
      stdout: string
      stderr?: string
      exitCode?: number
    }
    // Printed so the CI log shows what a floor command actually costs, and
    // what it said on stderr when an assertion below disagrees with it.
    console.log(
      `[floor] ${Date.now() - started}ms exit=${result.exitCode} ${JSON.stringify(command.slice(0, 60))}${result.stderr ? ` stderr=${JSON.stringify(result.stderr.slice(0, 300))}` : ''}`,
    )
    return result
  }
  return { root, runtime, parent, broker, run, home: path.join(runtime, 'home') }
}

/** The test's OWN git, with the user's environment, for fixture setup only. */
function hostGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

function initRepo(root: string): void {
  hostGit(root, ['init', '-q', '-b', 'main', '.'])
  hostGit(root, ['config', 'user.email', 'floor@example.invalid'])
  hostGit(root, ['config', 'user.name', 'Floor Test'])
  fs.writeFileSync(path.join(root, 'README.md'), 'floor\n')
  hostGit(root, ['add', 'README.md'])
  hostGit(root, ['commit', '-q', '-m', 'init', '--no-verify'])
}

describe('the Windows floor, on a real Windows host', () => {
  floorIt('the broker owns its shell, so the SDK hands it PowerShell text', () => {
    expect(floor().broker.ownsShell).toBe(true)
  })

  floorIt('a command that uses a cmdlet starts in seconds, not half a minute', async () => {
    // Under the per-run LOCALAPPDATA, PowerShell rebuilt its module analysis
    // cache for every cmdlet: 19-41s per command, measured on this runner,
    // which outlasts the harness's 30s default. The floor keeps the user's own
    // cache (`PSModuleAnalysisCachePath`), and this holds it there.
    const f = floor()
    const started = Date.now()
    const out = await f.run('Write-Output fast')
    expect(out.stdout.trim()).toBe('fast')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  floorIt(
    'echo $env:USERPROFILE is the per-run directory, and so is every profile location',
    async () => {
      const f = floor()
      const out = await f.run(
        'echo $env:USERPROFILE; echo $env:HOME; echo $env:APPDATA; echo $env:LOCALAPPDATA; echo $env:TEMP; echo $HOME',
      )
      expect(out.exitCode).toBe(0)
      const lines = out.stdout.trim().split(/\r?\n/)
      expect(lines).toEqual([
        f.home,
        f.home,
        path.join(f.home, 'AppData', 'Roaming'),
        path.join(f.home, 'AppData', 'Local'),
        path.join(f.runtime, 'tmp'),
        f.home,
      ])
      for (const line of lines) {
        expect(line.toLowerCase()).not.toBe(os.homedir().toLowerCase())
      }
    },
  )

  floorIt('credential-bearing variables are gone, names and values both', async () => {
    const f = floor({
      GITHUB_TOKEN: 'gh-floor-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-floor-secret',
      NPM_TOKEN: 'npm-floor-secret',
      OPENAI_API_KEY: 'openai-floor-secret',
    })
    const out = await f.run(
      'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }',
    )
    expect(out.exitCode).toBe(0)
    expect(out.stdout).not.toContain('floor-secret')
    for (const name of [
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NPM_TOKEN',
      'OPENAI_API_KEY',
      'SSH_AUTH_SOCK',
    ]) {
      expect(out.stdout).not.toMatch(new RegExp(`^${name}=`, 'im'))
    }
    expect(out.stdout).toMatch(/^GIT_TERMINAL_PROMPT=0$/im)
    expect(out.stdout).toMatch(/^GCM_INTERACTIVE=never$/im)
  })

  floorIt('git config --global --list is empty: the user global config is not read', async () => {
    const f = floor()
    const out = await f.run('git config --global --list')
    expect(out.stdout.trim()).toBe('')
  })

  floorIt('a commit does not run .git/hooks/pre-commit', async () => {
    const f = floor()
    initRepo(f.root)
    const marker = path.join(f.parent, 'hook-ran')
    // A hook that would both leave a mark and refuse the commit.
    fs.writeFileSync(
      path.join(f.root, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\nexit 1\n`,
    )
    const out = await f.run(
      "Set-Content -Path change.txt -Value 'sponsored'; git add change.txt; git commit -q -m 'sponsored change'; git log -1 --format=%s",
    )
    expect(out.stdout).toContain('sponsored change')
    expect(fs.existsSync(marker)).toBe(false)
  })

  floorIt(
    'git push to a remote that needs credentials fails without prompting, and asks no helper',
    async () => {
      const f = floor()
      initRepo(f.root)
      // A helper configured in the REPOSITORY, which is where a system or
      // global one would also be read from: the run's empty
      // credential.helper must reset the list, so this is never asked.
      const helperMarker = path.join(f.parent, 'helper-asked')
      hostGit(f.root, [
        'config',
        'credential.helper',
        `!f() { echo asked > "${helperMarker.replace(/\\/g, '/')}"; echo username=u; echo password=p; }; f`,
      ])
      const requests: Array<string | null> = []
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          requests.push(request.headers.get('authorization'))
          return new Response('auth required', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="floor"' },
          })
        },
      })
      try {
        hostGit(f.root, [
          'remote',
          'add',
          'origin',
          `http://127.0.0.1:${server.port}/repo.git`,
        ])
        const started = Date.now()
        const out = await f.run('git push origin main', f.root, 45)
        expect(out.exitCode).not.toBe(0)
        // Not a hang behind an invisible prompt: it fails, and fast.
        expect(Date.now() - started).toBeLessThan(30_000)
        expect(requests.length).toBeGreaterThan(0)
        expect(fs.existsSync(helperMarker)).toBe(false)
      } finally {
        server.stop(true)
      }
    },
  )

  floorIt('a command cannot start outside the worktree', async () => {
    const f = floor()
    await expect(f.run('echo hi', f.parent)).rejects.toThrow(
      /only run commands inside its own worktree/,
    )
    await expect(f.run('echo hi', os.homedir())).rejects.toThrow(
      /only run commands inside its own worktree/,
    )
  })

  floorIt('PowerShell carries quotes, non-ASCII and exit codes intact', async () => {
    const f = floor()
    const quoted = await f.run(`Write-Output "a b" 'c "d"' 'héllo ✓'`)
    expect(quoted.stdout.trim().split(/\r?\n/)).toEqual([
      'a b',
      'c "d"',
      'héllo ✓',
    ])
    const failed = await f.run('exit 3')
    expect(failed.exitCode).toBe(3)
  })

  floorIt('code_search runs the bundled ripgrep directly, under the floor', async () => {
    const f = floor()
    fs.writeFileSync(path.join(f.root, 'needle.txt'), 'floor-needle\n')
    const [{ value }] = await codeSearch({
      projectPath: f.root,
      pattern: 'floor-needle',
      processBroker: f.broker,
    })
    expect(JSON.stringify(value)).toContain('needle.txt')
  })

  floorIt('a procedure step that uses npm runs in the worktree', async () => {
    const f = floor()
    fs.writeFileSync(
      path.join(f.root, 'package.json'),
      JSON.stringify({ name: 'floor-fixture', version: '1.0.0' }),
    )
    const out = await f.run('npm pkg get name')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('floor-fixture')
  })
})
