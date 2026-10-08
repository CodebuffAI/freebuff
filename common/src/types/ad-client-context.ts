import { z } from 'zod/v4'

// The serve-time context a native client attaches to an ad request, and the per-impression engagement record it
// reports afterwards. Both feed the click model as training features ONLY: nothing here may decide billing,
// invalid-traffic verdicts or eligibility, because every field is client-reported and therefore forgeable.
//
// Every value is bucketed or enumerated on the client so no raw measurement leaves the machine, and every field is
// optional: absent means unknown, never "false" or "zero". A context that fails to parse is dropped and the ad request
// proceeds without it, so a client/server version skew can cost features but never an ad.
//
// Vocabularies are ADDITIVE ONLY. One value outside its enum fails the parse, and that drops the WHOLE context, not
// the one field. So a new value must be live on every server that parses contexts (the `/api/v1/ads` and `/api/ads`
// routes are separate services that deploy separately) before a client release sends it, and no value may be removed
// while an old client can still send it.
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
  'zed',
  'tabby',
  /** Git Bash, MSYS2, Cygwin */
  'mintty',
  /** ConEmu and Cmder */
  'conemu',
  /**
   * A Windows console with no other terminal's marker: conhost (a cmd or PowerShell window), or Windows Terminal
   * reached as the default terminal application, which does not set WT_SESSION
   */
  'windows_console',
  'gnome_terminal',
  'konsole',
  /** any other VTE-based terminal: Ptyxis, Tilix, Terminator, xfce4-terminal, ... */
  'vte',
  'xterm',
  'foot',
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

// ---- context v1 additions (COD-757 wave 2). Additive and optional, so `v` stays 1. ----

// Machine (Desktop, CLI). Every value is coarse on purpose: these describe the kind of machine and how loaded it is,
// never which machine it is. Raw GPU strings, exact screen sizes, exact battery levels, fonts and similar
// fingerprint-grade values are deliberately absent.
export const THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'] as const
export const UPTIME_BUCKETS = ['<1h', '1-8h', '8-24h', '1-7d', '7d+'] as const
/** 1-minute load average divided by core count */
export const LOAD_BUCKETS = ['low', 'medium', 'high'] as const
/** free memory as a share of total */
export const FREE_MEMORY_BUCKETS = ['<10%', '10-25%', '25-50%', '50%+'] as const
export const CORE_BUCKETS = ['<=4', '5-8', '9-12', '13+'] as const
export const CPU_FAMILIES = [
  'apple_m1',
  'apple_m2',
  'apple_m3',
  'apple_m4',
  'apple_m5',
  'apple_other',
  'intel',
  'amd',
  'qualcomm',
  'other',
] as const
export const GPU_VENDORS = ['apple', 'nvidia', 'amd', 'intel', 'qualcomm', 'software', 'other'] as const
/** free disk on the volume holding the user's home directory, in GB */
export const DISK_FREE_BUCKETS = ['<10', '10-50', '50-200', '200+'] as const
export const DISPLAY_SCALE_BUCKETS = ['1', '1.25-1.75', '2', '2.5+'] as const
/** page / window zoom in percent */
export const ZOOM_BUCKETS = ['<90', '90-110', '110-150', '150+'] as const

// App install and preferences (Desktop, CLI).
export const INSTALL_AGE_BUCKETS = ['<1d', '1-7d', '7-30d', '30-90d', '90d+'] as const
export const RELEASE_CHANNELS = ['stable', 'beta', 'staging', 'dev', 'other'] as const
export const INSTALL_METHODS = [
  'npx',
  'npm',
  'bun',
  /** `bunx` / `bun x`: run once from bun's cache, as `npx` is from npm's */
  'bunx',
  'pnpm',
  'yarn',
  'brew',
  'binary',
  'dmg',
  'exe',
  'appimage',
  'deb',
  'other',
] as const
export const THEME_SOURCES = ['system', 'light', 'dark'] as const
export const LANGUAGE_COUNT_BUCKETS = ['1', '2', '3+'] as const

// Workload (what the agent and the app are busy with).
export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21+'] as const
export const TOOL_CATEGORIES = ['none', 'read', 'edit', 'shell', 'search', 'web', 'mcp', 'agent', 'other'] as const
/** infobuff's error classes (`infobuff/src/facts/extractors.ts`), plus `none` and `other` */
export const ERROR_CLASSES = [
  'none',
  'module-not-found',
  'file-not-found',
  'oom',
  'type-error',
  'timeout',
  'permission-denied',
  'auth-failed',
  'connection-refused',
  'null-reference',
  'syntax-error',
  'rate-limited',
  'assertion-failed',
  'segfault',
  'disk-full',
  'certificate',
  'port-in-use',
  'version-conflict',
  'not-found',
  'other',
] as const

// Network.
export const TTFT_BUCKETS = ['<1s', '1-3s', '3-10s', '10s+'] as const
/** request latency in ms (ad fetch, image load) */
export const LATENCY_BUCKETS = ['<100', '100-300', '300-1000', '1000+'] as const
export const JITTER_BUCKETS = ['<10', '10-50', '50-150', '150+'] as const

