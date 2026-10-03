/**
 * The CLI's ad client context (COD-757): what the terminal, the session and
 * the agent look like at the moment an ad is requested, as the closed
 * vocabulary of `@codebuff/common/types/ad-client-context`.
 *
 * TRAINING FEATURES ONLY. Nothing here may decide billing, invalid traffic or
 * eligibility: every field is client-reported. Nothing raw leaves the machine:
 * every value is a bucket or an enum by the time it is parsed, and an
 * environment variable is only ever read for presence or matched against a
 * fixed list.
 *
 * TOTAL. `buildCliAdClientContext` reads each source behind its own guard, so
 * a source that throws costs its own fields and nothing else; a context that
 * does not parse is no context, never a failed ad request. It is synchronous
 * and does no I/O after the first call (the static terminal facts are read
 * once and cached), so it cannot delay the auction.
 */
import { existsSync, promises as fsPromises } from 'fs'
import os from 'os'

import { env as buildEnv } from '@codebuff/common/env'
import {
  AD_CLIENT_CONTEXT_VERSION,
  bucketAdsThisSession,
  bucketArch,
  bucketCores,
  bucketCount,
  bucketDiskFree,
  bucketFreeMemory,
  bucketInstallAge,
  bucketJitter,
  bucketLanguageCount,
  bucketLatency,
  bucketLoad,
  bucketRam,
  bucketRtt,
  bucketSince,
  bucketTerminalColumns,
  bucketTerminalRows,
  bucketTtft,
  bucketTurnIndex,
  bucketUptime,
  cpuFamilyOf,
  jitterOf,
  parseAdClientContext,
  primaryLanguageOf,
  runtimeLabelOf,
  shellOf,
  utf8LocaleOf,
  type AdClientContext,
  type COLOR_DEPTHS,
  type IMAGE_PROTOCOLS,
  type INSTALL_METHODS,
  type MULTIPLEXERS,
  type RELEASE_CHANNELS,
  type REMOTE_KINDS,
  type SHELLS,
  type TERMINALS,
  type TypingSummary,
} from '@codebuff/common/types/ad-client-context'

import {
  ensureAdTerminalFocusWatch,
  getAdRendererFacts,
  getAdSessionSnapshot,
  getAdTerminalFocus,
  getAdTranscriptScrolledUp,
  getAdTurnStartedAt,
  getAdTypingSummary,
  getAdWorkSnapshot,
  type AdSessionSnapshot,
  type AdWorkSnapshot,
} from './ad-signals'
import { freebuffChatModel } from '../state/freebuff-chat-store'
import { getEffectiveFreebuffReasoningEffort } from '../state/freebuff-model-store'
import { useChatStore } from '../state/chat-store'
import { getIdleTime } from '../utils/activity-tracker'
import { getConfigDir } from '../utils/config-dir'
import { IS_FREEBUFF } from '../utils/constants'
import { getSystemProcessEnv } from '../utils/env'
import { getAgentIdForMode } from '../utils/freebuff-agent-selection'
import { getSkillCount, isSkillRegistryLoaded } from '../utils/skill-registry'

type Terminal = (typeof TERMINALS)[number]
type Multiplexer = (typeof MULTIPLEXERS)[number]
type RemoteKind = (typeof REMOTE_KINDS)[number]
type ColorDepth = (typeof COLOR_DEPTHS)[number]
type ImageProtocol = (typeof IMAGE_PROTOCOLS)[number]
type Shell = (typeof SHELLS)[number]
type ReleaseChannel = (typeof RELEASE_CHANNELS)[number]
type InstallMethod = (typeof INSTALL_METHODS)[number]

/** Env is read for presence and fixed-list matches only; no value is sent. */
export type AdTermEnv = Readonly<Record<string, string | undefined>>

export interface AdTermHost {
  platform: string
  /** `os.release()`: WSL kernels carry `microsoft` in it. */
  release: string
  fileExists: (path: string) => boolean
}

