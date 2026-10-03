import { describe, expect, test } from 'bun:test'

import {
  AD_MS_CAP,
  adVendorOfDomain,
  adVendorOfMcp,
  adVendorOfPackage,
  bucketCardDimension,
  bucketCores,
  bucketCount,
  bucketDiskFree,
  bucketDisplayScale,
  bucketDistance,
  bucketEditRatio,
  bucketFreeMemory,
  bucketInstallAge,
  bucketJitter,
  bucketLanguageCount,
  bucketLatency,
  bucketLoad,
  bucketPointerSpeed,
  bucketTerminalRows,
  bucketTtft,
  bucketTypingSpeed,
  bucketUptime,
  bucketZoom,
  cpuFamilyOf,
  createPointerTracker,
  createTypingTracker,
  distanceToRect,
  errorClassOf,
  runtimeLabelOf,
  shellOf,
  TYPING_WINDOW_MS,
  utf8LocaleOf,
  gpuVendorOf,
  jitterOf,
  primaryLanguageOf,
  referrerClassOf,
  toolCategoryOf,
  typingRhythmOf,
  utmSourceOf,
  bucketAdsThisSession,
  bucketArch,
  bucketDisplayCount,
  bucketRam,
  bucketRtt,
  bucketSince,
  bucketTerminalColumns,
  bucketTurnIndex,
  bucketWindowSize,
  clampMs,
  mcpVendorOf,
  mcpVendorsOf,
  parseAdClientContext,
  parseAdEngagement,
} from '../ad-client-context'

describe('parseAdClientContext', () => {
  test('accepts a full v1 context', () => {
    const context = {
      v: 1,
      win: {
        focused: true,
        visible: true,
        maximized: false,
        fullscreen: false,
        size: 'm',
        displays: '2',
        onPrimary: true,
      },
      sys: {
        idle: '<1s',
        locked: false,
        onBattery: true,
        osMajor: '15',
        arch: 'arm64',
        ram: '16-32',
      },
      attn: {
        sinceInput: '1-5s',
        sinceSend: '5-30s',
        turnRunning: true,
        turnElapsed: '30s-2m',
        pendingPrompt: false,
        panel: 'changes',
        slotInViewport: true,
      },
      sess: {
        turnIndex: '2-5',
        adsThisSession: '1-3',
        sinceLastAd: '2-10m',
        sinceLastClick: 'never',
      },
      agent: { harness: 'base3', model: 'deepseek-v4-flash', effort: 'medium', mode: 'DEFAULT' },
      stack: { mcp: ['github', 'supabase'], editors: ['cursor'] },
      net: { rtt: '50-150' },
    }
    expect(parseAdClientContext(context)).toEqual(context)
  })

  test('accepts a sparse context: every group and field is optional', () => {
    expect(parseAdClientContext({ v: 1 })).toEqual({ v: 1 })
    expect(parseAdClientContext({ v: 1, win: { focused: false } })).toEqual({
      v: 1,
      win: { focused: false },
    })
  })

  test('drops, never throws, on anything malformed or from another version', () => {
    expect(parseAdClientContext(undefined)).toBeUndefined()
    expect(parseAdClientContext('nope')).toBeUndefined()
    expect(parseAdClientContext({ v: 2 })).toBeUndefined()
    expect(parseAdClientContext({ v: 1, sys: { idle: '3s' } })).toBeUndefined()
    expect(parseAdClientContext({ v: 1, stack: { mcp: ['my-private-server'] } })).toBeUndefined()
  })

  test('accepts the CLI terminal and web browser groups', () => {
    const cli = {
      v: 1,
      attn: { scrolledUp: true },
      term: {
        terminal: 'ghostty',
        links: true,
        mouse: true,
        multiplexer: 'tmux',
        remote: 'ssh',
        cols: '120-159',
        colors: 'truecolor',
        images: 'kitty',
        shell: 'fish',
        focused: false,
      },
    }
    expect(parseAdClientContext(cli)).toEqual(cli)
    const web = {
      v: 1,
      net: { connection: 'wifi', effectiveType: '4g', saveData: false },
      web: { browser: 'arc', adBlock: false, touch: false, mobile: false, dark: true, reducedMotion: false },
    }
    expect(parseAdClientContext(web)).toEqual(web)
    expect(parseAdClientContext({ v: 1, term: { terminal: 'hyper' } })).toBeUndefined()
  })

  test('strips unknown keys so a raw value can never ride along', () => {
    expect(
      parseAdClientContext({ v: 1, win: { focused: true, widthPx: 1512 }, hostname: 'owens-mbp' }),
    ).toEqual({ v: 1, win: { focused: true } })
  })
})

