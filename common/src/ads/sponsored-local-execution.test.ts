import { describe, expect, it, test } from 'bun:test'

import {
  SPONSORED_LOCAL_BRANCH_NAMESPACE,
  SPONSORED_LOCAL_ENV_ALLOWLIST,
  SPONSORED_LOCAL_FLOOR_GRANT,
  SPONSORED_LOCAL_UNAVAILABLE_COPY,
  SPONSORED_LOCAL_UNCONTAINED_GRANT,
  SPONSORED_LOCAL_V1_GRANT,
  SPONSORED_WINDOWS_ENV_ALLOWLIST,
  commandInstallsDependencies,
  evaluateSponsoredLocalToolCall,
  looksLikeCredentialEnvVar,
  scrubSponsoredLocalEnv,
  scrubSponsoredWindowsEnv,
  sponsoredComputeGrantNamesFloor,
  sponsoredLocalAvailability,
  sponsoredLocalBranchName,
  sponsoredLocalContainment,
  sponsoredLocalContainmentIsFloor,
  sponsoredLocalContainmentMatchesGrant,
  sponsoredLocalGrant,
  sponsoredLocalGrantName,
  sponsoredLocalSlug,
  sponsoredLocalToolNames,
  sponsoredLocalUnavailableReason,
} from './sponsored-local-execution'

describe('the local grant is its own constant (COD-336 acceptance 2)', () => {
  it('grants the shell only where something can contain it', () => {
    const contained = sponsoredLocalGrant(sponsoredLocalContainment('darwin'))
    expect(contained.has('run_commands')).toBe(true)
    expect(contained).toBe(SPONSORED_LOCAL_V1_GRANT)

    // COD-642: Windows is the FLOOR arm now, not a refusal -- but the floor
    // alone still earns no shell. Only a server grant naming the floor does
    // (see "the Windows floor" below), so a Windows run with any other grant
    // keeps exactly the uncontained grant this test always pinned.
    const windows = sponsoredLocalGrant(sponsoredLocalContainment('win32'))
    expect(windows.has('run_commands')).toBe(false)
    expect(windows).toBe(SPONSORED_LOCAL_UNCONTAINED_GRANT)
    // Denying the shell must not quietly deny the write tools with it: they
    // are the whole reason the uncontained grant exists rather than being an
    // empty set.
    expect(windows.has('write_workspace')).toBe(true)
    expect(windows.has('read_workspace')).toBe(true)
  })

  it('refuses the two capabilities local execution does not change the case for', () => {
    for (const grant of [
      SPONSORED_LOCAL_V1_GRANT,
      SPONSORED_LOCAL_UNCONTAINED_GRANT,
    ]) {
      expect(grant.has('human_in_loop')).toBe(false)
      expect(grant.has('delegate')).toBe(false)
    }
    expect(evaluateSponsoredLocalToolCall('ask_user').allowed).toBe(false)
    expect(evaluateSponsoredLocalToolCall('spawn_agents').allowed).toBe(false)
  })

  it('refuses a tool it has never heard of rather than passing it through', () => {
    const decision = evaluateSponsoredLocalToolCall('some_mcp_tool')
    expect(decision.allowed).toBe(false)
    expect(decision.allowed === false && decision.code).toBe('unknown_tool')
    // The prototype names a model can produce, all of which used to be truthy
    // under a direct index.
    for (const name of ['__proto__', 'toString', 'constructor']) {
      const answer = evaluateSponsoredLocalToolCall(name)
      expect(answer.allowed === false && answer.code).toBe('unknown_tool')
    }
  })

  it('narrows a host toolset without inventing tools the host lacks', () => {
    const host = ['read_files', 'run_terminal_command', 'ask_user', 'write_file']
    expect(sponsoredLocalToolNames(host)).toEqual([
      'read_files',
      'run_terminal_command',
      'write_file',
    ])
    expect(
      sponsoredLocalToolNames(host, SPONSORED_LOCAL_UNCONTAINED_GRANT),
    ).toEqual(['read_files', 'write_file'])
    expect(sponsoredLocalToolNames(['read_files'])).not.toContain('code_search')
  })
})