// Terminal (CLI).
export const TERMINAL_ROW_BUCKETS = ['<24', '24-39', '40-59', '60+'] as const

// Web.
export const REFERRER_CLASSES = ['none', 'search', 'social', 'github', 'community', 'internal', 'other'] as const
export const UTM_SOURCES = [
  'none',
  'google',
  'reddit',
  'twitter',
  'hn',
  'github',
  'youtube',
  'newsletter',
  'discord',
  'linkedin',
  'other',
] as const

// Pointer and typing. Coarse buckets only: no raw keystroke timings or pointer paths ever leave the machine, so none
// of this can act as a behavioural-biometric identifier.
export const POINTER_SPEEDS = ['still', 'slow', 'fast'] as const
/** pixels */
export const DISTANCE_BUCKETS = ['<50', '50-200', '200-500', '500+'] as const
/** words per minute over the recent typing window */
export const TYPING_SPEEDS = ['none', 'slow', 'medium', 'fast'] as const
export const TYPING_RHYTHMS = ['steady', 'bursty'] as const
/** deletions as a share of keystrokes */
export const EDIT_RATIO_BUCKETS = ['<5%', '5-15%', '15-30%', '30%+'] as const

/** rendered ad card size, CSS pixels */
export const CARD_DIMENSION_BUCKETS = ['<120', '120-300', '300-600', '600+'] as const

/**
 * Developer-tool vendors whose adoption after a click is recorded (`postClick.packageInstalled` / `mcpAdded`). A
 * package or MCP server outside this list is never reported, only whether it matched the clicked ad's vendor.
 */
