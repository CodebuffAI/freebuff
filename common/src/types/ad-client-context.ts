import { z } from 'zod/v4'

// The serve-time context a native client attaches to an ad request, and the per-impression engagement record it
// reports afterwards. Both feed the click model as training features ONLY: nothing here may decide billing,
// invalid-traffic verdicts or eligibility, because every field is client-reported and therefore forgeable.
//
// Every value is bucketed or enumerated on the client so no raw measurement leaves the machine, and every field is
// optional: absent means unknown, never "false" or "zero". A context that fails to parse is dropped and the ad request
// proceeds without it, so a client/server version skew can cost features but never an ad.
//
// This file ships in the public mirror. Field names and bucket edges are client behaviour and fine to publish; model
// weights, thresholds and invalid-traffic cut-offs are not, and must never be added here.

export const AD_CLIENT_CONTEXT_VERSION = 1
export const AD_ENGAGEMENT_VERSION = 1

/** Upper bound for every millisecond field: one hour. */
export const AD_MS_CAP = 3_600_000

export const SINCE_BUCKETS = [
  '<1s',
  '1-5s',
  '5-30s',
  '30s-2m',
  '2-10m',
  '10m-1h',
  '>1h',
  'never',
] as const
export type SinceBucket = (typeof SINCE_BUCKETS)[number]

export const WINDOW_SIZE_BUCKETS = ['xs', 's', 'm', 'l', 'xl'] as const
export const DISPLAY_COUNT_BUCKETS = ['1', '2', '3+'] as const
export const RAM_BUCKETS = ['<8', '8-16', '16-32', '32+'] as const
export const RTT_BUCKETS = ['<50', '50-150', '150-400', '400+'] as const
export const TURN_INDEX_BUCKETS = ['1', '2-5', '6-20', '21+'] as const
export const ADS_SESSION_BUCKETS = ['0', '1-3', '4-10', '11+'] as const
export const ARCHES = ['arm64', 'x64', 'other'] as const
export const PANELS = ['none', 'changes', 'preview', 'files', 'other'] as const
export const EDITORS = ['vscode', 'cursor', 'zed'] as const
export const MCP_VENDORS = [
  'github',
  'gitlab',
  'linear',
  'jira',
  'notion',
  'slack',
  'supabase',
  'vercel',
  'netlify',
  'cloudflare',
  'sentry',
  'stripe',
  'postgres',
  'neon',
  'firebase',
  'aws',
  'figma',
  'browser',
  'other',
] as const
export type McpVendor = (typeof MCP_VENDORS)[number]

// CLI (terminal) vocabularies. A terminal has no viewport to measure, so these describe whether an ad can be seen and
// clicked at all: a link that cannot open (ssh, a container, no OSC 8) is a different impression from one that can.
export const TERMINALS = [
  'iterm',
  'apple_terminal',
  'ghostty',
  'wezterm',
  'kitty',
  'alacritty',
  'warp',
  'windows_terminal',
  'vscode',
  'cursor',
  'jetbrains',
  'other',
] as const
export const MULTIPLEXERS = ['none', 'tmux', 'screen', 'zellij'] as const
export const REMOTE_KINDS = ['none', 'ssh', 'codespaces', 'gitpod', 'container', 'wsl'] as const
export const TERMINAL_COLUMN_BUCKETS = ['<80', '80-119', '120-159', '160+'] as const
export const COLOR_DEPTHS = ['16', '256', 'truecolor'] as const
export const IMAGE_PROTOCOLS = ['none', 'iterm2', 'kitty', 'sixel'] as const
export const SHELLS = ['zsh', 'bash', 'fish', 'pwsh', 'nu', 'other'] as const

// Web (browser) vocabularies.
export const BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'arc', 'other'] as const
export const CONNECTION_TYPES = ['wifi', 'cellular', 'ethernet', 'other'] as const
export const EFFECTIVE_TYPES = ['slow-2g', '2g', '3g', '4g'] as const

export const ENGAGEMENT_EXITS = [
  'rotation',
  'new_message',
  'thread_switch',
  'unmount',
  'window_close',
] as const
export const CLICK_REGIONS = ['title', 'body', 'cta', 'logo', 'other'] as const

const since = z.enum(SINCE_BUCKETS)
const label = z.string().min(1).max(64)
const ms = z.number().int().min(0).max(AD_MS_CAP)
const count = z.number().int().min(0).max(10_000)