/** The terminal facts that cannot change while the process runs. */
export type StaticTermFacts = {
  terminal: Terminal
  links?: boolean
  multiplexer: Multiplexer
  remote: RemoteKind
  colors?: ColorDepth
  images: ImageProtocol
  shell?: Shell
  /** The locale says UTF-8; absent when no locale variable is set. */
  utf8?: boolean
  /** A proxy variable is set: presence only, never its value. */
  proxy?: boolean
}

const set = (value: string | undefined): boolean =>
  typeof value === 'string' && value.length > 0

/** Inside a multiplexer `TERM_PROGRAM` names the multiplexer, so the emulator's own markers are the fallback. */
export function detectTerminal(env: AdTermEnv): Terminal {
  const program = (env.TERM_PROGRAM ?? '').trim().toLowerCase()
  const term = (env.TERM ?? '').toLowerCase()
  const isCursor =
    set(env.CURSOR_TRACE_ID) ||
    set(env.CURSOR_PORT) ||
    set(env.CURSOR) ||
    /cursor/i.test(env.VSCODE_GIT_ASKPASS_NODE ?? '')

  switch (program) {
    case 'iterm.app':
    case 'iterm2':
      return 'iterm'
    case 'apple_terminal':
      return 'apple_terminal'
    case 'ghostty':
      return 'ghostty'
    case 'wezterm':
      return 'wezterm'
    case 'kitty':
      return 'kitty'
    case 'alacritty':
      return 'alacritty'
    case 'warpterminal':
      return 'warp'
    case 'cursor':
      return 'cursor'
    case 'vscode':
      return isCursor ? 'cursor' : 'vscode'
  }
  if (/jetbrains/i.test(env.TERMINAL_EMULATOR ?? '')) return 'jetbrains'
  if (set(env.WT_SESSION)) return 'windows_terminal'
  if (set(env.GHOSTTY_RESOURCES_DIR) || term.includes('ghostty'))
    return 'ghostty'
  if (set(env.KITTY_WINDOW_ID) || term === 'xterm-kitty') return 'kitty'
  if (set(env.WEZTERM_PANE) || set(env.WEZTERM_EXECUTABLE)) return 'wezterm'
  if (
    set(env.ALACRITTY_WINDOW_ID) ||
    set(env.ALACRITTY_SOCKET) ||
    term === 'alacritty'
  )
    return 'alacritty'
  if (set(env.ITERM_SESSION_ID) || /^iterm2?$/i.test(env.LC_TERMINAL ?? ''))
    return 'iterm'
  if (set(env.WARP_IS_LOCAL_SHELL_SESSION)) return 'warp'
  if (isCursor) return 'cursor'
  if (set(env.VSCODE_PID) || set(env.VSCODE_GIT_IPC_HANDLE)) return 'vscode'
  return 'other'
}

export function detectMultiplexer(env: AdTermEnv): Multiplexer {
  if (set(env.TMUX)) return 'tmux'
  if (set(env.ZELLIJ) || set(env.ZELLIJ_SESSION_NAME)) return 'zellij'
  if (set(env.STY)) return 'screen'
  return 'none'
}

/**
 * Where the CLI runs relative to the user's browser. Most specific first: a
 * Codespace is also a container and is usually reached over ssh.
 */
export function detectRemote(env: AdTermEnv, host: AdTermHost): RemoteKind {
  if ((env.CODESPACES ?? '').toLowerCase() === 'true') return 'codespaces'
  if (set(env.GITPOD_WORKSPACE_ID)) return 'gitpod'
  if (set(env.SSH_CONNECTION) || set(env.SSH_CLIENT) || set(env.SSH_TTY))
    return 'ssh'
  if (
    set(env.WSL_DISTRO_NAME) ||
    set(env.WSL_INTEROP) ||
    (host.platform === 'linux' && /microsoft/i.test(host.release))
  )
    return 'wsl'
  if (
    (env.REMOTE_CONTAINERS ?? '').toLowerCase() === 'true' ||
    set(env.container) ||
    host.fileExists('/.dockerenv') ||
    host.fileExists('/run/.containerenv')
  )
    return 'container'
  return 'none'
}