export const AD_VENDORS = [
  'supabase',
  'stripe',
  'vercel',
  'netlify',
  'cloudflare',
  'sentry',
  'clerk',
  'auth0',
  'resend',
  'posthog',
  'neon',
  'planetscale',
  'prisma',
  'convex',
  'upstash',
  'mongodb',
  'firebase',
  'openai',
  'anthropic',
  'datadog',
  'railway',
  'render',
  'fly',
  'algolia',
  'twilio',
  'linear',
  'github',
  'greptile',
  'coderabbit',
  'infisical',
] as const
export type AdVendor = (typeof AD_VENDORS)[number]

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
      minimized: z.boolean(),
      scale: z.enum(DISPLAY_SCALE_BUCKETS),
      zoom: z.enum(ZOOM_BUCKETS),
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
      thermal: z.enum(THERMAL_STATES),
      uptime: z.enum(UPTIME_BUCKETS),
      load: z.enum(LOAD_BUCKETS),
      freeMemory: z.enum(FREE_MEMORY_BUCKETS),
      cores: z.enum(CORE_BUCKETS),
      cpu: z.enum(CPU_FAMILIES),
      /** vendor class only, never the renderer string */
      gpu: z.enum(GPU_VENDORS),
      diskFree: z.enum(DISK_FREE_BUCKETS),
      /** the user's login shell (Desktop); the CLI reports its own under term.shell */
      shell: z.enum(SHELLS),
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
      /** pointer speed over the last ~2s */
      pointerSpeed: z.enum(POINTER_SPEEDS),
      /** the pointer's recent movement heads toward the ad slot */
      pointerTowardSlot: z.boolean(),
      /** pointer distance to the ad slot when the request is made */
      pointerDistance: z.enum(DISTANCE_BUCKETS),
      typingSpeed: z.enum(TYPING_SPEEDS),
      typingRhythm: z.enum(TYPING_RHYTHMS),
      editRatio: z.enum(EDIT_RATIO_BUCKETS),
    })
    .partial()
    .optional(),
  sess: z
    .object({
      turnIndex: z.enum(TURN_INDEX_BUCKETS),
      adsThisSession: z.enum(ADS_SESSION_BUCKETS),
      /** Fills received, distinct from ads actually viewed. */
      adsServedThisSession: z.enum(ADS_SESSION_BUCKETS),
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
      jitter: z.enum(JITTER_BUCKETS),
      offlineFlaps: z.enum(COUNT_BUCKETS),
      failedRequests: z.enum(COUNT_BUCKETS),
      /** the current (or last) agent turn's time to first token */
      ttft: z.enum(TTFT_BUCKETS),
      /** how long the previous ad request on this surface took */
      adFetch: z.enum(LATENCY_BUCKETS),
    })
    .partial()
    .optional(),
  /** Desktop and CLI */
  app: z
    .object({
      uptime: z.enum(UPTIME_BUCKETS),
      installAge: z.enum(INSTALL_AGE_BUCKETS),
      channel: z.enum(RELEASE_CHANNELS),
      launchAtLogin: z.boolean(),
      /** lives in the tray / menu bar rather than the dock */
      tray: z.boolean(),
      sinceResume: since,
      installMethod: z.enum(INSTALL_METHODS),
      /** runtime major.minor, e.g. `bun-1.3` */
      runtime: z.string().regex(/^[a-z]+-\d{1,3}\.\d{1,3}$/),
    })
    .partial()
    .optional(),
  /** Desktop, web and CLI */
  ui: z
    .object({
      theme: z.enum(THEME_SOURCES),
      reducedMotion: z.boolean(),
      highContrast: z.boolean(),
      /** primary language only (ISO 639 code), never the full preference list */
      language: z.string().regex(/^[a-z]{2,3}$/),
      languageCount: z.enum(LANGUAGE_COUNT_BUCKETS),
    })
    .partial()
    .optional(),
  /** Desktop and CLI */
  work: z
    .object({
      projects: z.enum(COUNT_BUCKETS),
      threads: z.enum(COUNT_BUCKETS),
      queued: z.enum(COUNT_BUCKETS),
      missionRunning: z.boolean(),
      tool: z.enum(TOOL_CATEGORIES),
      lastError: z.enum(ERROR_CLASSES),
      /** failed turns in the last hour */
      turnFailures: z.enum(COUNT_BUCKETS),
      skills: z.enum(COUNT_BUCKETS),
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
      rows: z.enum(TERMINAL_ROW_BUCKETS),
      utf8: z.boolean(),
      /** an HTTP(S)_PROXY is configured: corporate network or a sandbox */
      proxy: z.boolean(),
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
      /** installed as an app (display-mode standalone) */
      standalone: z.boolean(),
      /** the session's entry referrer, classified; never the URL */
      referrer: z.enum(REFERRER_CLASSES),
      utm: z.enum(UTM_SOURCES),
      cookies: z.boolean(),
      /** navigator.webdriver: an automated browser */
      webdriver: z.boolean(),
      doNotTrack: z.boolean(),
      zoom: z.enum(ZOOM_BUCKETS),
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
  imageLoadMs: ms.optional(),
  /** visible time while the user was idle (no input for 30s+): seen-but-unattended exposure */
  idleVisibleMs: ms.optional(),
  /** times the ad re-entered the viewport after leaving it */
  reentries: count.optional(),
  /**
   * keystrokes while the ad was visible, BUCKETED: an exact count beside the exposure's own `visibleMs` would be a
   * typing-rate measurement finer than `attn.typingSpeed`, so only the coarse bucket is accepted
   */
  keysDuringExposure: z.enum(COUNT_BUCKETS).optional(),
  /** closest the pointer came to the ad without being over it */
  closestPointer: z.enum(DISTANCE_BUCKETS).optional(),
  cardWidth: z.enum(CARD_DIMENSION_BUCKETS).optional(),
  cardHeight: z.enum(CARD_DIMENSION_BUCKETS).optional(),
  /** ms from first visible to the user dismissing the ad, when they did */
  dismissMs: ms.optional(),
  /** Explicit user dismissal, rather than rotation or unmount. */
  dismissed: z.boolean().optional(),
  /** the user copied text from the ad */
  copied: z.boolean().optional(),
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
      /** Install command observed within the adoption window; not proof of successful installation. */
      packageInstalled: z.boolean(),
      /** within the adoption window after the click, the user added an MCP server of the clicked ad's vendor */
      mcpAdded: z.boolean(),
      /** ms from the click to the first adoption signal */
      adoptedAtMs: ms,
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

// ---- wave 2 helpers: one place for every bucket edge, so Desktop, CLI and web can never disagree ----

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export function bucketUptime(ms: number): (typeof UPTIME_BUCKETS)[number] {
  if (ms < HOUR_MS) return '<1h'
  if (ms < 8 * HOUR_MS) return '1-8h'
  if (ms < DAY_MS) return '8-24h'
  if (ms < 7 * DAY_MS) return '1-7d'
  return '7d+'
}

/** `load1` is the 1-minute load average; normalised by core count so a 16-core machine at load 8 is "medium". */
export function bucketLoad(load1: number, cores: number): (typeof LOAD_BUCKETS)[number] {
  const perCore = load1 / Math.max(1, cores)
  if (perCore < 0.5) return 'low'
  if (perCore < 1) return 'medium'
  return 'high'
}

export function bucketFreeMemory(freeBytes: number, totalBytes: number): (typeof FREE_MEMORY_BUCKETS)[number] {
  const share = totalBytes > 0 ? freeBytes / totalBytes : 0
  if (share < 0.1) return '<10%'
  if (share < 0.25) return '10-25%'
  if (share < 0.5) return '25-50%'
  return '50%+'
}

export function bucketCores(cores: number): (typeof CORE_BUCKETS)[number] {
  if (cores <= 4) return '<=4'
  if (cores <= 8) return '5-8'
  if (cores <= 12) return '9-12'
  return '13+'
}

/** Maps an `os.cpus()[0].model` string to a family; the string itself never leaves the machine. */
export function cpuFamilyOf(model: string): (typeof CPU_FAMILIES)[number] {
  const m = model.toLowerCase()
  const apple = /apple\s+m(\d)/.exec(m)
  if (apple) {
    const generation = `apple_m${apple[1]}`
    return (CPU_FAMILIES as readonly string[]).includes(generation)
      ? (generation as (typeof CPU_FAMILIES)[number])
      : 'apple_other'
  }
  if (m.includes('apple')) return 'apple_other'
  if (m.includes('intel')) return 'intel'
  if (m.includes('amd') || m.includes('ryzen') || m.includes('epyc')) return 'amd'
  if (m.includes('snapdragon') || m.includes('qualcomm') || m.includes('oryon')) return 'qualcomm'
  return 'other'
}

/** Maps a GPU vendor or renderer string to a vendor class; the string itself never leaves the machine. */
export function gpuVendorOf(identifier: string): (typeof GPU_VENDORS)[number] {
  const g = identifier.toLowerCase()
  if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(g)) return 'software'
  // PCI vendor ids as Electron's `getGPUInfo('basic')` reports them: 0x106b Apple, 0x5143 Qualcomm
  if (g.includes('apple') || g.includes('0x106b')) return 'apple'
  if (g.includes('nvidia') || g.includes('geforce') || g.includes('quadro') || g.includes('0x10de')) return 'nvidia'
  if (g.includes('amd') || g.includes('radeon') || g.includes('0x1002')) return 'amd'
  if (g.includes('intel') || g.includes('0x8086')) return 'intel'
  if (g.includes('qualcomm') || g.includes('adreno') || g.includes('0x5143')) return 'qualcomm'
  return 'other'
}

export function bucketDiskFree(freeBytes: number): (typeof DISK_FREE_BUCKETS)[number] {
  const gb = freeBytes / 1e9
  if (gb < 10) return '<10'
  if (gb < 50) return '10-50'
  if (gb < 200) return '50-200'
  return '200+'
}

export function bucketDisplayScale(scaleFactor: number): (typeof DISPLAY_SCALE_BUCKETS)[number] {
  if (scaleFactor < 1.125) return '1'
  if (scaleFactor < 1.875) return '1.25-1.75'
  if (scaleFactor < 2.25) return '2'
  return '2.5+'
}

export function bucketZoom(percent: number): (typeof ZOOM_BUCKETS)[number] {
  if (percent < 90) return '<90'
  if (percent <= 110) return '90-110'
  if (percent <= 150) return '110-150'
  return '150+'
}

export function bucketInstallAge(ms: number): (typeof INSTALL_AGE_BUCKETS)[number] {
  if (ms < DAY_MS) return '<1d'
  if (ms < 7 * DAY_MS) return '1-7d'
  if (ms < 30 * DAY_MS) return '7-30d'
  if (ms < 90 * DAY_MS) return '30-90d'
  return '90d+'
}

export function bucketCount(n: number): (typeof COUNT_BUCKETS)[number] {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n <= 5) return '2-5'
  if (n <= 20) return '6-20'
  return '21+'
}