export const adClientContextSchema = z.object({
  v: z.literal(AD_CLIENT_CONTEXT_VERSION),
  win: z
    .object({
      focused: z.boolean(),
      visible: z.boolean(),
      maximized: z.boolean(),
      fullscreen: z.boolean(),
      size: z.enum(WINDOW_SIZE_BUCKETS),
      displays: z.enum(DISPLAY_COUNT_BUCKETS),
      onPrimary: z.boolean(),
    })
    .partial()
    .optional(),
  sys: z
    .object({
      idle: since,
      locked: z.boolean(),
      onBattery: z.boolean(),
      osMajor: z.string().min(1).max(16),
      arch: z.enum(ARCHES),
      ram: z.enum(RAM_BUCKETS),
    })
    .partial()
    .optional(),
  attn: z
    .object({
      sinceInput: since,
      sinceSend: since,
      turnRunning: z.boolean(),
      turnElapsed: since,
      pendingPrompt: z.boolean(),
      panel: z.enum(PANELS),
      slotInViewport: z.boolean(),
      /** the transcript is scrolled away from the bottom, where the CLI and web chat draw their slot */
      scrolledUp: z.boolean(),
    })
    .partial()
    .optional(),
  sess: z
    .object({
      turnIndex: z.enum(TURN_INDEX_BUCKETS),
      adsThisSession: z.enum(ADS_SESSION_BUCKETS),
      sinceLastAd: since,
      sinceLastClick: since,
    })
    .partial()
    .optional(),
  agent: z
    .object({ harness: label, model: label, effort: label, mode: label })
    .partial()
    .optional(),
  stack: z
    .object({
      mcp: z.array(z.enum(MCP_VENDORS)).max(MCP_VENDORS.length),
      editors: z.array(z.enum(EDITORS)).max(EDITORS.length),
    })
    .partial()
    .optional(),
  net: z
    .object({
      rtt: z.enum(RTT_BUCKETS),
      /** browser Network Information API (Chromium only); never available in the CLI */
      connection: z.enum(CONNECTION_TYPES),
      effectiveType: z.enum(EFFECTIVE_TYPES),
      saveData: z.boolean(),
    })
    .partial()
    .optional(),
  /** CLI only */
  term: z
    .object({
      terminal: z.enum(TERMINALS),
      /** OSC 8 hyperlinks render as clickable links */
      links: z.boolean(),
      /** mouse reporting is on, so the ad can be hovered and clicked with a pointer */
      mouse: z.boolean(),
      multiplexer: z.enum(MULTIPLEXERS),
      /** where the CLI runs relative to the user's browser: a click from ssh or a container opens nothing locally */
      remote: z.enum(REMOTE_KINDS),
      cols: z.enum(TERMINAL_COLUMN_BUCKETS),
      colors: z.enum(COLOR_DEPTHS),
      images: z.enum(IMAGE_PROTOCOLS),
      shell: z.enum(SHELLS),
      /** terminal focus reporting (DEC 1004) has told us the terminal is focused; absent when unsupported */
      focused: z.boolean(),
    })
    .partial()
    .optional(),
  /** web only */
  web: z
    .object({
      browser: z.enum(BROWSERS),
      adBlock: z.boolean(),
      touch: z.boolean(),
      mobile: z.boolean(),
      dark: z.boolean(),
      reducedMotion: z.boolean(),
    })
    .partial()
    .optional(),
})
export type AdClientContext = z.infer<typeof adClientContextSchema>

export const adEngagementSchema = z.object({
  v: z.literal(AD_ENGAGEMENT_VERSION),
  impUrl: z.string().min(1).max(4096),
  /** ms from mount to first frame with >=1px intersecting while the document is visible */
  visibleAtMs: ms.optional(),
  /** MRC50 (>=50% visible for 1s continuously) for EVERY provider, not only the one that bills on it */
  mrc50: z.boolean().optional(),
  mrc50AtMs: ms.optional(),
  visibleMs: ms.optional(),
  focusedVisibleMs: ms.optional(),
  maxVisiblePct: z.number().int().min(0).max(100).optional(),
  hoverCount: count.optional(),
  hoverMs: ms.optional(),
  firstHoverMs: ms.optional(),
  sentMessageDuringExposure: z.boolean().optional(),
  exit: z.enum(ENGAGEMENT_EXITS).optional(),
  truncated: z.boolean().optional(),
  imageFailed: z.boolean().optional(),
  click: z
    .object({
      msSinceMount: ms,
      msSinceVisible: ms,
      /** ms since the slot last swapped creatives: small values suggest the click was aimed at the previous ad */
      msSinceRotation: ms,
      pointerMovedOver: z.boolean(),
      isTrusted: z.boolean(),
      windowFocused: z.boolean(),
      region: z.enum(CLICK_REGIONS),
      modifier: z.boolean(),
      count: count,
    })
    .partial()
    .optional(),
  postClick: z
    .object({
      /** the window blurred after the click, i.e. the external browser actually took focus */
      browserOpened: z.boolean(),
      /** ms from the click until the window regained focus */
      returnMs: ms,
    })
    .partial()
    .optional(),
})
export type AdEngagement = z.infer<typeof adEngagementSchema>

