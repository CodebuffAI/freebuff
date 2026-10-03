import { describe, expect, test } from 'bun:test'

import {
  AD_MS_CAP,
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
