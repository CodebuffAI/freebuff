/**
 * Post-click adoption for CLI ads (COD-757 wave 2): after a click on an ad
 * whose landing domain belongs to a tracked developer-tool vendor, watch the
 * agent's shell commands for an install of that vendor's package, and report
 * the first match as a `postClick` merge record `{ packageInstalled: true,
 * adoptedAtMs }`.
 *
 * TRAINING FEATURES ONLY, and nothing raw leaves: the command is parsed here,
 * in memory, into package names that are only ever compared against the
 * clicked vendor. The record carries a boolean and a duration.
 *
 * Bounded: at most `ADOPTION_MAX_WATCHES` clicks are watched at once (oldest
 * dropped), each for at most `AD_MS_CAP` after its click, expired lazily on
 * the next event, so no timer runs.
 *
 * `mcpAdded` is never set on the CLI: its MCP servers come from `mcp.json`,
 * read once at launch behind the trust gate, and nothing at runtime adds one.
 */
import {
  AD_ENGAGEMENT_VERSION,
  AD_MS_CAP,
  adVendorOfDomain,
  adVendorOfPackage,
  clampMs,
  parseAdEngagement,
  type AdEngagement,
  type AdVendor,
} from '@codebuff/common/types/ad-client-context'

import type { EngagementStatus } from './ad-engagement'

/** Clicks watched at once; the oldest is dropped past this. */
export const ADOPTION_MAX_WATCHES = 8
/** Only this much of a command is parsed, so a giant heredoc stays cheap. */
const COMMAND_SCAN_CHARS = 4_096
const MAX_PACKAGES_PER_COMMAND = 64

const INSTALL_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['i', 'install', 'add', 'in', 'isntall']),
  bun: new Set(['add', 'a', 'i', 'install']),
  pnpm: new Set(['add', 'i', 'install']),
  yarn: new Set(['add']),
}

/** npm flags that take a value, so the value is not mistaken for a package. */
const FLAGS_WITH_VALUE = new Set([
  '--registry',
  '--prefix',
  '--cwd',
  '--filter',
  '-F',
  '-C',
  '--workspace',
  '-w',
  '--tag',
])

const stripQuotes = (token: string) => token.replace(/^['"]|['"]$/g, '')

/**
 * The package names an install command adds: `npm i/install`, `bun add`,
 * `pnpm add`, `yarn add`, in any `&&`/`;`/`|` chain. A bare `npm install`
 * (from the lockfile) adds nothing. Local paths, URLs and git specs are not
 * packages. Never throws.
 */
export function parseInstalledPackages(command: string): string[] {
  const out: string[] = []
  try {
    const scanned = command.slice(0, COMMAND_SCAN_CHARS)
    for (const segment of scanned.split(/&&|\|\||[;|\n]/)) {
      const tokens = segment.trim().split(/\s+/).map(stripQuotes)
      // skip env assignments and wrappers: `FOO=1 sudo npm i x`
      let i = 0
      while (
        i < tokens.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) ||
          tokens[i] === 'sudo' ||
          tokens[i] === 'env')
      )
        i++
      const manager = tokens[i]?.toLowerCase()
      const verbs = manager ? INSTALL_VERBS[manager] : undefined
      if (!verbs) continue
      // the verb is the first non-flag token after the manager
      let j = i + 1
      while (j < tokens.length && tokens[j]!.startsWith('-')) {
        if (FLAGS_WITH_VALUE.has(tokens[j]!)) j++
        j++
      }
      if (!verbs.has((tokens[j] ?? '').toLowerCase())) continue
      for (let k = j + 1; k < tokens.length; k++) {
        const token = tokens[k]!
        if (!token) continue
        if (token.startsWith('-')) {
          if (FLAGS_WITH_VALUE.has(token)) k++
          continue
        }
        // a redirect or anything shell-ish ends the argument list
        if (/^[<>&]|^\d?>/.test(token)) break
        if (/^[./~]|:\/\/|^(git|github|file|link|workspace):/.test(token))
          continue
        out.push(token)
        if (out.length >= MAX_PACKAGES_PER_COMMAND) return out
      }
    }
  } catch {
    // unparseable is nothing installed
  }
  return out
}