describe('containment availability, as the card reads it', () => {
  it('renders a reason a surface can show', () => {
    expect(sponsoredLocalAvailability(sponsoredLocalContainment('darwin'))).toBe(
      'available',
    )
    // COD-642: Windows is the floor arm. A surface that has not declared it
    // offers the floor (the CLI) still reads it as the refusal it always was;
    // Freebuff Desktop, which carries the floor broker and its consent, says so.
    expect(sponsoredLocalAvailability(sponsoredLocalContainment('win32'))).toBe(
      'unavailable:windows-no-containment',
    )
    expect(
      sponsoredLocalAvailability(sponsoredLocalContainment('win32'), {
        offersFloor: true,
      }),
    ).toBe('available')
    expect(
      sponsoredLocalAvailability(
        sponsoredLocalContainment('linux', { bwrapAvailable: false }),
      ),
    ).toBe('unavailable:bubblewrap-missing')
  })

  it('never blames the operating system for a missing consent bridge', () => {
    // `no-consent-bridge` is reached most often on a perfectly supported Mac
    // -- `dev:web`, a bare orchestrator, the ui-shots harness -- and it used
    // to share `unsupported-platform`'s sentence, which told that user their
    // OS could not run sponsored tasks. It can; nobody was there to ask them.
    expect(sponsoredLocalUnavailableReason('unavailable:no-consent-bridge')).toBe(
      'no-consent-bridge',
    )
    const consent = SPONSORED_LOCAL_UNAVAILABLE_COPY['no-consent-bridge']
    expect(consent).not.toBe(
      SPONSORED_LOCAL_UNAVAILABLE_COPY['unsupported-platform'],
    )
    expect(consent).not.toContain('operating system')
    // Fixable, and the sentence has to say how -- the same property the
    // bubblewrap line has and the two permanent ones do not.
    expect(consent).toContain('app')
    // `sponsoredLocalContainment` answers about CONTAINMENT only. It must
    // never produce this reason: the caller that has no bridge is the only
    // thing that knows.
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      const containment = sponsoredLocalContainment(platform)
      if ('reason' in containment) {
        expect(containment.reason).not.toBe('no-consent-bridge')
      }
    }
  })

  it('parses its own answer back, and refuses one it did not write', () => {
    expect(sponsoredLocalUnavailableReason('available')).toBeNull()
    expect(sponsoredLocalUnavailableReason('unavailable:windows-no-containment')).toBe(
      'windows-no-containment',
    )
    expect(sponsoredLocalUnavailableReason('unavailable:made-up')).toBeNull()
  })
})

describe('the Windows floor (COD-642)', () => {
  const FLOOR_GRANT = {
    executionSurface: 'desktop_windows',
    containment: 'floor',
  } as const

  it('is its own arm, and never claims to be available the way a sandbox is', () => {
    const floor = sponsoredLocalContainment('win32')
    expect(floor).toEqual({ containment: 'floor' })
    expect(sponsoredLocalContainmentIsFloor(floor)).toBe(true)
    // No `available` at all: a reader that only knows `available` refuses it
    // rather than mistaking it for a sandbox.
    expect('available' in floor).toBe(false)
    for (const platform of ['darwin', 'freebsd'] as const) {
      expect(
        sponsoredLocalContainmentIsFloor(sponsoredLocalContainment(platform)),
      ).toBe(false)
    }
  })

  it('is never what Linux without bubblewrap becomes', () => {
    const linux = sponsoredLocalContainment('linux', { bwrapAvailable: false })
    expect(linux).toEqual({ available: false, reason: 'bubblewrap-missing' })
    expect(sponsoredLocalContainmentIsFloor(linux)).toBe(false)
    expect(sponsoredLocalAvailability(linux, { offersFloor: true })).toBe(
      'unavailable:bubblewrap-missing',
    )
    // Not even a server grant naming the floor gives it a shell.
    expect(sponsoredLocalGrant(linux, FLOOR_GRANT)).toBe(
      SPONSORED_LOCAL_UNCONTAINED_GRANT,
    )
  })

  it('has its own named full grant, handed out only with a floor grant from the server', () => {
    expect([...SPONSORED_LOCAL_FLOOR_GRANT].sort()).toEqual(
      [
        'agent_control',
        'network',
        'read_workspace',
        'run_commands',
        'write_workspace',
      ].sort(),
    )
    // Same members as the contained grant today, and a different constant: a
    // log naming the grant can always tell a floor run from a sandboxed one.
    expect(SPONSORED_LOCAL_FLOOR_GRANT).not.toBe(SPONSORED_LOCAL_V1_GRANT)
    expect(SPONSORED_LOCAL_FLOOR_GRANT.has('human_in_loop')).toBe(false)
    expect(SPONSORED_LOCAL_FLOOR_GRANT.has('delegate')).toBe(false)

    const floor = sponsoredLocalContainment('win32')
    expect(sponsoredLocalGrant(floor, FLOOR_GRANT)).toBe(
      SPONSORED_LOCAL_FLOOR_GRANT,
    )
    expect(
      sponsoredLocalGrantName(sponsoredLocalGrant(floor, FLOOR_GRANT)),
    ).toBe('floor')
    // Half a floor grant is no floor grant.
    for (const grant of [
      null,
      {},
      { executionSurface: 'desktop_windows' },
      { containment: 'floor' },
      { executionSurface: 'desktop_macos', containment: 'floor' },
    ]) {
      expect(sponsoredComputeGrantNamesFloor(grant)).toBe(false)
      expect(sponsoredLocalGrant(floor, grant)).toBe(
        SPONSORED_LOCAL_UNCONTAINED_GRANT,
      )
    }
    // A sandbox keeps its own grant whatever the server grant says.
    expect(
      sponsoredLocalGrant(sponsoredLocalContainment('darwin'), FLOOR_GRANT),
    ).toBe(SPONSORED_LOCAL_V1_GRANT)
    expect(
      sponsoredLocalGrantName(
        sponsoredLocalGrant(sponsoredLocalContainment('darwin')),
      ),
    ).toBe('contained')
  })

  it('refuses a machine and a grant that describe different runs', () => {
    const floor = sponsoredLocalContainment('win32')
    const mac = sponsoredLocalContainment('darwin')
    expect(sponsoredLocalContainmentMatchesGrant(floor, FLOOR_GRANT)).toBe(true)
    expect(sponsoredLocalContainmentMatchesGrant(mac, {})).toBe(true)
    // A Windows machine holding a grant minted for a sandbox, and a Mac
    // holding one minted for the floor, are both a run nobody approved.
    expect(sponsoredLocalContainmentMatchesGrant(floor, {})).toBe(false)
    expect(sponsoredLocalContainmentMatchesGrant(mac, FLOOR_GRANT)).toBe(false)
  })
})