describe('parseAdEngagement', () => {
  test('accepts a full record with a click and a post-click update', () => {
    const record = {
      v: 1,
      impUrl: 'https://ads.example/i?x=1',
      visibleAtMs: 120,
      mrc50: true,
      mrc50AtMs: 1_200,
      visibleMs: 41_000,
      focusedVisibleMs: 30_000,
      maxVisiblePct: 100,
      hoverCount: 2,
      hoverMs: 1_800,
      firstHoverMs: 9_000,
      sentMessageDuringExposure: false,
      exit: 'rotation',
      truncated: false,
      imageFailed: false,
      click: {
        msSinceMount: 12_000,
        msSinceVisible: 11_880,
        msSinceRotation: 12_000,
        pointerMovedOver: true,
        isTrusted: true,
        windowFocused: true,
        region: 'title',
        modifier: false,
        count: 1,
      },
      postClick: { browserOpened: true, returnMs: 45_000 },
    }
    expect(parseAdEngagement(record)).toEqual(record)
  })

  test('a post-click-only upsert is valid on its own', () => {
    const update = { v: 1, impUrl: 'https://ads.example/i', postClick: { returnMs: 2_000 } }
    expect(parseAdEngagement(update)).toEqual(update)
  })

  test('requires impUrl and rejects out-of-range timings', () => {
    expect(parseAdEngagement({ v: 1 })).toBeUndefined()
    expect(parseAdEngagement({ v: 1, impUrl: 'x', visibleMs: -1 })).toBeUndefined()
    expect(parseAdEngagement({ v: 1, impUrl: 'x', visibleMs: AD_MS_CAP + 1 })).toBeUndefined()
    expect(parseAdEngagement({ v: 1, impUrl: 'x', maxVisiblePct: 101 })).toBeUndefined()
    expect(parseAdEngagement({ v: 1, impUrl: 'x', visibleMs: 1.5 })).toBeUndefined()
  })
})