/** Emulators that render OSC 8 hyperlinks. Absent here means unknown, not "no". */
const OSC8_LINKS: Partial<Record<Terminal, boolean>> = {
  iterm: true,
  ghostty: true,
  wezterm: true,
  kitty: true,
  alacritty: true,
  windows_terminal: true,
  vscode: true,
  cursor: true,
  apple_terminal: false,
}

/**
 * tmux and screen swallow OSC 8 unless the user has configured passthrough,
 * which nothing in the environment reveals, so they read as "no links". Zellij
 * passes them through in recent versions only: unknown.
 */
export function detectLinks(
  terminal: Terminal,
  multiplexer: Multiplexer,
): boolean | undefined {
  if (multiplexer === 'tmux' || multiplexer === 'screen') return false
  if (multiplexer === 'zellij') return undefined
  return OSC8_LINKS[terminal]
}

const TRUECOLOR_TERMINALS: ReadonlySet<Terminal> = new Set([
  'iterm',
  'ghostty',
  'wezterm',
  'kitty',
  'alacritty',
  'windows_terminal',
  'vscode',
  'cursor',
  'warp',
])

export function detectColors(
  env: AdTermEnv,
  terminal: Terminal,
  multiplexer: Multiplexer,
): ColorDepth | undefined {
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  const term = (env.TERM ?? '').toLowerCase()
  if (/truecolor|24bit|-direct/.test(term)) return 'truecolor'
  // A multiplexer re-renders everything through its own TERM, so the outer
  // emulator's depth says nothing about what reaches the screen.
  if (multiplexer === 'none') {
    if (terminal === 'apple_terminal') return '256'
    if (TRUECOLOR_TERMINALS.has(terminal)) return 'truecolor'
  }
  if (term.includes('256color')) return '256'
  if (term && term !== 'dumb') return '16'
  return undefined
}

/** The CLI's own image rule (`terminal-images.ts`); a multiplexer drops the escapes. */
export function detectImages(
  env: AdTermEnv,
  terminal: Terminal,
  multiplexer: Multiplexer,
): ImageProtocol {
  if (multiplexer !== 'none') return 'none'
  if (terminal === 'iterm') return 'iterm2'
  if (terminal === 'kitty') return 'kitty'
  if ((env.TERM ?? '').includes('sixel') || env.SIXEL_SUPPORT === 'true')
    return 'sixel'
  return 'none'
}