export function bucketTtft(ms: number): (typeof TTFT_BUCKETS)[number] {
  if (ms < 1_000) return '<1s'
  if (ms < 3_000) return '1-3s'
  if (ms < 10_000) return '3-10s'
  return '10s+'
}

export function bucketLatency(ms: number): (typeof LATENCY_BUCKETS)[number] {
  if (ms < 100) return '<100'
  if (ms < 300) return '100-300'
  if (ms < 1_000) return '300-1000'
  return '1000+'
}

/** Jitter as the mean absolute difference between consecutive RTT samples, in ms. */
export function bucketJitter(ms: number): (typeof JITTER_BUCKETS)[number] {
  if (ms < 10) return '<10'
  if (ms < 50) return '10-50'
  if (ms < 150) return '50-150'
  return '150+'
}

export function jitterOf(rttSamplesMs: readonly number[]): number | undefined {
  if (rttSamplesMs.length < 2) return undefined
  let sum = 0
  for (let i = 1; i < rttSamplesMs.length; i++) sum += Math.abs(rttSamplesMs[i]! - rttSamplesMs[i - 1]!)
  return sum / (rttSamplesMs.length - 1)
}

export function bucketTerminalRows(rows: number): (typeof TERMINAL_ROW_BUCKETS)[number] {
  if (rows < 24) return '<24'
  if (rows < 40) return '24-39'
  if (rows < 60) return '40-59'
  return '60+'
}

export function bucketDistance(px: number): (typeof DISTANCE_BUCKETS)[number] {
  if (px < 50) return '<50'
  if (px < 200) return '50-200'
  if (px < 500) return '200-500'
  return '500+'
}

/** Pointer speed in px/s over the recent window. */
export function bucketPointerSpeed(pxPerSecond: number): (typeof POINTER_SPEEDS)[number] {
  if (pxPerSecond < 20) return 'still'
  if (pxPerSecond < 600) return 'slow'
  return 'fast'
}

export function bucketTypingSpeed(wordsPerMinute: number | undefined): (typeof TYPING_SPEEDS)[number] {
  if (wordsPerMinute === undefined || wordsPerMinute <= 0) return 'none'
  if (wordsPerMinute < 20) return 'slow'
  if (wordsPerMinute < 50) return 'medium'
  return 'fast'
}

/**
 * Burstiness from inter-key gaps: bursty when the gaps vary a lot relative to their mean (coefficient of variation
 * above 1). Only the bucket leaves the machine, never the gaps.
 */