describe('the environment a Windows floor run gets', () => {
  const RUN = 'C:\\Users\\u\\proj\\.freebuff\\sponsored-runtime\\run'
  const PATHS = {
    home: `${RUN}\\home`,
    tmp: `${RUN}\\tmp`,
    appData: `${RUN}\\home\\AppData\\Roaming`,
    localAppData: `${RUN}\\home\\AppData\\Local`,
  }
  const USER_ENV = {
    // Windows spells it `Path`; the allowlist must still carry it.
    Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\u',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\u',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    GITHUB_TOKEN: 'gh-token-value',
    GH_TOKEN: 'gh-token-value',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
    NPM_TOKEN: 'npm-token-value',
    OPENAI_API_KEY: 'sk-value',
    DATABASE_URL: 'postgresql://production',
    SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent',
    GIT_ASKPASS: 'C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe',
    PSModulePath: 'C:\\Users\\u\\Documents\\WindowsPowerShell\\Modules',
    MSYS: 'disable_pcon',
  }

  it('points every per-user location at the run, not at the user', () => {
    const env = scrubSponsoredWindowsEnv(USER_ENV, PATHS)
    expect(env.USERPROFILE).toBe(PATHS.home)
    expect(env.HOME).toBe(PATHS.home)
    expect(env.HOMEDRIVE).toBe('C:')
    expect(env.HOMEPATH).toBe(PATHS.home.slice(2))
    expect(env.APPDATA).toBe(PATHS.appData)
    expect(env.LOCALAPPDATA).toBe(PATHS.localAppData)
    expect(env.TEMP).toBe(PATHS.tmp)
    expect(env.TMP).toBe(PATHS.tmp)
    // One named exception: PowerShell's module analysis cache (an index of
    // module commands) stays the user's own. See the next test.
    for (const [key, value] of Object.entries(env)) {
      if (key === 'PSModuleAnalysisCachePath') continue
      expect(value.startsWith('C:\\Users\\u\\AppData')).toBe(false)
      expect(value).not.toBe('C:\\Users\\u')
    }
  })

  it('spells HOMEDRIVE and HOMEPATH for a project on a network share too', () => {
    // Left unset, the process-spawning layer would put the user's own pair
    // back, and PowerShell 5.1's `$HOME` would be the real home.
    const share = '\\\\nas\\projects\\app\\.freebuff\\sponsored-runtime\\run\\home'
    const env = scrubSponsoredWindowsEnv(USER_ENV, { ...PATHS, home: share })
    expect(env.HOMEDRIVE).toBe('\\\\nas\\projects')
    expect(env.HOMEPATH).toBe('\\app\\.freebuff\\sponsored-runtime\\run\\home')
    expect(`${env.HOMEDRIVE}${env.HOMEPATH}`).toBe(share)
  })

  it('lets the LAST spelling of a name win, as a spread environment does', () => {
    const env = scrubSponsoredWindowsEnv(
      { Path: 'C:\\first', PATH: 'C:\\second' },
      PATHS,
    )
    expect(env.PATH).toBe('C:\\second')
    // An empty later spelling removes the name, as it would in the child.
    expect(
      scrubSponsoredWindowsEnv({ Path: 'C:\\first', PATH: '' }, PATHS).PATH,
    ).toBeUndefined()
  })

  it('never lets a bare command resolve from the repository', () => {
    expect(
      scrubSponsoredWindowsEnv(USER_ENV, PATHS)
        .NoDefaultCurrentDirectoryInExePath,
    ).toBe('1')
  })

  it('keeps PowerShell on the user own module analysis cache', () => {
    // Under the per-run LOCALAPPDATA every cmdlet would rebuild the cache from
    // nothing: measured 19-41s per command on a Windows runner.
    expect(scrubSponsoredWindowsEnv(USER_ENV, PATHS).PSModuleAnalysisCachePath).toBe(
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\Windows\\PowerShell\\ModuleAnalysisCache',
    )
    expect(
      scrubSponsoredWindowsEnv(
        { ...USER_ENV, PSModuleAnalysisCachePath: 'D:\\cache\\ModuleAnalysisCache' },
        PATHS,
      ).PSModuleAnalysisCachePath,
    ).toBe('D:\\cache\\ModuleAnalysisCache')
    const { LOCALAPPDATA: _local, ...withoutLocal } = USER_ENV
    expect(
      scrubSponsoredWindowsEnv(withoutLocal, PATHS).PSModuleAnalysisCachePath,
    ).toBeUndefined()
  })

  it('carries no credential and nothing off the allowlist', () => {
    const env = scrubSponsoredWindowsEnv(USER_ENV, PATHS)
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NPM_TOKEN',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'SSH_AUTH_SOCK',
      'PSModulePath',
      'MSYS',
    ]) {
      expect(env[key]).toBeUndefined()
    }
    for (const value of Object.values(env)) {
      expect(value).not.toContain('token-value')
      expect(value).not.toContain('secret-value')
    }
    // Kept, under the allowlist's own spelling, whatever case the user had.
    expect(env.PATH).toBe(USER_ENV.Path)
    expect(env.Path).toBeUndefined()
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.PATHEXT).toBe(USER_ENV.PATHEXT)
    for (const key of SPONSORED_WINDOWS_ENV_ALLOWLIST) {
      expect(looksLikeCredentialEnvVar(key)).toBe(false)
    }
  })

  it('makes the run non-interactive, hook-free and helper-free for git', () => {
    const env = scrubSponsoredWindowsEnv(USER_ENV, PATHS)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    // The user's own askpass helper is replaced, not inherited.
    expect(env.GIT_ASKPASS).toBe('echo')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes')
    expect(env.GIT_SSH_COMMAND).toContain('IdentityAgent=none')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(env.GIT_CONFIG_VALUE_0).toBe(`${PATHS.home}\\no-hooks`)
    // An EMPTY helper resets the helper list, so Git for Windows' system-wide
    // credential manager is never asked for the user's stored credential.
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_1).toBe('')
  })

  it('leaves the macOS/Linux environment exactly as it was', () => {
    const posix = scrubSponsoredLocalEnv(
      { PATH: '/usr/bin' },
      { home: '/run/home', tmp: '/run/tmp' },
    )
    expect(posix.GIT_CONFIG_COUNT).toBe('1')
    expect(posix.GCM_INTERACTIVE).toBeUndefined()
    expect(posix.APPDATA).toBeUndefined()
    expect(posix.GIT_SSH_COMMAND).toBeUndefined()
  })
})