export function detectShell(env: AdTermEnv): Shell | undefined {
  return shellOf(env.SHELL)
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

/** Any proxy variable is set, in either case. Only presence is read. */
export function detectProxy(env: AdTermEnv): boolean {
  return PROXY_VARS.some((name) => set(env[name]))
}

export function detectStaticTermFacts(
  env: AdTermEnv,
  host: AdTermHost,
): StaticTermFacts {
  const terminal = detectTerminal(env)
  const multiplexer = detectMultiplexer(env)
  const facts: StaticTermFacts = {
    terminal,
    multiplexer,
    remote: detectRemote(env, host),
    images: detectImages(env, terminal, multiplexer),
  }
  const links = detectLinks(terminal, multiplexer)
  if (links !== undefined) facts.links = links
  const colors = detectColors(env, terminal, multiplexer)
  if (colors) facts.colors = colors
  const shell = detectShell(env)
  if (shell) facts.shell = shell
  const utf8 = utf8LocaleOf(env)
  if (utf8 !== undefined) facts.utf8 = utf8
  facts.proxy = detectProxy(env)
  return facts
}

let cachedStaticFacts: StaticTermFacts | null = null

function staticTermFacts(): StaticTermFacts {
  cachedStaticFacts ??= detectStaticTermFacts(getSystemProcessEnv(), {
    platform: process.platform,
    release: os.release(),
    fileExists: (path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    },
  })
  return cachedStaticFacts
}

/**
 * The OS major version, as a user would name it: the same mapping Desktop uses
 * (Darwin 20-24 are macOS 11-15, Darwin 25 is macOS 26, earlier is 10.x).
 */
export function osMajorOf(
  platform: string,
  release: string,
): string | undefined {
  const major = Number.parseInt(release.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major < 0) return undefined
  if (platform === 'darwin') {
    if (major >= 25) return String(major + 1)
    if (major >= 20) return String(major - 9)
    return '10'
  }
  return String(major)
}

export function median(values: readonly number[]): number | undefined {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return undefined
  const sorted = [...finite].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * The user's primary UI language and how many they listed, from the POSIX
 * locale variables in gettext's order (`LANGUAGE` is a colon list). Only the
 * ISO 639 code leaves; `C`/`POSIX` and anything unparseable are unknown.
 */
export function localeLanguagesOf(env: AdTermEnv): {
  language?: string
  languageCount?: number
} {
  const list = (env.LANGUAGE ?? '')
    .split(':')
    .map((entry) => primaryLanguageOf(entry))
    .filter((code): code is string => code !== undefined)
  const fallback = primaryLanguageOf(
    env.LC_ALL || env.LC_MESSAGES || env.LANG || undefined,
  )
  const language = list[0] ?? fallback
  if (!language) return {}
  const distinct = new Set(list.length > 0 ? list : [language])
  return { language, languageCount: distinct.size }
}

/** The build's environment as a release channel. */
export function releaseChannelOf(
  environment: string | undefined,
): ReleaseChannel {
  if (environment === 'prod') return 'stable'
  if (environment === 'dev') return 'dev'
  return 'other'
}

/**
 * How this CLI was installed, from the package manager that launched it
 * (`npm_config_user_agent`, set by npm/npx/bunx/pnpm/yarn exec), else the
 * path the shell ran (`_`), read only against fixed patterns. The npm
 * wrapper marks its child with `CODEBUFF_LAUNCHER_PID`; a compiled binary
 * started without it was run directly.
 */
export function installMethodOf(
  env: AdTermEnv,
  host: { isBinary: boolean },
): InstallMethod {
  const agent = (env.npm_config_user_agent ?? '').toLowerCase()
  if (agent.startsWith('npm/'))
    return env.npm_command === 'exec' ? 'npx' : 'npm'
  if (agent.startsWith('bun/')) return 'bun'
  if (agent.startsWith('pnpm/')) return 'pnpm'
  if (agent.startsWith('yarn/')) return 'yarn'
  if (set(env.CODEBUFF_LAUNCHER_PID)) {
    const invoked = (env._ ?? '').toLowerCase()
    if (/[\\/]\.bun[\\/]/.test(invoked)) return 'bun'
    if (/pnpm/.test(invoked)) return 'pnpm'
    if (/yarn/.test(invoked)) return 'yarn'
    if (/[\\/]cellar[\\/]/.test(invoked)) return 'brew'
    if (/node_modules|[\\/]npm[\\/]|nvm|fnm|volta|[\\/]node[\\/]/.test(invoked))
      return 'npm'
    return 'other'
  }
  return host.isBinary ? 'binary' : 'other'
}

/**
 * A value read asynchronously, at most once per `ttlMs`, and NEVER awaited by
 * a reader: `get()` answers from the cache (undefined until the first read
 * lands) and kicks a refresh when the value is missing or stale. A failed
 * read is cached as unknown for the same ttl, so a broken source is not
 * retried on every ad request.
 */
export function createLazyAsyncValue<T>(
  load: () => Promise<T | undefined>,
  ttlMs: number,
  now: () => number = Date.now,
): { get: () => T | undefined } {
  let value: T | undefined
  let readAt: number | null = null
  let inFlight = false
  return {
    get() {
      const t = now()
      if (!inFlight && (readAt === null || t - readAt >= ttlMs)) {
        inFlight = true
        let started: Promise<T | undefined>
        try {
          started = load()
        } catch {
          started = Promise.resolve(undefined)
        }
        void started
          .then(
            (next) => {
              value = next
            },
            () => {
              value = undefined
            },
          )
          .finally(() => {
            readAt = now()
            inFlight = false
          })
      }
      return value
    },
  }
}

/** Free disk is re-read at most this often. */
export const AD_DISK_FREE_TTL_MS = 10 * 60_000

/** Turn counting stops here: the top bucket is `21+`. */
export const AD_TURN_INDEX_READ_CAP = 21
const AGENT_LABEL_MAX = 64

export type AdContextSystem = {
  platform: string
  release: string
  arch: string
  totalmem: number
  /** `os.uptime()`, seconds */
  uptimeSec?: number
  /** `os.loadavg()[0]` */
  load1?: number
  freemem?: number
  cores?: number
  /** `os.cpus()[0].model`: reduced to a family, never sent */
  cpuModel?: string
  /** from the lazy cache; absent until the first read lands */
  diskFreeBytes?: number
}

export type AdContextApp = {
  uptimeMs?: number
  installAgeMs?: number
  channel?: ReleaseChannel
  installMethod?: InstallMethod
  /** e.g. `bun-1.3` */
  runtime?: string
}

export type AdContextWork = AdWorkSnapshot & {
  /** Loaded skills; null while the registry has not loaded. */
  skills?: number | null
}

export type AdContextAgent = {
  mode?: string | null
  model?: string | null
  harness?: string | null
  effort?: string | null
}

/** Every accessor may throw or return null; either costs only the fields it feeds. */
export interface CliAdContextSources {
  now: () => number
  term?: () => StaticTermFacts | null
  cols?: () => number | null
  mouse?: () => boolean | null
  /** Terminal focus from DEC 1004 reports; null/undefined until one arrived. */
  focused?: () => boolean | null | undefined
  /** ms since the last keypress/mouse/paste. */
  idleMs?: () => number | null
  turnRunning?: () => boolean | null
  /** When the running turn started, on the `now` clock; null when unknown. */
  turnStartedAt?: () => number | null
  scrolledUp?: () => boolean | null
  pendingPrompt?: () => boolean | null
  userTurnCount?: () => number | null
  session?: () => AdSessionSnapshot | null
  agent?: () => AdContextAgent | null
  system?: () => AdContextSystem | null
  /** The renderer's height in rows. */
  rows?: () => number | null
  app?: () => AdContextApp | null
  /** The POSIX locale variables; reduced to an ISO 639 code and a count. */
  localeEnv?: () => AdTermEnv | null
  work?: () => AdContextWork | null
  /** null until the composer has seen a keystroke. */
  typing?: () => TypingSummary | null
}

const read = <T>(
  fn: (() => T | null | undefined) | undefined,
): T | undefined => {
  if (!fn) return undefined
  try {
    const value = fn()
    return value ?? undefined
  } catch {
    return undefined
  }
}

const label = (value: string | null | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, AGENT_LABEL_MAX)
  return trimmed.length > 0 ? trimmed : undefined
}

/** Drops undefined values, and the whole section when nothing is left. */
function section<T extends Record<string, unknown>>(
  value: T,
): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return entries.length > 0
    ? (Object.fromEntries(entries) as Partial<T>)
    : undefined
}

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const positive = (value: unknown): number | undefined => {
  const n = finite(value)
  return n !== undefined && n > 0 ? n : undefined
}