export function typingRhythmOf(interKeyGapsMs: readonly number[]): (typeof TYPING_RHYTHMS)[number] | undefined {
  if (interKeyGapsMs.length < 5) return undefined
  const mean = interKeyGapsMs.reduce((a, b) => a + b, 0) / interKeyGapsMs.length
  if (mean <= 0) return undefined
  const variance = interKeyGapsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / interKeyGapsMs.length
  return Math.sqrt(variance) / mean > 1 ? 'bursty' : 'steady'
}

export function bucketEditRatio(deletions: number, keystrokes: number): (typeof EDIT_RATIO_BUCKETS)[number] {
  const share = keystrokes > 0 ? deletions / keystrokes : 0
  if (share < 0.05) return '<5%'
  if (share < 0.15) return '5-15%'
  if (share < 0.3) return '15-30%'
  return '30%+'
}

export function bucketCardDimension(px: number): (typeof CARD_DIMENSION_BUCKETS)[number] {
  if (px < 120) return '<120'
  if (px < 300) return '120-300'
  if (px < 600) return '300-600'
  return '600+'
}

export function bucketLanguageCount(n: number): (typeof LANGUAGE_COUNT_BUCKETS)[number] {
  if (n <= 1) return '1'
  if (n === 2) return '2'
  return '3+'
}

/** `en-US` / `en_US.UTF-8` / `pt-BR` → `en` / `en` / `pt`; anything else → undefined. */
export function primaryLanguageOf(locale: string | undefined): string | undefined {
  const match = /^([a-zA-Z]{2,3})(?:[-_.@]|$)/.exec(locale ?? '')
  return match ? match[1]!.toLowerCase() : undefined
}

const SEARCH_DOMAINS = [
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'baidu.com',
  'yandex.com',
  'yandex.ru',
  'ecosia.org',
  'search.brave.com',
  'kagi.com',
  'perplexity.ai',
]
const SOCIAL_DOMAINS = [
  'twitter.com',
  'x.com',
  't.co',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'lnkd.in',
  'reddit.com',
  'youtube.com',
  'threads.net',
  'bsky.app',
  'tiktok.com',
]
const COMMUNITY_DOMAINS = [
  'news.ycombinator.com',
  'producthunt.com',
  'discord.com',
  'discord.gg',
  'dev.to',
  'hashnode.com',
  'medium.com',
  'substack.com',
  'stackoverflow.com',
  'lobste.rs',
]

function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/** Classifies a referrer URL; the URL itself never leaves the browser. */
export function referrerClassOf(
  referrer: string | undefined,
  ownHost: string,
): (typeof REFERRER_CLASSES)[number] {
  if (!referrer) return 'none'
  let host: string
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'other'
  }
  const own = ownHost.toLowerCase().replace(/^www\./, '')
  if (host === own || host.endsWith(`.${own}`)) return 'internal'
  if (hostMatches(host, ['github.com', 'github.io'])) return 'github'
  // google.co.uk, google.de, ...: any google.<tld>
  if (hostMatches(host, SEARCH_DOMAINS) || /(^|\.)google\.[a-z.]+$/.test(host)) return 'search'
  if (hostMatches(host, SOCIAL_DOMAINS)) return 'social'
  if (hostMatches(host, COMMUNITY_DOMAINS)) return 'community'
  return 'other'
}

/** Classifies a raw `utm_source`; the raw value never leaves the browser. */
export function utmSourceOf(raw: string | null | undefined): (typeof UTM_SOURCES)[number] {
  const s = (raw ?? '').toLowerCase().trim()
  if (!s) return 'none'
  if (s.includes('google')) return 'google'
  if (s.includes('reddit')) return 'reddit'
  if (s === 'x' || s.includes('twitter')) return 'twitter'
  if (s === 'hn' || s.includes('hackernews') || s.includes('ycombinator')) return 'hn'
  if (s.includes('github')) return 'github'
  if (s.includes('youtube')) return 'youtube'
  if (s.includes('newsletter') || s.includes('email')) return 'newsletter'
  if (s.includes('discord')) return 'discord'
  if (s.includes('linkedin')) return 'linkedin'
  return 'other'
}

/** Maps a tool name or tool call kind to a coarse category. */
export function toolCategoryOf(toolName: string | undefined): (typeof TOOL_CATEGORIES)[number] {
  const t = (toolName ?? '').toLowerCase()
  if (!t) return 'none'
  if (/(^|_)(read|view|cat|list|ls|glob|open)/.test(t)) return 'read'
  if (/(write|edit|patch|replace|create|str_replace|apply)/.test(t)) return 'edit'
  if (/(shell|bash|terminal|run_|exec|command)/.test(t)) return 'shell'
  if (/(web|fetch|browse|http|url)/.test(t)) return 'web'
  if (/(grep|search|find|code_search)/.test(t)) return 'search'
  if (t.startsWith('mcp') || t.includes('__')) return 'mcp'
  if (/(spawn|agent|task|subagent)/.test(t)) return 'agent'
  return 'other'
}