/** The tracked vendors a command installs a package of. */
export function vendorsInstalledBy(command: string): Set<AdVendor> {
  const vendors = new Set<AdVendor>()
  for (const name of parseInstalledPackages(command)) {
    const vendor = adVendorOfPackage(name)
    if (vendor) vendors.add(vendor)
  }
  return vendors
}

export interface AdoptionWatcherEnv {
  /** Monotonic ms. */
  now: () => number
  /** Fire-and-forget; receives only records that parse. */
  send: (record: AdEngagement) => void
  /**
   * Whether the impression's main engagement record is out. A merge record
   * is held while it is `live`, so the server sees the row it merges into
   * first; `unknown` (never tracked) sends at once, since no row is coming.
   */
  status?: (impUrl: string) => EngagementStatus
}

export interface AdoptionWatcher {
  /** A click on an ad whose landing page is `landingUrl`. */
  armClick(impUrl: string, landingUrl: string | undefined): void
  /** A shell command the agent is about to run. */
  agentCommand(command: string): void
  /** The impression's main record went out: release a held merge record. */
  mainRecordSent(impUrl: string): void
  readonly size: number
}

type Watch = {
  vendor: AdVendor
  clickAt: number
  /** a match is waiting for the main record */
  pending: AdEngagement | null
  adopted: boolean
}

export function createAdoptionWatcher(env: AdoptionWatcherEnv): AdoptionWatcher {
  const watches = new Map<string, Watch>()

  const emit = (record: AdEngagement) => {
    const parsed = parseAdEngagement(record)
    if (!parsed) return
    try {
      env.send(parsed)
    } catch {
      // a missing row, never a broken agent
    }
  }

  const expire = (t: number) => {
    for (const [impUrl, watch] of watches)
      if (t - watch.clickAt > AD_MS_CAP || (watch.adopted && !watch.pending))
        watches.delete(impUrl)
  }

  const trySend = (impUrl: string, watch: Watch) => {
    if (!watch.pending) return
    let status: EngagementStatus = 'unknown'
    try {
      status = env.status?.(impUrl) ?? 'unknown'
    } catch {
      status = 'unknown'
    }
    if (status === 'live') return
    const record = watch.pending
    watch.pending = null
    emit(record)
  }

  return {
    get size() {
      return watches.size
    },
    armClick(impUrl, landingUrl) {
      try {
        const vendor = adVendorOfDomain(landingUrl)
        if (!impUrl || !vendor) return
        const t = env.now()
        expire(t)
        // a second click on the same ad keeps the first click's clock
        if (watches.has(impUrl)) return
        if (watches.size >= ADOPTION_MAX_WATCHES) {
          const oldest = watches.keys().next().value
          if (oldest !== undefined) watches.delete(oldest)
        }
        watches.set(impUrl, { vendor, clickAt: t, pending: null, adopted: false })
      } catch {
        // never break a click
      }
    },
    agentCommand(command) {
      try {
        if (watches.size === 0) return
        const t = env.now()
        expire(t)
        if (watches.size === 0) return
        const vendors = vendorsInstalledBy(command)
        if (vendors.size === 0) return
        for (const [impUrl, watch] of watches) {
          if (watch.adopted || !vendors.has(watch.vendor)) continue
          watch.adopted = true
          watch.pending = {
            v: AD_ENGAGEMENT_VERSION,
            impUrl,
            postClick: {
              packageInstalled: true,
              adoptedAtMs: clampMs(t - watch.clickAt) ?? 0,
            },
          }
          trySend(impUrl, watch)
        }
        expire(t)
      } catch {
        // never break the agent's event stream
      }
    },
    mainRecordSent(impUrl) {
      const watch = watches.get(impUrl)
      if (!watch) return
      trySend(impUrl, watch)
      if (watch.adopted && !watch.pending) watches.delete(impUrl)
    },
  }
}