function typingFields(
  typing: TypingSummary | undefined,
): Partial<TypingSummary> {
  if (!typing) return {}
  return {
    typingSpeed: typing.typingSpeed,
    typingRhythm: typing.typingRhythm,
    editRatio: typing.editRatio,
  }
}

function systemSection(system: AdContextSystem) {
  const cores = positive(system.cores)
  const load1 = finite(system.load1)
  const total = positive(system.totalmem)
  const free = finite(system.freemem)
  const uptime = finite(system.uptimeSec)
  const disk = finite(system.diskFreeBytes)
  return section({
    osMajor: osMajorOf(system.platform, system.release),
    arch: bucketArch(system.arch),
    ram: total !== undefined ? bucketRam(total) : undefined,
    uptime: uptime !== undefined && uptime >= 0 ? bucketUptime(uptime * 1000) : undefined,
    // Windows has no load average: os.loadavg() is always [0, 0, 0] there.
    load:
      system.platform !== 'win32' && load1 !== undefined && load1 >= 0 && cores
        ? bucketLoad(load1, cores)
        : undefined,
    freeMemory:
      free !== undefined && free >= 0 && total !== undefined
        ? bucketFreeMemory(free, total)
        : undefined,
    cores: cores !== undefined ? bucketCores(cores) : undefined,
    cpu: system.cpuModel ? cpuFamilyOf(system.cpuModel) : undefined,
    diskFree: disk !== undefined && disk >= 0 ? bucketDiskFree(disk) : undefined,
  })
}