const VENDOR_DOMAINS: Readonly<Record<AdVendor, readonly string[]>> = {
  supabase: ['supabase.com', 'supabase.co'],
  stripe: ['stripe.com'],
  vercel: ['vercel.com'],
  netlify: ['netlify.com'],
  cloudflare: ['cloudflare.com'],
  sentry: ['sentry.io'],
  clerk: ['clerk.com', 'clerk.dev'],
  auth0: ['auth0.com'],
  resend: ['resend.com'],
  posthog: ['posthog.com'],
  neon: ['neon.tech', 'neon.com'],
  planetscale: ['planetscale.com'],
  prisma: ['prisma.io'],
  convex: ['convex.dev'],
  upstash: ['upstash.com'],
  mongodb: ['mongodb.com'],
  firebase: ['firebase.google.com', 'firebase.com'],
  openai: ['openai.com'],
  anthropic: ['anthropic.com', 'claude.com'],
  datadog: ['datadoghq.com'],
  railway: ['railway.app', 'railway.com'],
  render: ['render.com'],
  fly: ['fly.io'],
  algolia: ['algolia.com'],
  twilio: ['twilio.com'],
  linear: ['linear.app'],
  github: ['github.com'],
  greptile: ['greptile.com'],
  coderabbit: ['coderabbit.ai'],
  infisical: ['infisical.com'],
}

const VENDOR_PACKAGES: Readonly<Record<AdVendor, RegExp>> = {
  supabase: /^@supabase\/|^supabase$/,
  stripe: /^stripe$|^@stripe\//,
  vercel: /^vercel$|^@vercel\//,
  netlify: /^netlify(-cli)?$|^@netlify\//,
  cloudflare: /^wrangler$|^@cloudflare\//,
  sentry: /^@sentry\//,
  clerk: /^@clerk\//,
  auth0: /^auth0$|^@auth0\//,
  resend: /^resend$/,
  posthog: /^posthog-(js|node)$/,
  neon: /^@neondatabase\//,
  planetscale: /^@planetscale\//,
  prisma: /^prisma$|^@prisma\//,
  convex: /^convex$/,
  upstash: /^@upstash\//,
  mongodb: /^mongodb$|^mongoose$/,
  firebase: /^firebase(-admin|-tools)?$/,
  openai: /^openai$|^@openai\//,
  anthropic: /^@anthropic-ai\//,
  datadog: /^dd-trace$|^@datadog\//,
  railway: /^@railway\//,
  render: /^@render\//,
  fly: /^@flydotio\//,
  algolia: /^algoliasearch$|^@algolia\//,
  twilio: /^twilio$/,
  linear: /^@linear\//,
  github: /^@octokit\//,
  greptile: /^greptile$|^@greptile\//,
  coderabbit: /^coderabbit$|^@coderabbit\//,
  infisical: /^@infisical\//,
}