/** Never throws; anything that does not parse is dropped rather than failing the ad request. */
export function parseAdClientContext(input: unknown): AdClientContext | undefined {
  const parsed = adClientContextSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

export function parseAdEngagement(input: unknown): AdEngagement | undefined {
  const parsed = adEngagementSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

/** `null`/`undefined` means the event has never happened this session. */
export function bucketSince(elapsedMs: number | null | undefined): SinceBucket {
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return 'never'
  const value = Math.max(0, elapsedMs)
  if (value < 1_000) return '<1s'
  if (value < 5_000) return '1-5s'
  if (value < 30_000) return '5-30s'
  if (value < 120_000) return '30s-2m'
  if (value < 600_000) return '2-10m'
  if (value < 3_600_000) return '10m-1h'
  return '>1h'
}

/** Buckets by window width in CSS/DIP pixels. */
export function bucketWindowSize(widthPx: number): (typeof WINDOW_SIZE_BUCKETS)[number] {
  if (widthPx < 800) return 'xs'
  if (widthPx < 1200) return 's'
  if (widthPx < 1600) return 'm'
  if (widthPx < 2200) return 'l'
  return 'xl'
}

export function bucketDisplayCount(displays: number): (typeof DISPLAY_COUNT_BUCKETS)[number] {
  if (displays <= 1) return '1'
  if (displays === 2) return '2'
  return '3+'
}

export function bucketRam(totalBytes: number): (typeof RAM_BUCKETS)[number] {
  const gib = totalBytes / 1024 ** 3
  // installed RAM reports slightly under its nominal size (an 8 GB machine shows ~7.8 GiB), so edges sit below it
  if (gib < 7) return '<8'
  if (gib < 15) return '8-16'
  if (gib < 31) return '16-32'
  return '32+'
}

export function bucketRtt(rttMs: number): (typeof RTT_BUCKETS)[number] {
  if (rttMs < 50) return '<50'
  if (rttMs < 150) return '50-150'
  if (rttMs < 400) return '150-400'
  return '400+'
}

export function bucketTerminalColumns(cols: number): (typeof TERMINAL_COLUMN_BUCKETS)[number] {
  if (cols < 80) return '<80'
  if (cols < 120) return '80-119'
  if (cols < 160) return '120-159'
  return '160+'
}

export function bucketTurnIndex(turnIndex: number): (typeof TURN_INDEX_BUCKETS)[number] {
  if (turnIndex <= 1) return '1'
  if (turnIndex <= 5) return '2-5'
  if (turnIndex <= 20) return '6-20'
  return '21+'
}

export function bucketAdsThisSession(ads: number): (typeof ADS_SESSION_BUCKETS)[number] {
  if (ads <= 0) return '0'
  if (ads <= 3) return '1-3'
  if (ads <= 10) return '4-10'
  return '11+'
}

export function bucketArch(arch: string): (typeof ARCHES)[number] {
  return arch === 'arm64' || arch === 'x64' ? arch : 'other'
}

/** Rounds, clamps and drops non-finite values so a bad clock can never fail the engagement record. */
export function clampMs(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(AD_MS_CAP, Math.max(0, Math.round(value)))
}

const MCP_VENDOR_PATTERNS: readonly [McpVendor, RegExp][] = [
  ['github', /github/],
  ['gitlab', /gitlab/],
  ['linear', /linear/],
  ['jira', /jira|atlassian/],
  ['notion', /notion/],
  ['slack', /slack/],
  ['supabase', /supabase/],
  ['vercel', /vercel/],
  ['netlify', /netlify/],
  ['cloudflare', /cloudflare/],
  ['sentry', /sentry/],
  ['stripe', /stripe/],
  ['neon', /neon/],
  ['postgres', /postgres|pg-mcp/],
  ['firebase', /firebase/],
  ['aws', /\baws\b|amazon/],
  ['figma', /figma/],
  ['browser', /playwright|puppeteer|browser|chrome/],
]

/**
 * Maps a configured MCP server's name, URL or command to a closed vendor vocabulary. The raw string never leaves the
 * machine; an unrecognised server becomes `other`.
 */
export function mcpVendorOf(identifier: string): McpVendor {
  const normalized = identifier.toLowerCase()
  for (const [vendor, pattern] of MCP_VENDOR_PATTERNS) {
    if (pattern.test(normalized)) return vendor
  }
  return 'other'
}

/** Dedupes and sorts so the same set of servers always serializes identically. */
export function mcpVendorsOf(identifiers: readonly string[]): McpVendor[] {
  return [...new Set(identifiers.map(mcpVendorOf))].sort()
}