const RUNTIME_LABEL = /^[a-z]+-\d{1,3}\.\d{1,3}$/

function appSection(app: AdContextApp) {
  const uptime = finite(app.uptimeMs)
  const installAge = finite(app.installAgeMs)
  return section({
    uptime: uptime !== undefined && uptime >= 0 ? bucketUptime(uptime) : undefined,
    installAge:
      installAge !== undefined && installAge >= 0
        ? bucketInstallAge(installAge)
        : undefined,
    channel: app.channel,
    installMethod: app.installMethod,
    // re-checked so one malformed label costs its field, not the context
    runtime:
      app.runtime && RUNTIME_LABEL.test(app.runtime) ? app.runtime : undefined,
  })
}

function workSection(work: AdContextWork) {
  const queued = finite(work.queued)
  const failures = finite(work.turnFailuresLastHour)
  const skills = finite(work.skills)
  return section({
    queued: queued !== undefined ? bucketCount(queued) : undefined,
    // Every tool call this process runs passes the event handler, so none
    // seen yet is a known `none`.
    tool: work.tool ?? 'none',
    lastError: work.lastError,
    turnFailures: failures !== undefined ? bucketCount(failures) : undefined,
    skills: skills !== undefined ? bucketCount(skills) : undefined,
  })
}

/** Never throws; `undefined` when nothing parses. */
export function buildCliAdClientContext(
  sources: CliAdContextSources,
): AdClientContext | undefined {
  try {
    const now = sources.now()
    const term = read(sources.term)
    const cols = finite(read(sources.cols))
    const rows = finite(read(sources.rows))
    const termSection = section({
      ...(term ?? {}),
      cols:
        cols !== undefined && cols > 0
          ? bucketTerminalColumns(cols)
          : undefined,
      rows: rows !== undefined && rows > 0 ? bucketTerminalRows(rows) : undefined,
      mouse: bool(read(sources.mouse)),
      focused: bool(read(sources.focused)),
    })

    const idle = finite(read(sources.idleMs))
    const running = bool(read(sources.turnRunning))
    const startedAt = running ? finite(read(sources.turnStartedAt)) : undefined
    const session = read(sources.session)
    const attn = section({
      sinceInput: idle !== undefined ? bucketSince(idle) : undefined,
      sinceSend: session
        ? bucketSince(
            session.lastSendAt === null ? null : now - session.lastSendAt,
          )
        : undefined,
      turnRunning: running,
      // Only a running turn has an elapsed time; an idle one's is absent, not "never".
      turnElapsed:
        startedAt !== undefined ? bucketSince(now - startedAt) : undefined,
      pendingPrompt: bool(read(sources.pendingPrompt)),
      scrolledUp: bool(read(sources.scrolledUp)),
      ...typingFields(read(sources.typing)),
    })

    const turns = finite(read(sources.userTurnCount))
    const sess = section({
      // No user turn yet has no bucket (the lowest is `1`): unknown.
      turnIndex:
        turns !== undefined && turns >= 1 ? bucketTurnIndex(turns) : undefined,
      adsThisSession: session
        ? bucketAdsThisSession(session.adsServed)
        : undefined,
      sinceLastAd: session
        ? bucketSince(session.lastAdAt === null ? null : now - session.lastAdAt)
        : undefined,
      sinceLastClick: session
        ? bucketSince(
            session.lastClickAt === null ? null : now - session.lastClickAt,
          )
        : undefined,
    })

    const agentFacts = read(sources.agent)
    const agent = agentFacts
      ? section({
          mode: label(agentFacts.mode),
          model: label(agentFacts.model),
          harness: label(agentFacts.harness),
          effort: label(agentFacts.effort),
        })
      : undefined

    const system = read(sources.system)
    const sys = system ? systemSection(system) : undefined

    const rtt = session ? median(session.rttSamplesMs) : undefined
    const jitter = session ? jitterOf(session.rttSamplesMs) : undefined
    const failed = finite(session?.failedRequests)
    const ttft = finite(session?.lastTtftMs)
    const adFetch = finite(session?.lastAdFetchMs)
    const net = section({
      rtt: rtt !== undefined ? bucketRtt(rtt) : undefined,
      jitter:
        jitter !== undefined && Number.isFinite(jitter)
          ? bucketJitter(jitter)
          : undefined,
      failedRequests: failed !== undefined ? bucketCount(failed) : undefined,
      ttft: ttft !== undefined && ttft >= 0 ? bucketTtft(ttft) : undefined,
      adFetch:
        adFetch !== undefined && adFetch >= 0
          ? bucketLatency(adFetch)
          : undefined,
    })

    const appFacts = read(sources.app)
    const app = appFacts ? appSection(appFacts) : undefined

    const locale = read(sources.localeEnv)
    const languages = locale ? localeLanguagesOf(locale) : {}
    const ui = section({
      language: languages.language,
      languageCount:
        languages.languageCount !== undefined
          ? bucketLanguageCount(languages.languageCount)
          : undefined,
    })

    const workFacts = read(sources.work)
    const work = workFacts ? workSection(workFacts) : undefined

    const out: Record<string, unknown> = { v: AD_CLIENT_CONTEXT_VERSION }
    if (termSection) out.term = termSection
    if (attn) out.attn = attn
    if (sess) out.sess = sess
    if (agent) out.agent = agent
    if (sys) out.sys = sys
    if (net) out.net = net
    if (app) out.app = app
    if (ui) out.ui = ui
    if (work) out.work = work
    return parseAdClientContext(out)
  } catch {
    return undefined
  }
}