/** The vendor behind an ad's landing domain, if it is one we track adoption for. */
export function adVendorOfDomain(url: string | undefined): AdVendor | undefined {
  let host: string
  try {
    host = new URL(url ?? '').hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
  for (const vendor of AD_VENDORS) {
    if (VENDOR_DOMAINS[vendor].some((d) => host === d || host.endsWith(`.${d}`))) return vendor
  }
  return undefined
}

/** The vendor behind an npm package name, if it is one we track adoption for. */
export function adVendorOfPackage(name: string): AdVendor | undefined {
  const n = name.trim().toLowerCase().replace(/@[^/@]+$/, '')
  for (const vendor of AD_VENDORS) if (VENDOR_PACKAGES[vendor].test(n)) return vendor
  return undefined
}

/** The vendor behind an MCP server name, URL or command, if it is one we track adoption for. */
export function adVendorOfMcp(identifier: string): AdVendor | undefined {
  const s = identifier.toLowerCase()
  for (const vendor of AD_VENDORS) {
    if (s.includes(vendor) || VENDOR_DOMAINS[vendor].some((d) => s.includes(d))) return vendor
  }
  return undefined
}

// ---- wave 2 collector helpers: shared by Desktop, CLI and web so every surface reduces raw input the same way ----

/** A login shell path or name (`/bin/zsh`, `pwsh.exe`) to the closed shell vocabulary; the path never leaves. */
export function shellOf(pathOrName: string | undefined): (typeof SHELLS)[number] | undefined {
  if (!pathOrName || !pathOrName.trim()) return undefined
  const name = pathOrName
    .trim()
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
  switch (name) {
    case 'zsh':
    case 'bash':
    case 'fish':
    case 'nu':
    case 'pwsh':
      return name
    case 'powershell':
      return 'pwsh'
    default:
      return 'other'
  }
}

const RUNTIME_LABEL = /^[a-z]+-\d{1,3}\.\d{1,3}$/

/** `('bun', '1.3.2')` → `bun-1.3`; anything that would not fit `app.runtime` → undefined. */
export function runtimeLabelOf(name: string, version: string | undefined): string | undefined {
  const match = /^v?(\d{1,3})\.(\d{1,3})/.exec(version ?? '')
  if (!match) return undefined
  const label = `${name.toLowerCase()}-${match[1]}.${match[2]}`
  return RUNTIME_LABEL.test(label) ? label : undefined
}

/** `LANG` / `LC_ALL` / `LC_CTYPE` say UTF-8; undefined when none is set (unknown, e.g. Windows). */
export function utf8LocaleOf(env: Readonly<Record<string, string | undefined>>): boolean | undefined {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (!locale) return undefined
  return /utf-?8/i.test(locale)
}

/**
 * Error identifiers and phrases, a compact mirror of infobuff's `ERROR_PATTERNS`
 * (`infobuff/src/facts/extractors.ts`), first match wins. Like infobuff, the bare word "error" is deliberately absent.
 */
const ERROR_CLASS_PATTERNS: readonly [(typeof ERROR_CLASSES)[number], RegExp][] = [
  ['module-not-found', /\bModuleNotFoundError\b|\bERR_MODULE_NOT_FOUND\b|\bMODULE_NOT_FOUND\b|\bImportError\b|\bCannot find module\b|\bNo module named\b|\bcannot find package\b|\berror TS2307\b/i],
  ['file-not-found', /\bENOENT\b|\bFileNotFoundError\b|\bNo such file or directory\b/i],
  ['oom', /\bOutOfMemoryError\b|\bMemoryError\b|\bOOMKilled\b|\bstd::bad_alloc\b|JavaScript heap out of memory|\bCannot allocate memory\b|\bexit code 137\b/i],
  ['type-error', /\bTypeError\b|\bClassCastException\b|\bis not assignable to type\b|\bmismatched types\b/],
  ['timeout', /\bETIMEDOUT\b|\bTimeoutError\b|\bSocketTimeoutException\b|\bdeadline exceeded\b|\btimed out\b|\b504 Gateway Time-?out\b/i],
  ['permission-denied', /\bEACCES\b|\bEPERM\b|\bAccessDenied(?:Exception)?\b|\bPermission denied\b|\b403 Forbidden\b|\boperation not permitted\b/i],
  ['auth-failed', /\bAuthenticationError\b|\bUNAUTHENTICATED\b|\b401 Unauthorized\b|\b(?:invalid|incorrect) api key\b|\bauthentication failed\b/i],
  ['connection-refused', /\bECONNREFUSED\b|\bConnectionRefusedError\b|\bConnection refused\b|\bcould not connect to server\b/i],
  ['null-reference', /\bNullPointerException\b|Cannot read propert(?:y|ies) of (?:null|undefined)|\bNoneType\b|\bnil pointer dereference\b/i],
  ['syntax-error', /\bSyntaxError\b|\bIndentationError\b|\bParseError\b|\bUnexpected token\b|\bunexpected end of (?:file|input|JSON input)\b/i],
  ['rate-limited', /\bRateLimitError\b|\bThrottlingException\b|\b429 Too Many Requests\b|\brate limit (?:exceeded|reached)\b/i],
  ['assertion-failed', /\bAssertionError\b|\bassertion failed\b/i],
  ['segfault', /\bSIGSEGV\b|\bSegmentation fault\b/i],
  ['disk-full', /\bENOSPC\b|\bNo space left on device\b/i],
  ['certificate', /\bCERT_HAS_EXPIRED\b|\bCERTIFICATE_VERIFY_FAILED\b|\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b|\bSSLCertVerificationError\b|\bx509: certificate\b/],
  ['port-in-use', /\bEADDRINUSE\b|\baddress already in use\b|\bport \d+ is already (?:in use|allocated)\b/i],
  ['version-conflict', /\bERESOLVE\b|\bconflicting peer dependenc(?:y|ies)\b|\bcould not find a version that satisfies\b|\bversion solving failed\b/i],
  ['not-found', /\bNoSuchKey\b|\b(?:HTTP )?404 Not Found\b/i],
]

/** Only this much of an error's text is scanned, so classifying a huge tool output stays bounded. */
export const ERROR_CLASS_SCAN_CHARS = 4_096

/**
 * Classifies an error message or failed tool output. Runs on the client; only the class leaves the machine, never
 * the text. Empty input is `none`; text that names no known class is `other`.
 */
export function errorClassOf(text: string | undefined | null): (typeof ERROR_CLASSES)[number] {
  if (!text) return 'none'
  const scanned = text.length > ERROR_CLASS_SCAN_CHARS ? text.slice(0, ERROR_CLASS_SCAN_CHARS) : text
  for (const [cls, pattern] of ERROR_CLASS_PATTERNS) if (pattern.test(scanned)) return cls
  return 'other'
}

/** Typing is summarised over this trailing window. */
export const TYPING_WINDOW_MS = 60_000
/** Inter-key gaps longer than this are a pause, not part of the rhythm. */
const TYPING_GAP_CAP_MS = 10_000
const TYPING_MAX_SAMPLES = 512

export type TypingSummary = {
  typingSpeed: (typeof TYPING_SPEEDS)[number]
  typingRhythm?: (typeof TYPING_RHYTHMS)[number]
  editRatio?: (typeof EDIT_RATIO_BUCKETS)[number]
}

export interface TypingTracker {
  /** One keystroke. Records WHEN and whether it deleted, never WHICH key. */
  note(deletion: boolean): void
  summary(): TypingSummary
  /** Keystrokes since `sinceMs` (epoch), for `keysDuringExposure`. */
  countSince(sinceMs: number): number
}

/**
 * A bounded in-memory window of keystroke timestamps. Nothing in it leaves the process: callers read `summary()`
 * (three buckets) and `countSince()` (bucketed by the caller with `bucketCount`). Holds at most 512 samples, so a
 * stuck key cannot grow it, and every read is O(window).
 */
export function createTypingTracker(now: () => number = Date.now): TypingTracker {
  const at: number[] = []
  const deleted: boolean[] = []
  const prune = (t: number) => {
    let drop = 0
    while (drop < at.length && t - at[drop]! > TYPING_WINDOW_MS) drop++
    if (at.length - drop > TYPING_MAX_SAMPLES) drop = at.length - TYPING_MAX_SAMPLES
    if (drop > 0) {
      at.splice(0, drop)
      deleted.splice(0, drop)
    }
  }
  return {
    note(deletion) {
      const t = now()
      if (!Number.isFinite(t)) return
      at.push(t)
      deleted.push(deletion)
      prune(t)
    },
    summary() {
      prune(now())
      if (at.length === 0) return { typingSpeed: 'none' }
      const inserted = deleted.filter((d) => !d).length
      // words per minute over the fixed window: five characters a word
      const wpm = inserted / 5 / (TYPING_WINDOW_MS / 60_000)
      const gaps: number[] = []
      for (let i = 1; i < at.length; i++) {
        const gap = at[i]! - at[i - 1]!
        if (gap >= 0 && gap <= TYPING_GAP_CAP_MS) gaps.push(gap)
      }
      const rhythm = typingRhythmOf(gaps)
      return {
        typingSpeed: bucketTypingSpeed(wpm),
        ...(rhythm ? { typingRhythm: rhythm } : {}),
        editRatio: bucketEditRatio(at.length - inserted, at.length),
      }
    },
    countSince(sinceMs) {
      let n = 0
      for (let i = at.length - 1; i >= 0 && at[i]! >= sinceMs; i--) n++
      return n
    },
  }
}

export type RectLike = { left: number; top: number; right: number; bottom: number }

/** Distance from a point to a rectangle's nearest edge; 0 inside it. */
export function distanceToRect(x: number, y: number, rect: RectLike): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right)
  const dy = Math.max(rect.top - y, 0, y - rect.bottom)
  return Math.hypot(dx, dy)
}