describe('bucket helpers', () => {
  test('bucketSince edges', () => {
    expect(bucketSince(null)).toBe('never')
    expect(bucketSince(undefined)).toBe('never')
    expect(bucketSince(Number.NaN)).toBe('never')
    expect(bucketSince(-5)).toBe('<1s')
    expect(bucketSince(999)).toBe('<1s')
    expect(bucketSince(1_000)).toBe('1-5s')
    expect(bucketSince(5_000)).toBe('5-30s')
    expect(bucketSince(30_000)).toBe('30s-2m')
    expect(bucketSince(120_000)).toBe('2-10m')
    expect(bucketSince(600_000)).toBe('10m-1h')
    expect(bucketSince(3_600_000)).toBe('>1h')
  })

  test('size, display, ram, rtt, turn and session buckets', () => {
    expect(bucketWindowSize(799)).toBe('xs')
    expect(bucketWindowSize(1_512)).toBe('m')
    expect(bucketWindowSize(2_560)).toBe('xl')
    expect(bucketDisplayCount(0)).toBe('1')
    expect(bucketDisplayCount(2)).toBe('2')
    expect(bucketDisplayCount(4)).toBe('3+')
    expect(bucketRam(7.8 * 1024 ** 3)).toBe('8-16')
    expect(bucketRam(4 * 1024 ** 3)).toBe('<8')
    expect(bucketRam(36 * 1024 ** 3)).toBe('32+')
    expect(bucketRtt(49)).toBe('<50')
    expect(bucketRtt(400)).toBe('400+')
    expect(bucketTurnIndex(1)).toBe('1')
    expect(bucketTurnIndex(21)).toBe('21+')
    expect(bucketAdsThisSession(0)).toBe('0')
    expect(bucketAdsThisSession(11)).toBe('11+')
    expect(bucketArch('arm64')).toBe('arm64')
    expect(bucketArch('ia32')).toBe('other')
    expect(bucketTerminalColumns(79)).toBe('<80')
    expect(bucketTerminalColumns(80)).toBe('80-119')
    expect(bucketTerminalColumns(200)).toBe('160+')
  })

  test('clampMs rounds, clamps and drops non-finite values', () => {
    expect(clampMs(12.6)).toBe(13)
    expect(clampMs(-3)).toBe(0)
    expect(clampMs(10 * AD_MS_CAP)).toBe(AD_MS_CAP)
    expect(clampMs(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(clampMs(null)).toBeUndefined()
  })

  test('MCP servers map to a closed vendor vocabulary', () => {
    expect(mcpVendorOf('@supabase/mcp-server-supabase')).toBe('supabase')
    expect(mcpVendorOf('https://mcp.linear.app/sse')).toBe('linear')
    expect(mcpVendorOf('@playwright/mcp')).toBe('browser')
    expect(mcpVendorOf('owens-internal-tool')).toBe('other')
    expect(mcpVendorsOf(['github', 'GitHub MCP', 'stripe', 'x'])).toEqual(['github', 'other', 'stripe'])
  })
})

describe('wave 2 fields and helpers', () => {
  test('a context carrying every wave 2 group parses intact', () => {
    const context = {
      v: 1,
      win: { minimized: false, scale: '2', zoom: '90-110' },
      sys: {
        thermal: 'nominal',
        uptime: '1-7d',
        load: 'low',
        freeMemory: '25-50%',
        cores: '9-12',
        cpu: 'apple_m3',
        gpu: 'apple',
        diskFree: '50-200',
        shell: 'zsh',
      },
      attn: {
        pointerSpeed: 'slow',
        pointerTowardSlot: true,
        pointerDistance: '50-200',
        typingSpeed: 'medium',
        typingRhythm: 'bursty',
        editRatio: '5-15%',
      },
      net: { jitter: '10-50', offlineFlaps: '0', failedRequests: '1', ttft: '1-3s', adFetch: '100-300' },
      app: {
        uptime: '1-8h',
        installAge: '7-30d',
        channel: 'stable',
        launchAtLogin: false,
        tray: false,
        sinceResume: '>1h',
        installMethod: 'dmg',
        runtime: 'bun-1.4',
      },
      ui: { theme: 'system', reducedMotion: false, highContrast: false, language: 'en', languageCount: '2' },
      work: {
        projects: '2-5',
        threads: '6-20',
        queued: '0',
        missionRunning: false,
        tool: 'shell',
        lastError: 'type-error',
        turnFailures: '0',
        skills: '1',
      },
      term: { rows: '40-59', utf8: true, proxy: false },
      web: {
        standalone: false,
        referrer: 'search',
        utm: 'none',
        cookies: true,
        webdriver: false,
        doNotTrack: false,
        zoom: '90-110',
      },
    }
    expect(parseAdClientContext(context)).toEqual(context)
  })

  test('raw values in wave 2 fields are rejected', () => {
    expect(parseAdClientContext({ v: 1, sys: { cpu: 'Apple M3 Pro' } })).toBeUndefined()
    expect(parseAdClientContext({ v: 1, ui: { language: 'en-US' } })).toBeUndefined()
    expect(parseAdClientContext({ v: 1, app: { runtime: 'Bun v1.4.2 (macOS)' } })).toBeUndefined()
    expect(parseAdClientContext({ v: 1, web: { referrer: 'https://google.com/?q=x' } })).toBeUndefined()
  })

  test('engagement wave 2 fields parse', () => {
    const record = {
      v: 1,
      impUrl: 'https://ads.example/i',
      imageLoadMs: 140,
      idleVisibleMs: 2_000,
      reentries: 1,
      keysDuringExposure: '6-20',
      closestPointer: '50-200',
      cardWidth: '300-600',
      cardHeight: '<120',
      dismissMs: 4_000,
      copied: false,
      postClick: { packageInstalled: true, mcpAdded: false, adoptedAtMs: 600_000 },
    }
    expect(parseAdEngagement(record)).toEqual(record)
  })

  test('machine buckets', () => {
    expect(bucketUptime(30 * 60_000)).toBe('<1h')
    expect(bucketUptime(3 * 86_400_000)).toBe('1-7d')
    expect(bucketLoad(2, 16)).toBe('low')
    expect(bucketLoad(12, 16)).toBe('medium')
    expect(bucketLoad(20, 16)).toBe('high')
    expect(bucketFreeMemory(1, 20)).toBe('<10%')
    expect(bucketFreeMemory(12, 20)).toBe('50%+')
    expect(bucketCores(8)).toBe('5-8')
    expect(bucketCores(16)).toBe('13+')
    expect(cpuFamilyOf('Apple M3 Pro')).toBe('apple_m3')
    expect(cpuFamilyOf('Apple M9')).toBe('apple_other')
    expect(cpuFamilyOf('Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz')).toBe('intel')
    expect(cpuFamilyOf('AMD Ryzen 9 7950X')).toBe('amd')
    expect(gpuVendorOf('ANGLE (NVIDIA GeForce RTX 4090)')).toBe('nvidia')
    expect(gpuVendorOf('Google SwiftShader')).toBe('software')
    expect(gpuVendorOf('Apple M2')).toBe('apple')
    expect(bucketDiskFree(5e9)).toBe('<10')
    expect(bucketDisplayScale(1)).toBe('1')
    expect(bucketDisplayScale(1.5)).toBe('1.25-1.75')
    expect(bucketDisplayScale(2)).toBe('2')
    expect(bucketZoom(100)).toBe('90-110')
    expect(bucketZoom(175)).toBe('150+')
    expect(bucketInstallAge(3 * 86_400_000)).toBe('1-7d')
  })

  test('workload, network and terminal buckets', () => {
    expect(bucketCount(0)).toBe('0')
    expect(bucketCount(1)).toBe('1')
    expect(bucketCount(7)).toBe('6-20')
    expect(bucketTtft(2_500)).toBe('1-3s')
    expect(bucketLatency(250)).toBe('100-300')
    expect(jitterOf([100])).toBeUndefined()
    expect(jitterOf([100, 120, 100])).toBe(20)
    expect(bucketJitter(20)).toBe('10-50')
    expect(bucketTerminalRows(24)).toBe('24-39')
    expect(toolCategoryOf('read_files')).toBe('read')
    expect(toolCategoryOf('str_replace')).toBe('edit')
    expect(toolCategoryOf('run_terminal_command')).toBe('shell')
    expect(toolCategoryOf('code_search')).toBe('search')
    expect(toolCategoryOf('web_search')).toBe('web')
    expect(toolCategoryOf('spawn_agents')).toBe('agent')
    expect(toolCategoryOf(undefined)).toBe('none')
  })

  test('pointer and typing buckets keep only coarse classes', () => {
    expect(bucketDistance(30)).toBe('<50')
    expect(bucketPointerSpeed(5)).toBe('still')
    expect(bucketPointerSpeed(900)).toBe('fast')
    expect(bucketTypingSpeed(undefined)).toBe('none')
    expect(bucketTypingSpeed(35)).toBe('medium')
    expect(typingRhythmOf([100, 100, 100])).toBeUndefined()
    expect(typingRhythmOf([100, 110, 90, 105, 95])).toBe('steady')
    expect(typingRhythmOf([50, 60, 2_000, 40, 3_000, 55])).toBe('bursty')
    expect(bucketEditRatio(1, 100)).toBe('<5%')
    expect(bucketEditRatio(40, 100)).toBe('30%+')
    expect(bucketCardDimension(320)).toBe('300-600')
  })

  test('locale, referrer and utm classification never echo the raw value', () => {
    expect(primaryLanguageOf('en-US')).toBe('en')
    expect(primaryLanguageOf('pt_BR.UTF-8')).toBe('pt')
    expect(primaryLanguageOf('C')).toBeUndefined()
    expect(bucketLanguageCount(3)).toBe('3+')
    expect(referrerClassOf(undefined, 'freebuff.com')).toBe('none')
    expect(referrerClassOf('https://www.google.co.uk/search?q=x', 'freebuff.com')).toBe('search')
    expect(referrerClassOf('https://t.co/abc', 'freebuff.com')).toBe('social')
    expect(referrerClassOf('https://news.ycombinator.com/item?id=1', 'freebuff.com')).toBe('community')
    expect(referrerClassOf('https://github.com/org/repo', 'freebuff.com')).toBe('github')
    expect(referrerClassOf('https://freebuff.com/chat', 'www.freebuff.com')).toBe('internal')
    expect(referrerClassOf('https://someone.dev/post', 'freebuff.com')).toBe('other')
    expect(utmSourceOf('Reddit_Ads')).toBe('reddit')
    expect(utmSourceOf('')).toBe('none')
    expect(utmSourceOf('partner-xyz')).toBe('other')
  })

  test('vendor adoption maps domains, packages and MCP servers to a closed list', () => {
    expect(adVendorOfDomain('https://www.supabase.com/pricing')).toBe('supabase')
    expect(adVendorOfDomain('https://dashboard.stripe.com')).toBe('stripe')
    expect(adVendorOfDomain('https://example.com')).toBeUndefined()
    expect(adVendorOfPackage('@supabase/supabase-js')).toBe('supabase')
    expect(adVendorOfPackage('stripe@17.0.0')).toBe('stripe')
    expect(adVendorOfPackage('@sentry/nextjs')).toBe('sentry')
    expect(adVendorOfPackage('left-pad')).toBeUndefined()
    expect(adVendorOfMcp('https://mcp.supabase.com/mcp')).toBe('supabase')
    expect(adVendorOfMcp('owens-internal-tool')).toBeUndefined()
  })
})

describe('wave 2 fields', () => {
  const WAVE2 = {
    v: 1,
    win: { minimized: false, scale: '2', zoom: '90-110' },
    sys: {
      thermal: 'fair',
      uptime: '1-7d',
      load: 'medium',
      freeMemory: '10-25%',
      cores: '9-12',
      cpu: 'apple_m3',
      gpu: 'apple',
      diskFree: '50-200',
      shell: 'zsh',
    },
    attn: {
      pointerSpeed: 'slow',
      pointerTowardSlot: true,
      pointerDistance: '50-200',
      typingSpeed: 'medium',
      typingRhythm: 'bursty',
      editRatio: '5-15%',
    },
    net: { jitter: '10-50', offlineFlaps: '0', failedRequests: '1', ttft: '1-3s', adFetch: '100-300' },
    app: {
      uptime: '1-8h',
      installAge: '7-30d',
      channel: 'stable',
      launchAtLogin: false,
      tray: true,
      sinceResume: '2-10m',
      installMethod: 'dmg',
      runtime: 'electron-38.2',
    },
    ui: { theme: 'system', reducedMotion: false, highContrast: false, language: 'en', languageCount: '2' },
    work: {
      projects: '2-5',
      threads: '6-20',
      queued: '0',
      missionRunning: false,
      tool: 'shell',
      lastError: 'module-not-found',
      turnFailures: '1',
      skills: '2-5',
    },
    term: { rows: '40-59', utf8: true, proxy: false },
    web: {
      standalone: false,
      referrer: 'search',
      utm: 'reddit',
      cookies: true,
      webdriver: false,
      doNotTrack: false,
    },
  }

  test('a full wave 2 context round-trips', () => {
    expect(parseAdClientContext(WAVE2)).toEqual(WAVE2)
  })

  test.each([
    ['a raw shell path', { sys: { shell: '/bin/zsh' } }],
    ['a raw GPU renderer string', { sys: { gpu: 'Apple M3 Max' } }],
    ['a raw cpu model', { sys: { cpu: 'Apple M3 Max' } }],
    ['a raw free-disk number', { sys: { diskFree: 123_456_789 } }],
    ['a full locale', { ui: { language: 'en-US' } }],
    ['a language list', { ui: { language: 'en,fr' } }],
    ['a runtime with a patch version', { app: { runtime: 'bun-1.3.2' } }],
    ['a free-text runtime', { app: { runtime: 'electron /Applications/Freebuff.app' } }],
    ['a referrer URL', { web: { referrer: 'https://www.google.com/search?q=supabase' } }],
    ['a raw utm_source', { web: { utm: 'my-newsletter-42' } }],
    ['a raw error message', { work: { lastError: 'Cannot find module ./secret' } }],
    ['a raw tool name', { work: { tool: 'mcp__acme__deploy' } }],
    ['an exact queue length', { work: { queued: 3 } }],
    ['a raw ttft', { net: { ttft: 1234 } }],
    ['a raw jitter', { net: { jitter: 12 } }],
    ['raw typing timings', { attn: { typingSpeed: [120, 80, 95] } }],
    ['a pointer coordinate', { attn: { pointerDistance: 140 } }],
    ['a raw zoom', { web: { zoom: 125 } }],
    ['raw terminal rows', { term: { rows: 48 } }],
  ])('rejects %s: the whole context is dropped', (_name, fields) => {
    expect(parseAdClientContext({ v: 1, ...fields })).toBeUndefined()
  })

  test('unknown keys inside wave 2 groups are stripped', () => {
    expect(
      parseAdClientContext({
        v: 1,
        sys: { cores: '5-8', cpuModel: 'Apple M3 Max', homedir: '/Users/x' },
        app: { channel: 'beta', execPath: '/opt/homebrew/bin/freebuff' },
        ui: { language: 'en', languages: ['en-US', 'fr-FR'] },
        work: { tool: 'read', lastErrorText: 'ENOENT /Users/x/repo' },
        web: { referrer: 'search', referrerUrl: 'https://google.com/?q=x' },
        term: { proxy: true, proxyUrl: 'http://corp:3128' },
      }),
    ).toEqual({
      v: 1,
      sys: { cores: '5-8' },
      app: { channel: 'beta' },
      ui: { language: 'en' },
      work: { tool: 'read' },
      web: { referrer: 'search' },
      term: { proxy: true },
    })
  })

  test('engagement: wave 2 fields round-trip, and raw keystroke counts or pointer coordinates are rejected', () => {
    const record = {
      v: 1,
      impUrl: 'https://ads.example/i',
      imageFailed: false,
      imageLoadMs: 240,
      idleVisibleMs: 12_000,
      reentries: 2,
      keysDuringExposure: '6-20',
      closestPointer: '50-200',
      cardWidth: '300-600',
      cardHeight: '<120',
      dismissMs: 4_000,
      copied: false,
      postClick: { packageInstalled: true, mcpAdded: false, adoptedAtMs: 90_000 },
    }
    expect(parseAdEngagement(record)).toEqual(record)
    const base = { v: 1, impUrl: 'x' }
    expect(parseAdEngagement({ ...base, keysDuringExposure: 37 })).toBeUndefined()
    expect(parseAdEngagement({ ...base, closestPointer: 88 })).toBeUndefined()
    expect(parseAdEngagement({ ...base, cardWidth: 412 })).toBeUndefined()
    expect(parseAdEngagement({ ...base, postClick: { packageInstalled: '@supabase/supabase-js' } })).toBeUndefined()
    expect(parseAdEngagement({ ...base, copied: 'Try Supabase' })).toBeUndefined()
    expect(parseAdEngagement({ ...base, copiedText: 'Try Supabase', pointerPath: [[1, 2]] })).toEqual(base)
  })
})

describe('wave 2 collector helpers', () => {
  test('shellOf, runtimeLabelOf, utf8LocaleOf', () => {
    expect(shellOf('/bin/zsh')).toBe('zsh')
    expect(shellOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
    expect(shellOf('powershell.exe')).toBe('pwsh')
    expect(shellOf('/usr/local/bin/xonsh')).toBe('other')
    expect(shellOf('')).toBeUndefined()
    expect(shellOf(undefined)).toBeUndefined()
    expect(runtimeLabelOf('bun', '1.3.2')).toBe('bun-1.3')
    expect(runtimeLabelOf('node', 'v22.11.0')).toBe('node-22.11')
    expect(runtimeLabelOf('Electron', '38.2.1')).toBe('electron-38.2')
    expect(runtimeLabelOf('bun', 'canary')).toBeUndefined()
    expect(runtimeLabelOf('bun 2', '1.3')).toBeUndefined()
    expect(utf8LocaleOf({ LANG: 'en_US.UTF-8' })).toBe(true)
    expect(utf8LocaleOf({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(false)
    expect(utf8LocaleOf({})).toBeUndefined()
  })

  test('errorClassOf classifies locally and only the class comes back', () => {
    expect(errorClassOf(undefined)).toBe('none')
    expect(errorClassOf('')).toBe('none')
    expect(errorClassOf("Error: Cannot find module '/Users/owen/acme/src/x'")).toBe('module-not-found')
    expect(errorClassOf('ENOENT: no such file or directory, open /tmp/a')).toBe('file-not-found')
    expect(errorClassOf('listen EADDRINUSE: address already in use :::3000')).toBe('port-in-use')
    expect(errorClassOf('npm ERR! code ERESOLVE')).toBe('version-conflict')
    expect(errorClassOf('something went wrong')).toBe('other')
    // bounded: a class named only past the scan window is not found
    expect(errorClassOf(`${'x'.repeat(10_000)} ECONNREFUSED`)).toBe('other')
  })

  test('typing tracker: buckets only, bounded, never the keys', () => {
    let now = 1_000_000
    const typing = createTypingTracker(() => now)
    expect(typing.summary()).toEqual({ typingSpeed: 'none' })
    // 150 characters in a minute at a steady 400ms = 30 wpm, 10% deletions
    for (let i = 0; i < 150; i++) {
      now += 400
      typing.note(i % 10 === 0)
    }
    const summary = typing.summary()
    expect(summary.typingSpeed).toBe('medium')
    expect(summary.typingRhythm).toBe('steady')
    expect(summary.editRatio).toBe('5-15%')
    expect(Object.keys(summary).sort()).toEqual(['editRatio', 'typingRhythm', 'typingSpeed'])
    expect(typing.countSince(now - 2_000)).toBe(6)
    now += TYPING_WINDOW_MS + 1
    expect(typing.summary()).toEqual({ typingSpeed: 'none' })
    // a stuck key cannot grow the window past its cap
    for (let i = 0; i < 5_000; i++) typing.note(false)
    expect(typing.countSince(0)).toBeLessThanOrEqual(512)
  })

  test('pointer tracker: speed, heading and distance buckets', () => {
    let now = 0
    const pointer = createPointerTracker(() => now)
    const slot = { left: 0, top: 900, right: 800, bottom: 960 }
    expect(pointer.summary(slot)).toBeUndefined()
    for (let i = 0; i <= 8; i++) {
      now = i * 250
      pointer.note(400, 400 + i * 50)
    }
    expect(pointer.summary(slot)).toEqual({
      pointerSpeed: 'slow',
      pointerTowardSlot: true,
      pointerDistance: '50-200',
    })
    expect(pointer.summary()).toEqual({ pointerSpeed: 'slow' })
    now += 5_000
    expect(pointer.summary(slot)).toEqual({ pointerSpeed: 'still' })
    expect(distanceToRect(10, 10, { left: 0, top: 0, right: 20, bottom: 20 })).toBe(0)
    expect(distanceToRect(23, 24, { left: 0, top: 0, right: 20, bottom: 20 })).toBe(5)
  })

  test('gpuVendorOf reads Electron basic-info vendor ids', () => {
    expect(gpuVendorOf('0x106b')).toBe('apple')
    expect(gpuVendorOf('0x10de')).toBe('nvidia')
    expect(gpuVendorOf('0x5143')).toBe('qualcomm')
  })
})