function countUserTurns(): number {
  let count = 0
  for (const message of useChatStore.getState().messages) {
    if (message.variant === 'user' && ++count >= AD_TURN_INDEX_READ_CAP) break
  }
  return count
}

function liveAgent(): AdContextAgent {
  const { agentMode } = useChatStore.getState()
  const agent: AdContextAgent = { mode: agentMode }
  try {
    agent.harness = getAgentIdForMode(agentMode)
  } catch {
    // unknown harness
  }
  // Codebuff's model is chosen per agent, not by the user, so only Freebuff
  // has a model (and an effort) to report.
  if (IS_FREEBUFF) {
    try {
      const model = freebuffChatModel()
      agent.model = model
      agent.effort = getEffectiveFreebuffReasoningEffort(model) ?? 'default'
    } catch {
      // unknown model
    }
  }
  return agent
}

type StaticSystemFacts = { cores?: number; cpuModel?: string }
let cachedSystemFacts: StaticSystemFacts | null = null

/** Core count and CPU model cannot change while the process runs. */
function staticSystemFacts(): StaticSystemFacts {
  if (cachedSystemFacts) return cachedSystemFacts
  const facts: StaticSystemFacts = {}
  try {
    const cpus = os.cpus()
    if (cpus.length > 0) facts.cores = cpus.length
    const model = cpus[0]?.model
    if (typeof model === 'string' && model) facts.cpuModel = model
  } catch {
    // unknown
  }
  cachedSystemFacts = facts
  return facts
}