/** Pointer movement is summarised over this trailing window. */
export const POINTER_WINDOW_MS = 2_000
const POINTER_MAX_SAMPLES = 64
/** The pointer must close at least this much distance on the slot to count as heading toward it. */
const POINTER_TOWARD_MIN_PX = 20

export type PointerSummary = {
  pointerSpeed: (typeof POINTER_SPEEDS)[number]
  pointerTowardSlot?: boolean
  pointerDistance?: (typeof DISTANCE_BUCKETS)[number]
}

export interface PointerTracker {
  /** One (already throttled) pointer position, in viewport CSS pixels. */
  note(x: number, y: number): void
  /** Buckets only; undefined until the pointer has moved at all. `slot` absent: only the speed is known. */
  summary(slot?: RectLike): PointerSummary | undefined
}

/**
 * A bounded window of the last ~2s of pointer positions, held in memory and never sent: `summary()` reduces it to a
 * speed bucket, a heading-toward-the-slot boolean and a distance bucket. No path, coordinate or timing leaves.
 */
export function createPointerTracker(now: () => number = Date.now): PointerTracker {
  const samples: { x: number; y: number; t: number }[] = []
  let everMoved = false
  const prune = (t: number) => {
    let drop = 0
    while (drop < samples.length && t - samples[drop]!.t > POINTER_WINDOW_MS) drop++
    if (samples.length - drop > POINTER_MAX_SAMPLES) drop = samples.length - POINTER_MAX_SAMPLES
    if (drop > 0) samples.splice(0, drop)
  }
  return {
    note(x, y) {
      const t = now()
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return
      everMoved = true
      samples.push({ x, y, t })
      prune(t)
    },
    summary(slot) {
      const t = now()
      // a pointer never seen (no mouse, or not yet moved) is unknown, not "still"
      if (!everMoved || !Number.isFinite(t)) return undefined
      prune(t)
      let path = 0
      for (let i = 1; i < samples.length; i++)
        path += Math.hypot(samples[i]!.x - samples[i - 1]!.x, samples[i]!.y - samples[i - 1]!.y)
      // speed over the whole window, so a pointer that stopped a second ago reads slower than one still moving
      const out: PointerSummary = { pointerSpeed: bucketPointerSpeed(path / (POINTER_WINDOW_MS / 1000)) }
      const last = samples[samples.length - 1]
      const first = samples[0]
      if (slot && last && first) {
        const end = distanceToRect(last.x, last.y, slot)
        out.pointerDistance = bucketDistance(end)
        out.pointerTowardSlot = distanceToRect(first.x, first.y, slot) - end >= POINTER_TOWARD_MIN_PX
      }
      return out
    },
  }
}
