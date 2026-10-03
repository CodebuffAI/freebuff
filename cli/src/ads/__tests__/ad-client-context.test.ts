import { describe, expect, test } from 'bun:test'

import { parseAdClientContext } from '@codebuff/common/types/ad-client-context'

import {
  buildCliAdClientContext,
  createLazyAsyncValue,
  detectStaticTermFacts,
  installMethodOf,
  localeLanguagesOf,
  median,
  osMajorOf,
  releaseChannelOf,
  type AdTermEnv,
  type AdTermHost,
  type CliAdContextSources,
} from '../ad-client-context'

const macHost: AdTermHost = {
  platform: 'darwin',
  release: '25.0.0',
  fileExists: () => false,
}
const linuxHost: AdTermHost = {
  platform: 'linux',
  release: '6.8.0-45-generic',
  fileExists: () => false,
}

const facts = (env: AdTermEnv, host: AdTermHost = macHost) =>
  detectStaticTermFacts(env, host)

describe('static terminal facts', () => {
  test('Ghostty, no multiplexer, local', () => {
    expect(
      facts({
        TERM_PROGRAM: 'ghostty',
        TERM: 'xterm-ghostty',
        COLORTERM: 'truecolor',
        SHELL: '/bin/zsh',
      }),
    ).toEqual({
      terminal: 'ghostty',
      links: true,
      multiplexer: 'none',
      remote: 'none',
      colors: 'truecolor',
      images: 'none',
      shell: 'zsh',
      proxy: false,
    })
  })

  test('iTerm2 renders links and inline images', () => {
    expect(
      facts({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }),
    ).toMatchObject({
      terminal: 'iterm',
      links: true,
      colors: 'truecolor',
      images: 'iterm2',
    })
  })

  test('Apple Terminal: no OSC 8 links, 256 colours', () => {
    expect(
      facts({
        TERM_PROGRAM: 'Apple_Terminal',
        TERM: 'xterm-256color',
        SHELL: '/bin/bash',
      }),
    ).toMatchObject({
      terminal: 'apple_terminal',
      links: false,
      colors: '256',
      shell: 'bash',
    })
  })

  test('tmux: the outer emulator is found from its own markers, links and images off', () => {
    const result = facts({
      TERM_PROGRAM: 'tmux',
      TERM: 'tmux-256color',
      TMUX: '/private/tmp/tmux-501/default,123,0',
      GHOSTTY_RESOURCES_DIR:
        '/Applications/Ghostty.app/Contents/Resources/ghostty',
      SHELL: '/opt/homebrew/bin/fish',
    })
    expect(result).toMatchObject({
      terminal: 'ghostty',
      multiplexer: 'tmux',
      links: false,
      images: 'none',
      colors: '256',
      shell: 'fish',
    })
  })

  test('tmux inside iTerm2 keeps iTerm2 but drops its images', () => {
    expect(
      facts({
        TERM_PROGRAM: 'tmux',
        TMUX: 'x',
        LC_TERMINAL: 'iTerm2',
        TERM: 'screen-256color',
      }),
    ).toMatchObject({
      terminal: 'iterm',
      multiplexer: 'tmux',
      images: 'none',
      links: false,
    })
  })

  test('tmux with nothing to identify the emulator', () => {
    expect(
      facts({ TERM_PROGRAM: 'tmux', TMUX: 'x', TERM: 'screen' }),
    ).toMatchObject({
      terminal: 'other',
      multiplexer: 'tmux',
      links: false,
      colors: '16',
    })
  })

  test('screen and zellij', () => {
    expect(facts({ STY: '1234.pts-0', TERM: 'screen' })).toMatchObject({
      multiplexer: 'screen',
      links: false,
    })
    const zellij = facts({ ZELLIJ: '0', TERM_PROGRAM: 'WezTerm' })
    expect(zellij).toMatchObject({ multiplexer: 'zellij', terminal: 'wezterm' })
    expect(zellij.links).toBeUndefined()
  })

  test('ssh into a Linux box', () => {
    expect(
      facts(
        {
          SSH_CONNECTION: '10.0.0.2 51234 10.0.0.3 22',
          SSH_TTY: '/dev/pts/0',
          TERM: 'xterm-256color',
          SHELL: '/usr/bin/bash',
        },
        linuxHost,
      ),
    ).toMatchObject({
      remote: 'ssh',
      terminal: 'other',
      colors: '256',
      shell: 'bash',
    })
  })

  test('VS Code integrated terminal', () => {
    expect(
      facts({
        TERM_PROGRAM: 'vscode',
        VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git.sock',
      }),
    ).toMatchObject({ terminal: 'vscode', links: true, colors: 'truecolor' })
  })

  test('Cursor reports TERM_PROGRAM=vscode and is told apart', () => {
    expect(
      facts({ TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'abc' }),
    ).toMatchObject({
      terminal: 'cursor',
      links: true,
    })
  })

  test('JetBrains and Windows Terminal', () => {
    expect(facts({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' }).terminal).toBe(
      'jetbrains',
    )
    expect(
      facts({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' }).links,
    ).toBeUndefined()
    expect(
      facts({
        WT_SESSION: 'guid',
        SHELL: 'C:\\Program Files\\PowerShell\\pwsh.exe',
      }),
    ).toMatchObject({
      terminal: 'windows_terminal',
      links: true,
      shell: 'pwsh',
    })
  })

  test('kitty speaks its own image protocol', () => {
    expect(facts({ TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' })).toMatchObject({
      terminal: 'kitty',
      images: 'kitty',
      colors: 'truecolor',
    })
  })

  test('WSL from its env vars or the kernel release', () => {
    expect(
      facts({ WSL_DISTRO_NAME: 'Ubuntu', WT_SESSION: 'x' }, linuxHost),
    ).toMatchObject({
      remote: 'wsl',
      terminal: 'windows_terminal',
    })
    expect(
      facts({}, { ...linuxHost, release: '5.15.153.1-microsoft-standard-WSL2' })
        .remote,
    ).toBe('wsl')
  })

  test('containers: docker, podman and dev containers', () => {
    expect(
      facts({}, { ...linuxHost, fileExists: (path) => path === '/.dockerenv' })
        .remote,
    ).toBe('container')
    expect(
      facts(
        {},
        { ...linuxHost, fileExists: (path) => path === '/run/.containerenv' },
      ).remote,
    ).toBe('container')
    expect(facts({ container: 'podman' }, linuxHost).remote).toBe('container')
    expect(facts({ REMOTE_CONTAINERS: 'true' }, linuxHost).remote).toBe(
      'container',
    )
  })

  test('the most specific remote wins', () => {
    const inContainer = { ...linuxHost, fileExists: () => true }
    expect(
      facts({ CODESPACES: 'true', SSH_CONNECTION: 'x' }, inContainer).remote,
    ).toBe('codespaces')
    expect(facts({ GITPOD_WORKSPACE_ID: 'ws' }, inContainer).remote).toBe(
      'gitpod',
    )
    expect(facts({ SSH_CLIENT: 'x' }, inContainer).remote).toBe('ssh')
  })

  test('nothing known: no colours or shell rather than a guess', () => {
    const result = facts({})
    expect(result).toEqual({
      terminal: 'other',
      multiplexer: 'none',
      remote: 'none',
      images: 'none',
      proxy: false,
    })
  })

  test('an unrecognised shell is `other`; a dumb TERM has no depth', () => {
    expect(facts({ SHELL: '/bin/tcsh', TERM: 'dumb' })).toMatchObject({
      shell: 'other',
    })
    expect(facts({ TERM: 'dumb' }).colors).toBeUndefined()
  })
})

describe('osMajorOf and median', () => {
  test('maps Darwin to the macOS a user would name', () => {
    expect(osMajorOf('darwin', '25.1.0')).toBe('26')
    expect(osMajorOf('darwin', '24.6.0')).toBe('15')
    expect(osMajorOf('darwin', '19.6.0')).toBe('10')
    expect(osMajorOf('linux', '6.8.0-45-generic')).toBe('6')
    expect(osMajorOf('win32', '10.0.22631')).toBe('10')
    expect(osMajorOf('linux', 'weird')).toBeUndefined()
  })

  test('median', () => {
    expect(median([])).toBeUndefined()
    expect(median([300, 100, 200])).toBe(200)
    expect(median([100, 200, 300, 400])).toBe(250)
  })
})

const NOW = 10_000_000

function sources(
  overrides: Partial<CliAdContextSources> = {},
): CliAdContextSources {
  return {
    now: () => NOW,
    term: () => ({
      terminal: 'ghostty',
      links: true,
      multiplexer: 'none',
      remote: 'none',
      colors: 'truecolor',
      images: 'none',
      shell: 'zsh',
    }),
    cols: () => 132,
    mouse: () => true,
    focused: () => undefined,
    idleMs: () => 2_500,
    turnRunning: () => true,
    turnStartedAt: () => NOW - 45_000,
    scrolledUp: () => false,
    pendingPrompt: () => false,
    userTurnCount: () => 7,
    session: () => ({
      adsServed: 5,
      lastAdAt: NOW - 61_000,
      lastClickAt: null,
      lastSendAt: NOW - 45_000,
      rttSamplesMs: [80, 120, 600],
    }),
    agent: () => ({
      mode: 'LITE',
      model: 'deepseek/deepseek-v4-flash',
      harness: 'base3-free-deepseek-v4-flash',
      effort: 'default',
    }),
    system: () => ({
      platform: 'darwin',
      release: '25.0.0',
      arch: 'arm64',
      totalmem: 36 * 1024 ** 3,
    }),
    ...overrides,
  }
}

describe('buildCliAdClientContext', () => {
  test('buckets every field and parses', () => {
    const context = buildCliAdClientContext(sources())
    expect(context).toEqual({
      v: 1,
      term: {
        terminal: 'ghostty',
        links: true,
        multiplexer: 'none',
        remote: 'none',
        colors: 'truecolor',
        images: 'none',
        shell: 'zsh',
        cols: '120-159',
        mouse: true,
      },
      attn: {
        sinceInput: '1-5s',
        sinceSend: '30s-2m',
        turnRunning: true,
        turnElapsed: '30s-2m',
        pendingPrompt: false,
        scrolledUp: false,
      },
      sess: {
        turnIndex: '6-20',
        adsThisSession: '4-10',
        sinceLastAd: '30s-2m',
        sinceLastClick: 'never',
      },
      agent: {
        mode: 'LITE',
        model: 'deepseek/deepseek-v4-flash',
        harness: 'base3-free-deepseek-v4-flash',
        effort: 'default',
      },
      sys: { osMajor: '26', arch: 'arm64', ram: '32+' },
      net: { rtt: '50-150', jitter: '150+' },
    })
    expect(parseAdClientContext(context)).toEqual(context!)
  })

  test('focus rides only when the terminal reported it', () => {
    expect(
      buildCliAdClientContext(sources({ focused: () => false }))!.term!.focused,
    ).toBe(false)
    expect(buildCliAdClientContext(sources())!.term!.focused).toBeUndefined()
  })

  test('an idle turn has no elapsed time, and an unknown start has none either', () => {
    const idle = buildCliAdClientContext(sources({ turnRunning: () => false }))!
    expect(idle.attn).toMatchObject({ turnRunning: false })
    expect(idle.attn!.turnElapsed).toBeUndefined()
    const unknownStart = buildCliAdClientContext(
      sources({ turnStartedAt: () => null }),
    )!
    expect(unknownStart.attn!.turnElapsed).toBeUndefined()
  })

  test('no user turn yet leaves turnIndex unknown; nothing sent is `never`', () => {
    const fresh = buildCliAdClientContext(
      sources({
        userTurnCount: () => 0,
        session: () => ({
          adsServed: 0,
          lastAdAt: null,
          lastClickAt: null,
          lastSendAt: null,
          rttSamplesMs: [],
        }),
      }),
    )!
    expect(fresh.sess).toEqual({
      adsThisSession: '0',
      sinceLastAd: 'never',
      sinceLastClick: 'never',
    })
    expect(fresh.attn!.sinceSend).toBe('never')
    expect(fresh.net).toBeUndefined()
  })

  test('column buckets', () => {
    const cols = (n: number) =>
      buildCliAdClientContext(sources({ cols: () => n }))!.term!.cols
    expect(cols(79)).toBe('<80')
    expect(cols(80)).toBe('80-119')
    expect(cols(160)).toBe('160+')
    expect(cols(0)).toBeUndefined()
  })

  test('a throwing source costs only its own fields', () => {
    const boom = () => {
      throw new Error('boom')
    }
    const context = buildCliAdClientContext(
      sources({ term: boom, session: boom, agent: boom, system: boom }),
    )!
    expect(context.term).toEqual({ cols: '120-159', mouse: true })
    expect(context.sess).toEqual({ turnIndex: '6-20' })
    expect(context.attn!.sinceSend).toBeUndefined()
    expect(context.agent).toBeUndefined()
    expect(context.sys).toBeUndefined()
    expect(context.net).toBeUndefined()
  })

  test('an over-long or empty agent label is trimmed or dropped', () => {
    const context = buildCliAdClientContext(
      sources({
        agent: () => ({
          mode: 'DEFAULT',
          model: 'x'.repeat(100),
          effort: '  ',
        }),
      }),
    )!
    expect(context.agent).toEqual({ mode: 'DEFAULT', model: 'x'.repeat(64) })
  })

  test('a broken clock is no context, never a throw', () => {
    expect(
      buildCliAdClientContext(
        sources({
          now: () => {
            throw new Error('clock')
          },
        }),
      ),
    ).toBeUndefined()
  })

  test('no sources at all is a bare, valid context', () => {
    expect(buildCliAdClientContext({ now: () => NOW })).toEqual({ v: 1 })
  })
})

// ------------------------------------------------------------------ wave 2

describe('wave 2: terminal locale and proxy', () => {
  test('utf8 from the locale, proxy from presence only', () => {
    const result = facts({
      TERM_PROGRAM: 'ghostty',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://alice:hunter2@corp-proxy.internal:8080',
    })
    expect(result).toMatchObject({ utf8: true, proxy: true })
    expect(JSON.stringify(result)).not.toContain('corp-proxy')
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  test('lower-case proxy variables count; no locale is unknown utf8', () => {
    const result = facts({ all_proxy: 'socks5://127.0.0.1:1080' })
    expect(result.proxy).toBe(true)
    expect(result.utf8).toBeUndefined()
    expect(facts({ LC_ALL: 'C' }).utf8).toBe(false)
    expect(facts({ HTTP_PROXY: '' }).proxy).toBe(false)
  })

  test('shell rides through the shared shellOf', () => {
    expect(facts({ SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }).shell).toBe(
      'pwsh',
    )
    expect(facts({ SHELL: '/opt/homebrew/bin/fish' }).shell).toBe('fish')
  })
})

describe('wave 2: pure derivations', () => {
  test('localeLanguagesOf keeps only the ISO 639 code', () => {
    expect(localeLanguagesOf({ LANG: 'de_DE.UTF-8' })).toEqual({
      language: 'de',
      languageCount: 1,
    })
    expect(
      localeLanguagesOf({ LANGUAGE: 'pt_BR:pt:en_US', LANG: 'fr_FR.UTF-8' }),
    ).toEqual({ language: 'pt', languageCount: 2 })
    expect(localeLanguagesOf({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US' })).toEqual(
      { language: 'ja', languageCount: 1 },
    )
    expect(localeLanguagesOf({ LANG: 'C.UTF-8' })).toEqual({})
    expect(localeLanguagesOf({ LANG: 'POSIX' })).toEqual({})
    expect(localeLanguagesOf({})).toEqual({})
  })

  test('releaseChannelOf maps the build environment', () => {
    expect(releaseChannelOf('prod')).toBe('stable')
    expect(releaseChannelOf('dev')).toBe('dev')
    expect(releaseChannelOf('test')).toBe('other')
    expect(releaseChannelOf(undefined)).toBe('other')
  })

  test('installMethodOf: the launching package manager wins', () => {
    const binary = { isBinary: true }
    expect(
      installMethodOf(
        { npm_config_user_agent: 'npm/10.8.2 node/v22.9.0 darwin arm64', npm_command: 'exec' },
        binary,
      ),
    ).toBe('npx')
    expect(
      installMethodOf({ npm_config_user_agent: 'npm/10.8.2 node/v22' }, binary),
    ).toBe('npm')
    expect(installMethodOf({ npm_config_user_agent: 'bun/1.3.2' }, binary)).toBe(
      'bun',
    )
    expect(
      installMethodOf({ npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v20' }, binary),
    ).toBe('pnpm')
    expect(installMethodOf({ npm_config_user_agent: 'yarn/1.22.19' }, binary)).toBe(
      'yarn',
    )
  })

  test('installMethodOf: the npm wrapper, then a bare binary', () => {
    const launched = (invoked: string) =>
      installMethodOf(
        { CODEBUFF_LAUNCHER_PID: '123', _: invoked },
        { isBinary: true },
      )
    expect(launched('/Users/a/.bun/bin/freebuff')).toBe('bun')
    expect(launched('/Users/a/Library/pnpm/freebuff')).toBe('pnpm')
    expect(launched('/Users/a/.nvm/versions/node/v22/bin/freebuff')).toBe('npm')
    expect(launched('/opt/homebrew/Cellar/freebuff/1.0/bin/freebuff')).toBe('brew')
    expect(launched('/somewhere/else/freebuff')).toBe('other')
    expect(installMethodOf({}, { isBinary: true })).toBe('binary')
    expect(installMethodOf({}, { isBinary: false })).toBe('other')
  })

  test('createLazyAsyncValue is never awaited and re-reads only after its ttl', async () => {
    let t = 0
    let loads = 0
    let result: number | undefined = 42
    const value = createLazyAsyncValue(
      async () => {
        loads++
        return result
      },
      1_000,
      () => t,
    )
    expect(value.get()).toBeUndefined()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(value.get()).toBe(42)
    expect(loads).toBe(1)
    t = 999
    value.get()
    expect(loads).toBe(1)
    t = 2_000
    result = 7
    expect(value.get()).toBe(42)
    expect(loads).toBe(2)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(value.get()).toBe(7)
  })

  test('createLazyAsyncValue: a failed read is unknown, a throwing loader too', async () => {
    const failing = createLazyAsyncValue<number>(
      () => Promise.reject(new Error('EPERM')),
      1_000,
    )
    expect(failing.get()).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(failing.get()).toBeUndefined()
    const throwing = createLazyAsyncValue<number>(() => {
      throw new Error('sync')
    }, 1_000)
    expect(throwing.get()).toBeUndefined()
  })
})

const GIB = 1024 ** 3

function waveTwoSources(
  overrides: Partial<CliAdContextSources> = {},
): CliAdContextSources {
  return sources({
    term: () => ({
      terminal: 'ghostty',
      multiplexer: 'none',
      remote: 'none',
      images: 'none',
      shell: 'zsh',
      utf8: true,
      proxy: true,
    }),
    rows: () => 50,
    system: () => ({
      platform: 'darwin',
      release: '25.0.0',
      arch: 'arm64',
      totalmem: 36 * GIB,
      uptimeSec: 3 * 86_400,
      load1: 6,
      freemem: 4 * GIB,
      cores: 12,
      cpuModel: 'Apple M4 Pro',
      diskFreeBytes: 120e9,
    }),
    session: () => ({
      adsServed: 5,
      lastAdAt: NOW - 61_000,
      lastClickAt: null,
      lastSendAt: NOW - 45_000,
      rttSamplesMs: [80, 90, 85, 100],
      failedRequests: 3,
      lastTtftMs: 2_400,
      lastAdFetchMs: 420,
    }),
    app: () => ({
      uptimeMs: 2 * 3_600_000,
      installAgeMs: 45 * 86_400_000,
      channel: 'stable',
      installMethod: 'npm',
      runtime: 'bun-1.3',
    }),
    localeEnv: () => ({ LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:fr' }),
    work: () => ({
      queued: 2,
      tool: 'shell',
      lastError: 'module-not-found',
      turnFailuresLastHour: 1,
      skills: 4,
    }),
    typing: () => ({
      typingSpeed: 'medium',
      typingRhythm: 'bursty',
      editRatio: '5-15%',
    }),
    ...overrides,
  })
}

describe('buildCliAdClientContext: wave 2', () => {
  test('buckets every new field and parses', () => {
    const context = buildCliAdClientContext(waveTwoSources())!
    expect(context.sys).toEqual({
      osMajor: '26',
      arch: 'arm64',
      ram: '32+',
      uptime: '1-7d',
      load: 'medium',
      freeMemory: '10-25%',
      cores: '9-12',
      cpu: 'apple_m4',
      diskFree: '50-200',
    })
    expect(context.app).toEqual({
      uptime: '1-8h',
      installAge: '30-90d',
      channel: 'stable',
      installMethod: 'npm',
      runtime: 'bun-1.3',
    })
    expect(context.ui).toEqual({ language: 'en', languageCount: '2' })
    expect(context.work).toEqual({
      queued: '2-5',
      tool: 'shell',
      lastError: 'module-not-found',
      turnFailures: '1',
      skills: '2-5',
    })
    expect(context.net).toEqual({
      rtt: '50-150',
      jitter: '10-50',
      failedRequests: '2-5',
      ttft: '1-3s',
      adFetch: '300-1000',
    })
    expect(context.term).toMatchObject({
      rows: '40-59',
      utf8: true,
      proxy: true,
    })
    expect(context.attn).toMatchObject({
      typingSpeed: 'medium',
      typingRhythm: 'bursty',
      editRatio: '5-15%',
    })
    expect(parseAdClientContext(context)).toEqual(context)
  })

  test('no raw value reaches the serialized context', () => {
    const raw = JSON.stringify(
      buildCliAdClientContext(
        waveTwoSources({
          localeEnv: () => ({ LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:fr_CA' }),
        }),
      ),
    )
    for (const leak of ['Apple M4 Pro', 'en_US', 'UTF-8', 'fr_CA', '120000000000'])
      expect(raw).not.toContain(leak)
  })

  test('Windows has no load average; unknowns are absent, not zero', () => {
    const context = buildCliAdClientContext(
      waveTwoSources({
        system: () => ({
          platform: 'win32',
          release: '10.0.26100',
          arch: 'x64',
          totalmem: 16 * GIB,
          load1: 0,
          cores: 8,
          cpuModel: 'Some Future Chip',
        }),
        app: () => ({ channel: 'dev' }),
        localeEnv: () => ({}),
        work: () => ({
          queued: null,
          tool: null,
          lastError: 'none',
          turnFailuresLastHour: 0,
          skills: null,
        }),
        typing: () => null,
        rows: () => null,
        session: () => ({
          adsServed: 0,
          lastAdAt: null,
          lastClickAt: null,
          lastSendAt: null,
          rttSamplesMs: [120],
          failedRequests: 0,
          lastTtftMs: null,
          lastAdFetchMs: null,
        }),
      }),
    )!
    expect(context.sys).toEqual({
      osMajor: '10',
      arch: 'x64',
      ram: '16-32',
      cores: '5-8',
      cpu: 'other',
    })
    expect(context.app).toEqual({ channel: 'dev' })
    expect(context.ui).toBeUndefined()
    // no tool call seen yet is a known `none`; unloaded skills are unknown
    expect(context.work).toEqual({
      tool: 'none',
      lastError: 'none',
      turnFailures: '0',
    })
    expect(context.attn!.typingSpeed).toBeUndefined()
    expect(context.term!.rows).toBeUndefined()
    // one RTT sample has no jitter; no turn and no ad yet have no timings
    expect(context.net).toEqual({ rtt: '50-150', failedRequests: '0' })
    expect(parseAdClientContext(context)).toEqual(context)
  })

  test('a throwing wave-2 source costs only its own section', () => {
    const boom = () => {
      throw new Error('boom')
    }
    const context = buildCliAdClientContext(
      waveTwoSources({ app: boom, work: boom, localeEnv: boom, typing: boom }),
    )!
    expect(context.app).toBeUndefined()
    expect(context.work).toBeUndefined()
    expect(context.ui).toBeUndefined()
    expect(context.sys?.cpu).toBe('apple_m4')
  })

  test('a malformed runtime label costs only its own field, never rides raw', () => {
    const context = buildCliAdClientContext(
      waveTwoSources({
        app: () => ({ runtime: 'Bun 1.3.2 (macOS)', channel: 'stable' }),
      }),
    )!
    expect(context.app).toEqual({ channel: 'stable' })
    expect(JSON.stringify(context)).not.toContain('macOS')
  })
})