const diskFree = createLazyAsyncValue<number>(async () => {
  if (typeof fsPromises.statfs !== 'function') return undefined
  const stats = await fsPromises.statfs(os.homedir())
  const bytes = Number(stats.bavail) * Number(stats.bsize)
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined
}, AD_DISK_FREE_TTL_MS)

/**
 * When the CLI's config directory was created: the first launch of any
 * Codebuff/Freebuff CLI on this account. Read once; a filesystem without
 * birth times (some Linux mounts report 0) is unknown.
 */
const configDirBirth = createLazyAsyncValue<number>(async () => {
  const stats = await fsPromises.stat(getConfigDir())
  return stats.birthtimeMs > 0 ? stats.birthtimeMs : undefined
}, Number.POSITIVE_INFINITY)

function liveSystem(): AdContextSystem {
  const system: AdContextSystem = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    totalmem: os.totalmem(),
    ...staticSystemFacts(),
  }
  try {
    system.uptimeSec = os.uptime()
    system.freemem = os.freemem()
    if (process.platform !== 'win32') system.load1 = os.loadavg()[0]
  } catch {
    // unknown
  }
  const disk = diskFree.get()
  if (disk !== undefined) system.diskFreeBytes = disk
  return system
}

let cachedInstallMethod: InstallMethod | null = null

function liveApp(): AdContextApp {
  cachedInstallMethod ??= installMethodOf(getSystemProcessEnv(), {
    isBinary: Boolean(getSystemProcessEnv().CODEBUFF_IS_BINARY),
  })
  const app: AdContextApp = {
    uptimeMs: process.uptime() * 1000,
    channel: releaseChannelOf(buildEnv.NEXT_PUBLIC_CB_ENVIRONMENT),
    installMethod: cachedInstallMethod,
  }
  const runtime = process.versions.bun
    ? runtimeLabelOf('bun', process.versions.bun)
    : runtimeLabelOf('node', process.versions.node)
  if (runtime) app.runtime = runtime
  const born = configDirBirth.get()
  if (born !== undefined) app.installAgeMs = Date.now() - born
  return app
}

function liveWork(): AdContextWork {
  return {
    ...getAdWorkSnapshot(),
    skills: isSkillRegistryLoaded() ? getSkillCount() : null,
  }
}

/** The live sources this process reads. */
export function liveCliAdContextSources(): CliAdContextSources {
  ensureAdTerminalFocusWatch()
  return {
    now: () => Date.now(),
    term: staticTermFacts,
    cols: () => getAdRendererFacts()?.width ?? process.stdout.columns ?? null,
    mouse: () => getAdRendererFacts()?.useMouse ?? null,
    focused: getAdTerminalFocus,
    idleMs: getIdleTime,
    turnRunning: () => useChatStore.getState().isChainInProgress,
    turnStartedAt: getAdTurnStartedAt,
    scrolledUp: getAdTranscriptScrolledUp,
    pendingPrompt: () => useChatStore.getState().askUserState !== null,
    userTurnCount: countUserTurns,
    session: getAdSessionSnapshot,
    agent: liveAgent,
    system: liveSystem,
    rows: () => getAdRendererFacts()?.height ?? process.stdout.rows ?? null,
    app: liveApp,
    localeEnv: getSystemProcessEnv,
    work: liveWork,
    typing: getAdTypingSummary,
  }
}

/** The context for an ad request being built right now. Never throws. */
export function collectCliAdClientContext(): AdClientContext | undefined {
  try {
    return buildCliAdClientContext(liveCliAdContextSources())
  } catch {
    return undefined
  }
}