describe('the environment a local run gets', () => {
  it('is an allowlist, so an unforeseen variable is absent by default', () => {
    const env = scrubSponsoredLocalEnv(
      {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        SOME_FUTURE_VENDOR_CREDENTIAL: 'value',
        HOME: '/Users/owen',
      },
      { home: '/run/home', tmp: '/run/tmp' },
    )
    expect(Object.keys(env).sort()).toEqual(
      [
        'GIT_ASKPASS',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'LANG',
        'PATH',
        'TEMP',
        'TMP',
        'TMPDIR',
        'USERPROFILE',
      ].sort(),
    )
    expect(env.HOME).toBe('/run/home')
  })

  it('disables git hooks in both directions, by config rather than by asking', () => {
    const env = scrubSponsoredLocalEnv(
      { PATH: '/usr/bin' },
      { home: '/run/home', tmp: '/run/tmp' },
    )
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    // Under the run's own HOME, and a directory nothing creates: git finding
    // no hooks directory is the outcome, on every git invocation the run
    // makes rather than only the ones that remembered `--no-verify`.
    expect(env.GIT_CONFIG_VALUE_0).toBe('/run/home/no-hooks')
  })

  it('never lets a credential-shaped name onto the allowlist', () => {
    for (const key of SPONSORED_LOCAL_ENV_ALLOWLIST) {
      expect(looksLikeCredentialEnvVar(key)).toBe(false)
    }
    expect(looksLikeCredentialEnvVar('GITHUB_TOKEN')).toBe(true)
    expect(looksLikeCredentialEnvVar('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(looksLikeCredentialEnvVar('NPM_CONFIG_REGISTRY')).toBe(true)
    expect(looksLikeCredentialEnvVar('OPENAI_API_KEY')).toBe(true)
  })
})

describe('no dependency installs in v1', () => {
  it('recognises the ordinary spellings, including inside a chain', () => {
    for (const command of [
      'npm install left-pad',
      'bun add @acme/sdk',
      'pnpm i',
      'yarn add --dev vitest',
      'pip3 install requests',
      'cargo add serde',
      'cd packages/web && npm ci',
      'brew install jq',
    ]) {
      expect(commandInstallsDependencies(command)).toBe(true)
    }
  })

  it('does not refuse the commands a run legitimately needs', () => {
    for (const command of [
      'npm test',
      'bun run typecheck',
      'git add -A',
      'ls node_modules',
      'echo "install"',
      'grep -r install src',
    ]) {
      expect(commandInstallsDependencies(command)).toBe(false)
    }
  })
})

/**
 * The branch a local sponsored run commits to (COD-339).
 *
 * Shared because two surfaces cut these branches and one sandbox grants them:
 * `sponsoredLinkedWorktreeGrants` writes `refs/heads/<namespace>` and
 * `logs/refs/heads/<namespace>` into the sandbox profile and nothing else under
 * `refs/`, so a run whose branch lived outside the namespace could not commit at
 * all — and a namespace widened to `refs` would let one rewrite every branch in
 * the user's repository.
 */
describe('the sponsored branch namespace', () => {
  test('has no trailing slash, because the grant is built by joining onto it', () => {
    expect(SPONSORED_LOCAL_BRANCH_NAMESPACE).toBe('freebuff')
    expect(SPONSORED_LOCAL_BRANCH_NAMESPACE).not.toContain('/')
  })

  test('every branch it builds lives inside that namespace', () => {
    for (const title of ['Sponsored: Acme Deploys', '', '  ---  ', 'ñ']) {
      const branch = sponsoredLocalBranchName(title, 'run-1')
      expect(branch.startsWith(`${SPONSORED_LOCAL_BRANCH_NAMESPACE}/`), title).toBe(
        true,
      )
      expect(branch.endsWith('-run-1'), title).toBe(true)
    }
  })

  test('the slug is ref-legal, capped, and never empty', () => {
    // Never empty is the one that matters: `freebuff/-run-1` is a legal ref and
    // an unreadable one, and a title of pure punctuation is a real advertiser
    // name away.
    expect(sponsoredLocalSlug('Sponsored: Acme Deploys')).toBe(
      'sponsored-acme-deploys',
    )
    expect(sponsoredLocalSlug('   ---   ')).toBe('task')
    expect(sponsoredLocalSlug('')).toBe('task')
    expect(sponsoredLocalSlug('x'.repeat(120)).length).toBe(50)
    expect(sponsoredLocalSlug('日本語')).toBe('task')
    expect(sponsoredLocalSlug('A b/c')).toBe('a-b-c')
  })
})
