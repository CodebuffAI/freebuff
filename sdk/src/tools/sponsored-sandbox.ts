/**
 * OS containment for a sponsored run executing on the user's own machine.
 *
 * COD-336's mechanism. Promoted here out of `evals/sponsored/sandbox.ts`,
 * which is where it was first written and proven, because it is now a
 * production boundary rather than an eval harness: Desktop (COD-397) and the
 * CLI (COD-339) both run advertiser-authored procedures locally, and both need
 * exactly this. The eval keeps its own env scrub and its own sandboxed write
 * worker and delegates the containment below, so there is ONE seatbelt profile
 * and ONE bubblewrap argument list in the repository.
 *
 * ## Why it lives behind `TerminalCommandBroker`
 *
 * `sandbox-exec` has printed a deprecation warning for years and Apple ships
 * no replacement for third-party process confinement. The day it is removed,
 * the macOS arm of this is gone. Sitting behind the SDK's existing broker seam
 * (`run-terminal-command.ts`) makes that a SWAP rather than a rewrite — the
 * caller passes a broker, and what the broker does inside is this file's
 * problem alone.
 *
 * ## What it does and does not stop
 *
 * Stops: reading `~/.ssh`, `~/.aws`, `~/.npmrc` and every other dotfile
 * (`HOME` is redirected AND the filesystem denies the real one); writing
 * anywhere but the worktree and the run's private runtime directory, including
 * through a symlink; git finding an ambient credential or prompting for one.
 *
 * Also stops: reaching the machine the run is on. Both profiles deny loopback,
 * because the orchestrator's own API listens there.
 *
 * What it does NOT stop is written down in
 * `docs/freebuff-sponsored-local-execution.md` §9, which is private. This file
 * ships to the public repository, and an inventory of a boundary's gaps is
 * worth more to somebody probing it than to anybody maintaining it.
 *
 * ## Refuse, never downgrade
 *
 * An unsupported platform throws and a missing `bwrap` throws. Neither falls
 * back to an uncontained spawn: a boundary that silently is not there is worse
 * than one that is honestly absent, because nothing anywhere says which you
 * got. The surface asks {@link sponsoredContainment} FIRST and never offers
 * the run at all where the answer is no.
 *
 * ## Windows: the floor, and only on Windows (COD-642)
 *
 * Windows has no OS sandbox here. A run there gets the floor alone — the
 * scrubbed environment, redirected profile directories, non-interactive git
 * without hooks, and a cwd bound to the worktree — through PowerShell. That
 * arm is selected by {@link sponsoredBrokerArm} only when this process IS on
 * Windows and the server's compute grant names `desktop_windows` with
 * `containment: 'floor'`. It is never what a macOS or Linux failure becomes.
 */

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import {
  scrubSponsoredLocalEnv,
  scrubSponsoredWindowsEnv,
  sponsoredComputeGrantNamesFloor,
  sponsoredLocalContainment,
  sponsoredLocalContainmentIsFloor,
  type SponsoredFloorGrantFacts,
  type SponsoredLocalContainment,
  type SponsoredWindowsRunPaths,
} from '@codebuff/common/ads/sponsored-local-execution'

import { getSystemProcessEnv } from '../env'
import { getBundledRgPath } from '../native/ripgrep'
import { INCLUDED_HIDDEN_DIRS, parseCodeSearchFlags } from './code-search'
import {
  sameWindowsPath,
  windowsNativePath,
  windowsNativeRelative,
} from './sponsored-windows-paths'

import type {
  TerminalCommandBroker,
  TerminalCommandProcess,
  TerminalCommandSpawnRequest,
} from './run-terminal-command'

/** Where `bwrap` is on the distributions we have seen it on. */
const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']

export function findBubblewrap(): string | null {
  return BWRAP_PATHS.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Whether this machine can contain a sponsored run, and with what.
 *
 * The disk probe is HERE and the decision is in `common`, so the rule is
 * stated once and shared with the surfaces that render a refusal.
 */
export function probeSponsoredContainment(
  platform: NodeJS.Platform,
  dependencies: {
    exists: (pathname: string) => boolean
    execute: (command: string, args: string[]) => boolean
  },
): SponsoredLocalContainment {
  const bwrap =
    platform === 'linux' ? BWRAP_PATHS.find(dependencies.exists) : undefined
  const containment = sponsoredLocalContainment(platform, {
    bwrapAvailable: Boolean(bwrap),
  })
  if (sponsoredLocalContainmentIsFloor(containment)) {
    // No kernel boundary to exercise: on Windows the floor IS the broker, so
    // nothing is executed to probe it. What it needs in order to start at all
    // is Windows PowerShell at its fixed system path.
    return dependencies.exists(windowsPowerShellPath())
      ? containment
      : { available: false, reason: 'containment-probe-failed' }
  }
  if (!containment.available) return containment
  // Exercise the kernel boundary, not merely the presence of an executable.
  // In particular WSL/Linux may disable user namespaces even with bwrap installed.
  let command: string
  let args: string[]
  if (platform === 'darwin') {
    command = '/usr/bin/sandbox-exec'
    args = [
      '-p',
      '(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow sysctl-read)',
      '/usr/bin/true',
    ]
  } else {
    command = bwrap!
    args = ['--die-with-parent', '--unshare-all', '--new-session']
    for (const directory of ['/usr', '/bin', '/lib', '/lib64']) {
      if (dependencies.exists(directory))
        args.push('--ro-bind', directory, directory)
    }
    args.push(
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--clearenv',
      '--',
      '/bin/true',
    )
  }
  if (!dependencies.exists(command) || !dependencies.execute(command, args)) {
    return { available: false, reason: 'containment-probe-failed' }
  }
  return containment
}

export function sponsoredContainment(
  platform: NodeJS.Platform = process.platform,
): SponsoredLocalContainment {
  return probeSponsoredContainment(platform, {
    exists: fs.existsSync,
    execute: (command, args) => {
      try {
        const result = spawnSync(command, args, {
          timeout: 2_000,
          stdio: 'ignore',
          env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' },
        })
        return !result.error && result.status === 0
      } catch {
        return false
      }
    },
  })
}

/**
 * Where a LINKED worktree keeps the repository it belongs to.
 *
 * Desktop runs a sponsored turn in a linked worktree at
 * `<project>/.freebuff/worktrees/<threadId>`, whose `.git` is a gitfile
 * pointing at `<project>/.git/worktrees/<threadId>` — OUTSIDE the workspace.
 * With the write roots at `[workspaceRoot, runtimeDir]` and nothing granting
 * the common dir, every git command died at repository discovery:
 *
 *   fatal: not a git repository: (null)
 *
 * exit 128, on `status`, `add` and `commit` alike — so `committed`, `landed`
 * and the pull request were unreachable, which is the entire delivery half of
 * the feature. See {@link sponsoredLinkedWorktreeGrants} for what is granted
 * and, more importantly, what is not.
 *
 * Absent for a workspace that is a repository in its own right (the eval's
 * throwaway checkout, a `git init` inside the root), where `.git` is already
 * under `workspaceRoot` and nothing extra is needed.
 */
export interface SponsoredLinkedWorktree {
  /**
   * The shared common dir — the USER'S REAL `<project>/.git`.
   *
   * `git rev-parse --path-format=absolute --git-common-dir`, asked of the
   * worktree. Not built from `<project>/.git`, because a project that is
   * ITSELF a linked worktree (which is how this repository's own dev slots are
   * laid out) has a gitfile there rather than the common dir.
   */
  commonDir: string
  /**
   * This worktree's own admin dir, `<commonDir>/worktrees/<something>`.
   *
   * `git rev-parse --path-format=absolute --git-dir`, asked rather than
   * reconstructed: git names this directory after the worktree path's
   * basename, but DISAMBIGUATES a collision by appending to it, so deriving it
   * from the thread id is right until two projects produce the same basename
   * and then silently grants the wrong directory.
   */
  gitDir: string
  /**
   * The ref namespace the run's own branch lives in, WITHOUT a trailing slash.
   *
   * `freebuff` on Desktop, because every branch the app cuts is
   * `freebuff/<slug>-<threadId>`. It is a namespace rather than the exact
   * branch so that the grant is a directory — git updates a ref by writing
   * `<ref>.lock` beside it and renaming, which a grant on the ref file alone
   * does not cover.
   */
  branchNamespace: string
}

export interface SponsoredSandboxOptions {
  /** The worktree. The only tracked tree this run may write. */
  workspaceRoot: string
  /**
   * The run's private `HOME`/`TMPDIR`, writable and OUTSIDE the worktree.
   *
   * Outside deliberately: anything the run's tooling drops in `HOME` — a
   * `.gitconfig`, a package-manager cache, a lockfile from something that
   * ignored the install refusal — must not show up in the diff the user is
   * asked to review, and must not be one `git add -A` away from the branch.
   * The eval passes a path inside its throwaway checkout, which is fine there
   * because the whole checkout is thrown away.
   */
  runtimeDir: string
  /** Extra trees the run may READ (a toolchain, a shared cache). Never write. */
  additionalReadRoots?: string[]
  /**
   * Set when `workspaceRoot` is a LINKED worktree, so git can reach its
   * repository. See {@link SponsoredLinkedWorktree}.
   *
   * Deliberately NOT a bare "extra write roots" list. The paths that have to
   * be granted are an exact, security-critical set derived from this one fact,
   * and a caller passing them itself is a caller that can pass
   * `<project>/.git` — which is the hole this whole design exists to avoid.
   * The enumeration lives in {@link sponsoredLinkedWorktreeGrants}, next to
   * the reasoning and the test.
   */
  linkedWorktree?: SponsoredLinkedWorktree
  /**
   * The run edits the user's working copy IN PLACE and delivers no commit
   * (`docs/freebuff-sponsored-local-execution.md`, 2026-09-24), so
   * `<workspaceRoot>/.git` is carved out of the write root and left readable.
   *
   * The INVERSE of `linkedWorktree`: that one exists so a sandboxed run CAN
   * commit into the user's repository, this one so it cannot touch history at
   * all. They are never both set. Like that one, it is a FACT rather than a
   * path list, for the same reason -- a caller that could name the paths
   * could name the wrong ones.
   */
  readOnlyGitDir?: boolean
  /** Injected by the eval, which keeps its own (wider) allowlist. */
  scrubEnv?: (
    source: Record<string, string | undefined>,
    paths: { home: string; tmp: string },
  ) => Record<string, string>
  platform?: NodeJS.Platform
  /**
   * What the SERVER granted this run: its compute grant, of which only
   * `executionSurface` and `containment` are read, and only to admit the
   * Windows floor (see {@link sponsoredBrokerArm}). Ignored on macOS and
   * Linux, whose arm is their OS sandbox whatever a grant says.
   */
  serverGrant?: SponsoredFloorGrantFacts | null
}

/**
 * The one containment every sponsored path check is built from.
 *
 * Two questions, in this order, because they fail differently and the run has
 * to be told which one it hit:
 *
 *  1. LEXICAL — does `requested`, resolved against the worktree, still name
 *     something under it? An absolute path or a `..` fails here.
 *  2. PHYSICAL — does the nearest EXISTING ancestor of that path still
 *     realpath under the worktree? A symlink inside the repository pointing
 *     out of it passes (1) and fails here, and the ancestor walk is the only
 *     way to answer this for a path that does not exist yet.
 *
 * Returns the resolved absolute path, so a caller acts on the same string the
 * check passed rather than re-resolving and possibly resolving something else.
 * Throws a NAMED refusal: callers turn it into a tool result the run reads,
 * and a silent empty answer would teach an advertiser's procedure that a file
 * was missing rather than that the boundary said no.
 */
/**
 * A first segment a shell would tilde-expand: `~`, `~/x`, `~someone/x`.
 *
 * `$` after the tilde is excluded deliberately — `~$report.docx` is Word's
 * lock file, a real tracked-adjacent name, and no shell expands it.
 */
const TILDE_PATH = /^~[^$]*(?:[/\\]|$)/

export function containSponsoredPath(
  workspaceRoot: string,
  requested: string,
  verb: 'read files' | 'write' | 'run commands',
): string {
  // Realpath the ROOT: a worktree under `/var/folders/...` is really
  // `/private/var/folders/...` on macOS, and comparing a real path against a
  // symlinked root would refuse every path in the worktree.
  // A LEADING `~` IS REFUSED, NOT RESOLVED, and not quietly accepted either.
  // `path.resolve` has no idea what a tilde is, so `~/.ssh/id_rsa` used to
  // come back as `<worktree>/~/.ssh/id_rsa` and PASS both checks below — an
  // allow, at the exact spelling every reader of this function expects to see
  // refused. It was harmless in fact (the path stays inside the worktree, and
  // a symlink out of it is still realpathed) and unreadable as intent, which
  // is the wrong pair of properties for a boundary. Expanding it instead
  // would be worse: the whole point of the floor is that `HOME` is somewhere
  // else, so the only honest answer to "the user's home directory" here is
  // no. Refused for reads, writes and cwd alike — F9's rule that the three
  // must not answer the same path differently.
  if (TILDE_PATH.test(requested)) {
    throw new Error(
      `A sponsored run may only ${verb} inside its own worktree, and \`~\` is not a path inside it.`,
    )
  }
  const root = realpathForContainment(path.resolve(workspaceRoot), verb)
  const requestedAbs = path.resolve(root, requested)

  // Split into the deepest EXISTING ancestor plus the tail that does not
  // exist yet, realpath the ancestor, and put the tail back. Only the
  // existing part can carry a symlink, and the tail is what makes this
  // answerable for a file that has not been created.
  //
  // The walk STOPS AT THE ROOT. Above it there is nothing left to learn — the
  // root has already been realpathed — and on macOS an ancestor above it
  // always resolves elsewhere, because `/tmp` is a symlink to `/private/tmp`.
  // Walking past the root refused every path under a worktree that did not
  // exist yet.
  const tail: string[] = []
  let existing = requestedAbs
  while (existing !== root && !pathEntryExists(existing, verb)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    tail.unshift(path.basename(existing))
    existing = parent
  }
  const resolved = path.join(
    existing === root ? root : realpathForContainment(existing, verb),
    ...tail,
  )

  if (escapesRoot(root, resolved)) {
    // WHICH escape it was decides the sentence the run reads, and the two are
    // different problems: a path it can rewrite, or a link it cannot see.
    throw new Error(
      escapesRoot(root, requestedAbs)
        ? `A sponsored run may only ${verb} inside its own worktree.`
        : `A sponsored run may not ${verb} through a symlink that leaves its worktree.`,
    )
  }
  return resolved
}

function pathEntryExists(
  target: string,
  verb: 'read files' | 'write' | 'run commands',
): boolean {
  try {
    // lstat sees a dangling symlink. existsSync does not, which used to let a
    // write validate the link as a missing destination and then follow it.
    fs.lstatSync(target)
    return true
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false
    }
    throw new Error(
      `A sponsored run could not safely resolve a path before it tried to ${verb}.`,
    )
  }
}

function realpathForContainment(
  target: string,
  verb: 'read files' | 'write' | 'run commands',
): string {
  try {
    return fs.realpathSync(target)
  } catch {
    // A dangling link and an unreadable/resolution-loop path are both an
    // unknown physical destination. Unknown is a refusal at this boundary.
    throw new Error(
      `A sponsored run could not safely resolve a path before it tried to ${verb}.`,
    )
  }
}

function escapesRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.startsWith('..') || path.isAbsolute(relative)
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * Refuse a working directory outside the worktree.
 *
 * This bounds where a command STARTS, not where it goes — an absolute path in
 * the command itself walks straight past it. That is what the OS sandbox is
 * for; this is the cheap check that catches the sloppy case and is the only
 * thing available on a platform with no sandbox.
 *
 * It resolves symlinks, like its write and read siblings. It used to be purely
 * lexical while they were not, so `cd linked-dir` out of the worktree was
 * refused as a WRITE target and accepted as a working directory — one boundary
 * with two answers, and no reason for the difference.
 */
export function assertSponsoredCommandCwd(
  workspaceRoot: string,
  requestedCwd: string,
): void {
  containSponsoredPath(workspaceRoot, requestedCwd, 'run commands')
}

/**
 * Refuse a write outside the worktree, INCLUDING through a symlink.
 *
 * Lexical containment is not enough when a repository contains a symlink
 * pointing outside itself: `linked-dir/new-file` resolves inside the worktree
 * as a string and lands outside it on disk.
 */
export function assertSponsoredWritePath(
  workspaceRoot: string,
  requestedPath: string,
): void {
  containSponsoredPath(workspaceRoot, requestedPath, 'write')
}

/**
 * Refuse a READ outside the worktree, by the same rule as a write.
 *
 * Why this exists at all is the whole of finding F1: the broker below covers
 * exactly ONE tool. `read_files`, `code_search` and `list_directory` execute
 * in the orchestrator's own process, as the user, and each resolves an
 * absolute path deliberately — so a procedure containing no shell command at
 * all could read the user's private keys and hand them to the granted
 * `read_url`. The clamp is applied by the surface, per tool, before the tool
 * runs; this is the shared rule it applies.
 */
export function assertSponsoredReadPath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  return containSponsoredPath(workspaceRoot, requestedPath, 'read files')
}

const SPONSORED_SEARCH_BOOLEAN_FLAGS = new Set([
  '-i',
  '--ignore-case',
  '-s',
  '--case-sensitive',
  '-S',
  '--smart-case',
  '-F',
  '--fixed-strings',
  '-w',
  '--word-regexp',
  '-x',
  '--line-regexp',
  '-U',
  '--multiline',
  '--multiline-dotall',
])
const SPONSORED_SEARCH_TEXT_FLAGS = new Set([
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
])
const SPONSORED_SEARCH_NUMBER_FLAGS = new Set([
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-m',
  '--max-count',
])

/**
 * Sponsored search accepts only formatting and match-selection options.
 * Ripgrep options that load another file, follow links, read configuration or
 * execute a preprocessor are absent by construction rather than blocklisted.
 */
export function sponsoredCodeSearchFlagsRefusal(
  flags: string | undefined,
): string | null {
  if (!flags?.trim()) return null
  const tokens = parseCodeSearchFlags(flags)
  if (!tokens)
    return 'Sponsored code search flags contain an unterminated quote.'
  return sponsoredCodeSearchFlagTokensRefusal(tokens)
}

/** The same allowlist, over flags already split into argv entries. */
function sponsoredCodeSearchFlagTokensRefusal(
  tokens: readonly string[],
): string | null {
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index]!
    if (SPONSORED_SEARCH_BOOLEAN_FLAGS.has(flag)) continue
    const value = tokens[++index]
    if (!value || value.startsWith('-')) {
      return `Sponsored code search flag ${flag} is unsupported.`
    }
    if (SPONSORED_SEARCH_TEXT_FLAGS.has(flag)) {
      if (
        flag === '-t' ||
        flag === '--type' ||
        flag === '-T' ||
        flag === '--type-not'
      ) {
        if (!/^[A-Za-z0-9_+.-]+$/.test(value)) {
          return `Sponsored code search flag ${flag} has an invalid type name.`
        }
      }
      continue
    }
    if (SPONSORED_SEARCH_NUMBER_FLAGS.has(flag) && /^\d+$/.test(value)) continue
    return `Sponsored code search flag ${flag} is unsupported.`
  }
  return null
}

/** What `codeSearch` puts ahead of the caller's flags, in this order. */
const SPONSORED_RIPGREP_HEAD = ['--no-config', '-n', '--json'] as const

/**
 * Appended AFTER the caller's flags, so ripgrep's last-flag-wins parsing makes
 * them unconditional. None changes a result under the OS sandbox, which could
 * not read a parent's ignore file, a global one, or a link's target anyway;
 * they make the unsandboxed Windows search answer the same way.
 */
const SPONSORED_RIPGREP_FIXED = [
  '--no-follow',
  '--no-ignore-parent',
  '--no-ignore-global',
] as const

/**
 * The exact ripgrep argv a sponsored search may run, rebuilt from the request.
 *
 * FIXED ARGUMENTS (COD-642): the broker does not pass through whatever argv it
 * is handed. It accepts only the shape `codeSearch` builds — the fixed head,
 * flags from the same allowlist the surface applies, `--`, one pattern, and
 * search paths drawn from `.` plus `INCLUDED_HIDDEN_DIRS` — and refuses
 * anything else by name. So a caller that skipped the surface's flag check
 * still cannot reach `--pre`, `--follow` or `--ignore-file`.
 *
 * An included hidden directory that is a SYMLINK is dropped: ripgrep follows a
 * search path named on its command line even without `--follow`, so `.github`
 * linked out of the worktree would otherwise be searched through the link. On
 * Windows it is also dropped unless Windows itself resolves it to `<cwd>\<name>`:
 * `lstat` does not report every reparse point as a link.
 *
 * `cwd` must already have been checked against the worktree; this reads
 * metadata under it.
 */
export function sponsoredRipgrepArgs(
  args: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const refuse = (): never => {
    throw new Error(
      'Sponsored code search only runs ripgrep with the arguments it builds itself.',
    )
  }
  if (!SPONSORED_RIPGREP_HEAD.every((flag, index) => args[index] === flag)) {
    refuse()
  }
  const separator = args.indexOf('--', SPONSORED_RIPGREP_HEAD.length)
  if (separator === -1 || separator + 1 >= args.length) refuse()
  const flags = args.slice(SPONSORED_RIPGREP_HEAD.length, separator)
  const refusal = sponsoredCodeSearchFlagTokensRefusal(flags)
  if (refusal) throw new Error(refusal)
  const pattern = args[separator + 1]!
  const searchPaths: string[] = []
  for (const searchPath of args.slice(separator + 2)) {
    if (searchPath === '.') {
      searchPaths.push(searchPath)
      continue
    }
    if (!INCLUDED_HIDDEN_DIRS.includes(searchPath)) refuse()
    try {
      const target = path.join(cwd, searchPath)
      const stat = fs.lstatSync(target)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      if (
        platform === 'win32' &&
        !sameWindowsPath(
          windowsNativePath(target),
          path.join(windowsNativePath(cwd), searchPath),
        )
      ) {
        continue
      }
      searchPaths.push(searchPath)
    } catch {
      // Gone since codeSearch looked: nothing to search there.
    }
  }
  if (searchPaths.length === 0) refuse()
  return [
    ...SPONSORED_RIPGREP_HEAD,
    ...flags,
    ...SPONSORED_RIPGREP_FIXED,
    '--',
    pattern,
    ...searchPaths,
  ]
}

/**
 * ripgrep started directly, with no shell and no OS sandbox. Windows only.
 *
 * The environment is EMPTY but for `SystemRoot`, taken from the one the caller
 * handed the broker, which a Windows process may need to load system
 * libraries: ripgrep reads no variable a search needs once `--no-config` and
 * `--no-ignore-global` are on its command line, and every variable not passed
 * is one that cannot leak into a search it runs.
 */
function spawnSponsoredRipgrepDirectly(
  rgPath: string,
  args: string[],
  cwd: string,
  sourceEnv: NodeJS.ProcessEnv,
): TerminalCommandProcess {
  const systemRoot = sourceEnv.SystemRoot ?? sourceEnv.SYSTEMROOT
  const child = spawn(rgPath, args, {
    cwd,
    env: (systemRoot ? { SystemRoot: systemRoot } : {}) as NodeJS.ProcessEnv,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    pid: child.pid,
    stdout: child.stdout!,
    stderr: child.stderr!,
    completion: new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    }),
    kill: (signal) => {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    },
    isAlive: () => child.exitCode === null && child.signalCode === null,
  }
}

/**
 * The process boundary a sponsored `code_search` runs ripgrep through.
 *
 * ripgrep is spawned DIRECTLY, never through a shell, with the fixed argv from
 * {@link sponsoredRipgrepArgs}. What it is spawned under depends on the OS:
 *
 *  - macOS and Linux: the same OS sandbox as sponsored shell commands, from a
 *    copy staged in the run's runtime directory. It STAYS sandboxed even
 *    though the file tools no longer are: ripgrep walks the tree and opens
 *    each file by pathname, and the directory pinning that bounds the file
 *    tools (`sponsored-rooted-filesystem.ts`) cannot reach inside another
 *    program, so the kernel still bounds what ripgrep can open.
 *  - Windows: the bundled binary where it is installed, with an empty
 *    environment and the working directory re-checked against the worktree.
 *    See `docs/freebuff-sponsored-local-execution.md`, "The file layer
 *    without a shell (COD-642)".
 *
 * Every other executable goes to {@link createSponsoredTerminalBroker}
 * unchanged.
 */
export function createSponsoredCodeSearchBroker(
  options: SponsoredSandboxOptions,
): TerminalCommandBroker {
  const rgPath = getBundledRgPath(import.meta.url)
  const broker = createSponsoredTerminalBroker(options)
  const workspaceRoot = path.resolve(options.workspaceRoot)
  const platform = options.platform ?? process.platform
  const requestedRuntimeDir = path.resolve(options.runtimeDir)
  fs.mkdirSync(requestedRuntimeDir, { recursive: true })
  const runtimeStat = fs.lstatSync(requestedRuntimeDir)
  if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
    throw new Error(
      'A sponsored run requires a private runtime directory that is not a symlink.',
    )
  }
  const isRipgrep = (request: TerminalCommandSpawnRequest) =>
    path.resolve(request.executable) === path.resolve(rgPath)

  /**
   * The search's working directory, checked against the worktree BEFORE
   * anything reads under it — `sponsoredRipgrepArgs` lstats the hidden roots
   * there. On Windows the check is also asked of where Windows itself
   * resolves it, since the lexical and `lstat`-based check cannot see every
   * reparse point.
   */
  const checkedSearchCwd = (cwd: string): string => {
    containSponsoredPath(workspaceRoot, cwd, 'read files')
    if (platform === 'win32') {
      let nativeRoot: string
      try {
        nativeRoot = windowsNativePath(workspaceRoot)
      } catch {
        nativeRoot = ''
      }
      if (!nativeRoot || windowsNativeRelative(nativeRoot, cwd) === null) {
        throw new Error(
          'A sponsored run may only read files inside its own worktree.',
        )
      }
    }
    return cwd
  }

  if (platform === 'win32') {
    return {
      // Carried through from the Windows floor broker (COD-642), so the SDK
      // hands shell commands to the floor's own shell, PowerShell, instead of
      // a bash invocation. Absent when the floor was not granted, and then
      // every non-ripgrep start is refused by that broker as before.
      ...(broker.ownsShell ? { ownsShell: true } : {}),
      start(request) {
        if (!isRipgrep(request)) return broker.start(request)
        const cwd = checkedSearchCwd(request.cwd)
        return spawnSponsoredRipgrepDirectly(
          rgPath,
          sponsoredRipgrepArgs(request.args, cwd, platform),
          cwd,
          request.env,
        )
      },
    }
  }

  const runtimeDir = fs.realpathSync(requestedRuntimeDir)
  // Stage once while the broker is being assembled, before advertiser-authored
  // code can modify the runtime tree. Performing mkdir/copy in start() would
  // let an earlier tool call replace `tools` with a symlink and turn this host
  // copy into an out-of-bound write before the process sandbox existed.
  //
  // Staged at all so the binary sits inside a root the sandbox already grants:
  // granting the SDK's installation directory would expose its sibling
  // package contents to the run.
  const stagedDir = fs.mkdtempSync(path.join(runtimeDir, 'rg-'))
  const stagedRg = path.join(stagedDir, 'rg')
  fs.copyFileSync(rgPath, stagedRg)
  fs.chmodSync(stagedRg, 0o755)
  return {
    start(request) {
      if (!isRipgrep(request)) return broker.start(request)
      // The staged binary IS the sandboxed executable: `sandbox-exec` and
      // `bwrap` exec it directly, with each argument its own argv entry. It
      // used to be exec'd through `/bin/sh -c 'exec "$@"'`; measured on macOS
      // 26.5, seatbelt runs the staged copy directly just the same.
      const cwd = checkedSearchCwd(request.cwd)
      return broker.start({
        ...request,
        executable: stagedRg,
        args: sponsoredRipgrepArgs(request.args, cwd, platform),
      })
    },
  }
}

const KILL_ESCALATION_MS = 2_000

function groupAlive(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

function killGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals | number,
): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal as NodeJS.Signals)
    } catch {
      // already gone
    }
  }
}

async function waitForGroupExit(
  child: ReturnType<typeof spawn>,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!groupAlive(child)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !groupAlive(child)
}

/**
 * The handle, with the process GROUP reaped when the command reports done.
 *
 * A synchronous command does not transfer ownership of what it backgrounded:
 * `some-server &` returns immediately, the turn ends, and the descendant keeps
 * running — with whatever network the profile gave it — for as long as the
 * user leaves the app open. `run-terminal-command.ts` reaps its own group for
 * exactly this reason and this broker did not, so a sponsored run was the ONE
 * shell on the machine that could outlive its turn.
 *
 * The reap is attached to `completion` rather than to `kill`, because the case
 * that matters is the command SUCCEEDING and leaving something behind.
 */
function processHandle(
  child: ReturnType<typeof spawn>,
): TerminalCommandProcess {
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  const completion = closed.then(async (exitCode) => {
    if (process.platform === 'win32' || !groupAlive(child)) return exitCode
    killGroup(child, 'SIGTERM')
    if (await waitForGroupExit(child, KILL_ESCALATION_MS)) return exitCode
    killGroup(child, 'SIGKILL')
    await waitForGroupExit(child, KILL_ESCALATION_MS)
    return exitCode
  })
  return {
    pid: child.pid,
    stdout: child.stdout!,
    stderr: child.stderr!,
    completion,
    kill: (signal) => killGroup(child, signal),
    isAlive: () => groupAlive(child),
  }
}

/**
 * Seatbelt matches the path the KERNEL resolves, so a `subpath` naming a
 * symlinked root never matches: a checkout under `/var/folders/...` is really
 * `/private/var/folders/...`. Roots that do not exist yet are left alone
 * rather than dropped.
 */
function canonicalRoot(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * Canonicalise a path to a file that DOES NOT EXIST YET.
 *
 * `canonicalRoot` cannot: `realpathSync` throws on a missing path and the
 * fallback hands back the spelling it was given. For `packed-refs.lock`, which
 * by definition exists only while git holds it, that spelling is
 * `/var/folders/...` while the kernel resolves `/private/var/folders/...` —
 * and seatbelt matches the RESOLVED path, so the grant is inert and the commit
 * fails with the lock error it was written to prevent. This cost a full
 * measurement cycle to find, because a grant that silently does not match
 * looks exactly like a grant that was never needed.
 *
 * Only the DIRECTORY can carry the symlink, so resolve that and put the
 * basename back — the same split `containSponsoredPath` makes, for the same
 * reason.
 */
function canonicalFile(target: string): string {
  return path.join(canonicalRoot(path.dirname(target)), path.basename(target))
}

/**
 * Every directory on the way to a granted root must be traversable, or the
 * process cannot follow the symlinks between them — and on macOS 26 a
 * `(deny default)` process whose profile omits `/` aborts with SIGABRT before
 * it runs at all.
 *
 * `file-read*` on a directory INCLUDES `readdir`, so granting it to each
 * ancestor as a `literal` would let a sponsored run enumerate the names in
 * every directory between `/` and the workspace — `/Users/<name>` and every
 * sibling temp directory included. Verified by running `ls` under such a
 * profile, not by reading the manual. Ancestors therefore get
 * `file-read-metadata`, which is enough to `stat` and traverse and not enough
 * to list; only `/` keeps `file-read*`, because that is what the macOS 26
 * abort actually requires.
 */
function traversableAncestors(targets: string[]): string[] {
  const ancestors = new Set(['/'])
  for (const target of targets) {
    let current = path.dirname(target)
    while (current !== path.dirname(current)) {
      ancestors.add(current)
      current = path.dirname(current)
    }
  }
  return [...ancestors]
}

/**
 * The device nodes a normal toolchain must be able to WRITE, and nothing more.
 *
 * `/dev` is in the readable set, and readable is not enough: every git binary
 * opens `/dev/null` for reading AND writing at startup, so with `file-write*`
 * granted only to the worktree and the runtime directory, `git --version`
 * itself dies with
 *
 *   fatal: could not open '/dev/null' for reading and writing: Operation not permitted
 *
 * That is machine-independent — reproduced on Homebrew git 2.55.0, so it is
 * not the xcode-select shim failure {@link sponsoredMacGitPath} closes — and
 * it put `committed`, `landed` and the pull request out of reach on
 * every Mac. Nothing caught it, because a shell redirect into the worktree,
 * which is what the acceptance tests run, needs no device node.
 *
 * NOT `(subpath "/dev")`. `/dev` holds `bpf*` (packet capture), `disk*` (the
 * raw block devices) and `auditpipe`; unix permissions are what keep those out
 * of reach, and a blanket write grant would leave nothing else in the way the
 * day one of them is group-writable. Each entry below was MEASURED to be
 * needed, and the candidates that were measured and are NOT needed are listed
 * with their reasons so the next person does not re-derive them.
 *
 * Measured on macOS 26.5 (Darwin 25.5) by ablation: grant the candidate set,
 * run a real `git init` / `add` / `commit` / `log` through the shipped broker,
 * then drop one node at a time and see what breaks.
 *
 *  - `/dev/null` — REQUIRED. Dropping it is the blocker above.
 *  - `/dev/fd` — GRANTED as a subpath, and the only subpath here.
 *    `/dev/stdout` and `/dev/stderr` are SYMLINKS to `/dev/fd/1` and
 *    `/dev/fd/2`, and seatbelt matches the path the kernel resolves, so a
 *    `(literal "/dev/stdout")` grant is inert: measured, with `/dev/null`,
 *    `/dev/stdout` and `/dev/stderr` all granted as literals, `echo hi >
 *    /dev/stdout` is still `Operation not permitted`, and it succeeds the
 *    moment `/dev/fd` is granted instead. `> /dev/stderr` and `tee
 *    /dev/stderr` are ordinary shell-script spellings; a build that uses one
 *    should not die inside a sponsored run.
 *
 *    It does not widen the boundary. `/dev/fd/N` names the process's OWN
 *    descriptors, and re-opening one is evaluated by seatbelt against the
 *    UNDERLYING file — measured: with this grant in place, `exec 3<
 *    outside.txt; echo PWNED > /dev/fd/3` is refused with the error naming
 *    `outside.txt` rather than `/dev/fd/3`, and the file is unchanged. Same
 *    for `/etc/hosts`, which answers `Permission denied`.
 *  - `/dev/tty` — NOT granted. The broker spawns `detached` with pipes for
 *    stdio, so the run has no controlling terminal: measured, reading
 *    `/dev/tty` answers "Device not configured" whether or not the write is
 *    granted. The grant would be dead code.
 *  - `/dev/dtracehelper`, `/dev/random`, `/dev/urandom`, `/dev/zero` — NOT
 *    granted. Reading is what they are for and reading already works through
 *    the `/dev` read grant: measured, `node`'s crypto, `python3`'s
 *    `os.urandom` and `head -c 8 /dev/urandom` all work with no write grant,
 *    and the git flow passes with each of them dropped.
 *  - `/dev/stdin`, `/dev/ptmx`, `/dev/console` — NOT granted. Nothing in the
 *    ablation needed them, and `/dev/stdin` is a `/dev/fd/0` symlink already
 *    covered above.
 *
 * KNOWN, AND NOT A DEVICE PROBLEM: BSD `diff <(…)` still fails with
 * `/dev/fd/63: Operation not permitted`. Measured, that is fixed by neither
 * `(subpath "/dev")`, nor `file-ioctl`, nor granting the confstr temp
 * directory — only a blanket `(allow file*)` clears it — so it is a file
 * operation on the anonymous pipe with no path to name. `cat`, `grep`,
 * `source` and bash's `<<<` all work with process substitution. Left alone
 * rather than bought with a blanket grant.
 */
const SPONSORED_DEVICE_WRITE_LITERALS: readonly string[] = ['/dev/null']
const SPONSORED_DEVICE_WRITE_SUBPATHS: readonly string[] = ['/dev/fd']

/**
 * `readlink("/var")`, which is the whole of what the system resolver needs.
 *
 * Without it `getaddrinfo` answers `ENOTFOUND` for every name, so `curl
 * https://example.com` and `git ls-remote https://…` fail. Egress is accepted
 * by COD-336 decision item 8, and this made the granted capability work only
 * for a caller who already knew an address — a silent failure for an honest
 * procedure, and no boundary at all. It closes a hole in the STATED
 * capability rather than in the containment; the measurements behind that
 * claim are in `docs/freebuff-sponsored-local-execution.md` §9, which is
 * private, because an account of what a boundary does not stop is worth more
 * to somebody probing it than to anybody maintaining it.
 *
 * Bisected to this one literal on macOS 26.5: the resolver reads the `/var`
 * SYMLINK, and the profile's ancestor grants only ever cover `/private/var`
 * — measured, `(subpath "/private/var")` does not help and `(literal "/var")`
 * alone does. It grants exactly `readlink` on the link: with it in place, `ls
 * /var`, `ls /private/var` and `cat /var/run/resolv.conf` are all still
 * `Operation not permitted`, and the user's home directory stays unreadable.
 * Loopback stays denied, which is the denial that matters.
 */
const SPONSORED_RESOLVER_READ_LITERALS: readonly string[] = ['/var']

/**
 * macOS's shell selector, which `/bin/sh` reads at startup.
 *
 * NOISE, not containment — and noise is not free here. Without this literal
 * EVERY command in a sponsored run prints
 *
 *     Error opening /private/var/select/sh: Operation not permitted
 *
 * on stderr before doing anything, and that stderr is tool output: it reaches
 * the MODEL, on every command, in a run whose whole premise is a bounded change
 * an advertiser wrote. A constant fake error in front of every result is how a
 * run learns to read past its own errors. Measured on macOS 26.5 against the
 * shipped profile: `/bin/sh -c 'echo hi'` emits it, `/bin/bash -c 'echo hi'`
 * does not — so it is `/bin/sh` resolving which shell to be, not the command.
 *
 * The same shape as the `/var` literal above, a readlink-only grant on a
 * symlink, and it discloses NOTHING new: `/private/var/select/sh` resolves to
 * `/bin/bash`, which `(subpath "/bin")` already makes readable. Measured with
 * it in place, `ls /var`, `ls /private/var`, `ls /var/select` and `cat
 * /var/run/resolv.conf` are all still `Operation not permitted`.
 *
 * Chosen over filtering the line out of stderr, which would have been the other
 * way to silence it: a broker that edits a run's error output is a broker that
 * can hide a real one.
 *
 * NOT the Xcode shim. `/var/select/developer_dir`, beside it, is what
 * `/usr/bin/git` reads, and it is still not granted: git works here because
 * {@link sponsoredMacGitPath} hands the run a real git that never reads it.
 */
const SPONSORED_SHELL_SELECT_READ_LITERALS: readonly string[] = [
  '/private/var/select/sh',
]

/**
 * The system trees the macOS profile makes readable, ahead of the run's own
 * roots. Named so {@link sponsoredMacGitPath} asks "can the sandbox run this
 * binary?" of the SAME list the profile grants, rather than of a copy.
 */
const SPONSORED_MAC_SYSTEM_READ_SUBPATHS: readonly string[] = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/opt',
  '/etc',
  '/private/etc',
  '/private/var/db',
  '/dev',
]

/** Apple's `/usr/bin/git`: an xcode-select shim, not git. */
const XCODE_SELECT_GIT_SHIM = '/usr/bin/git'

/** Where the xcode-select shims live: `git`, `python3`, `make`, `clang`, ... */
const XCODE_SELECT_SHIM_DIR = '/usr/bin'

/**
 * Where xcode-select records the active developer directory: the link macOS
 * 26 reads, then the older one. Read HERE, outside the sandbox, where both are
 * readable; the developer directory's git is `<dir>/usr/bin/git` for the
 * Command Line Tools and for a full Xcode alike.
 */
const XCODE_SELECT_DEVELOPER_DIR_LINKS: readonly string[] = [
  '/var/select/developer_dir',
  '/var/db/xcode_select_link',
]

export interface SponsoredMacGitDependencies {
  /** A regular file this process may execute, following symlinks. */
  isExecutableFile: (pathname: string) => boolean
  /** The canonical path, or null when it does not resolve. */
  realpath: (pathname: string) => string | null
  /**
   * The active developer directory's git, asked OUTSIDE the sandbox, or null
   * when there are no developer tools. Called at most once per resolution,
   * and only when the shim is what PATH would run.
   */
  developerGit: () => string | null
  /**
   * A directory the sandbox reads holding a stand-in, for every xcode-select
   * shim in `/usr/bin`, that execs the binary that shim runs ({@link linkDeveloperShims}),
   * or null. Asked only when PATH has `/usr/bin`.
   */
  developerShims?: () => string | null
}

function underSystemReadRoot(target: string): boolean {
  return SPONSORED_MAC_SYSTEM_READ_SUBPATHS.some((root) =>
    target.startsWith(`${root}/`),
  )
}

/**
 * The PATH a contained macOS shell runs with: the caller's, with the directory
 * of a REAL git put ahead of the first entry that holds any git.
 *
 * ## Why git needed resolving at all
 *
 * `/usr/bin/git` is not git. It is Apple's xcode-select shim: it reads the
 * active developer directory from the `/var/select/developer_dir` link and
 * execs the git inside it. The profile does not grant that link, so under the
 * sandbox the shim dies before git starts —
 *
 *     xcode-select: error: unable to read data link at '/var/select/developer_dir', expected symbolic link (Operation not permitted)
 *     xcode-select: note: No developer tools were found, requesting install.
 *
 * — and the second line is not only text: it opens macOS's "Install Command
 * Line Developer Tools" dialog on the user's screen, from inside a sponsored
 * run, on a Mac that has them installed. Measured on macOS 26.4.1 with only
 * the Command Line Tools, through this broker.
 *
 * And the shim is what a sponsored shell found. `runTerminalCommand` hands the
 * broker the orchestrator's own PATH, and the scrub keeps it verbatim. A
 * Finder-launched Desktop starts from launchd's `/usr/bin:/bin:/usr/sbin:/sbin`,
 * and its login-shell repair (`freebuff-desktop/electron/shell-path.cjs`)
 * APPENDS, so `/usr/bin` precedes Homebrew and `git` is the shim. Where another
 * git does come first the sandbox may still not see it: an entry outside the
 * readable set (anything under HOME, or the temp dir) fails `stat` with
 * `Operation not permitted` inside the profile, and bash moves on to
 * `/usr/bin`. Either way `git commit` failed and the run ended "finished
 * without committing anything".
 *
 * ## What this does instead
 *
 * Resolves git HERE, unsandboxed, and changes what the NAME means rather than
 * what the sandbox may read:
 *
 *  0. right before `/usr/bin`, put stand-ins for its shims
 *     ({@link linkDeveloperShims}): each execs the binary it would run, so
 *     `python3`, `make` and `clang` work too, whichever git wins below;
 *  1. walk PATH the way the orchestrator's own shell does; the first `git`,
 *     through its symlinks, is the git the user's own commands run;
 *  2. if that is the shim, ask the developer directory for its git
 *     ({@link findXcodeDeveloperGit}, which reads the link) — outside the
 *     sandbox the link reads fine;
 *  3. keep it only if it is under a tree the profile ALREADY reads (the
 *     Command Line Tools live under `/Library`, Homebrew under `/opt`),
 *     otherwise keep walking. A git under HOME, or a full Xcode under
 *     `/Applications`, is passed over, never granted;
 *  4. put its directory ahead of the first PATH entry holding any git, so
 *     neither the shim nor an unreadable entry can win inside the run.
 *
 * The profile is unchanged by this: no read grant, no write grant, no new
 * environment variable. PATH is not a boundary — the run can already exec
 * any binary the profile reads — so choosing which one `git` names moves
 * nothing the sandbox decides. A grant on the data link was measured and
 * rejected; `docs/freebuff-sponsored-local-execution.md` §9 has why.
 *
 * What else moves, measured on the Command Line Tools: the stand-ins re-resolve
 * the 77 names both directories hold, and every one of them is an
 * xcode-select shim in `/usr/bin`, so each now runs the binary its shim would
 * have run. The 66 names only the Command Line Tools ship (`swift-*`,
 * `llvm-*`, `clang-format`, …) are NOT linked, so none of them shadows a copy
 * later on PATH. For Homebrew the inserted directory is the keg's own `bin`,
 * which holds git's family and nothing else.
 *
 * No readable real git anywhere leaves PATH exactly as it was, so the run
 * fails the way it did before, and its commit error reaches
 * `diagnostic_reason`. Linux never comes here: `/usr/bin/git` is git there.
 */
export function sponsoredMacGitPath(
  pathValue: string | undefined,
  dependencies: SponsoredMacGitDependencies,
): string | undefined {
  if (!pathValue) return pathValue
  let entries = pathValue.split(':')
  // Every shim, not only `git`: `python3`, `make` and `clang` in `/usr/bin`
  // fail the same way inside the run (and request the same install), and
  // stand-ins for exactly those names, right where they were, resolve them
  // without making any name visible that `/usr/bin` did not already provide.
  const shimAt = entries.indexOf(XCODE_SELECT_SHIM_DIR)
  const shims = shimAt === -1 ? null : (dependencies.developerShims?.() ?? null)
  if (shims) entries = [...entries.slice(0, shimAt), shims, ...entries.slice(shimAt)]
  let developerGit: string | null | undefined
  const resolveDeveloperGit = (): string | null => {
    if (developerGit !== undefined) return developerGit
    const found = dependencies.developerGit()
    developerGit =
      found && path.isAbsolute(found) && dependencies.isExecutableFile(found)
        ? dependencies.realpath(found)
        : null
    return developerGit
  }
  let firstGit = -1
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    // A relative entry is relative to the cwd, which inside the run is the
    // advertiser-writable worktree. Never resolved, so never chosen.
    if (!path.isAbsolute(entry)) continue
    // Nothing ahead of the stand-ins held a git the sandbox can run, and
    // theirs is the developer git.
    if (entry === shims) return entries.join(':')
    const candidate = path.join(entry, 'git')
    if (!dependencies.isExecutableFile(candidate)) continue
    if (firstGit === -1) firstGit = index
    let real = dependencies.realpath(candidate)
    if (real === XCODE_SELECT_GIT_SHIM) real = resolveDeveloperGit()
    if (!real || real === XCODE_SELECT_GIT_SHIM || !underSystemReadRoot(real)) {
      continue
    }
    const binDir = path.dirname(real)
    if (entries[firstGit] === binDir) return entries.join(':')
    return [
      ...entries.slice(0, firstGit),
      binDir,
      ...entries.slice(firstGit),
    ].join(':')
  }
  return entries.join(':')
}

/**
 * Fill `dir` with a stand-in, for every name both `/usr/bin` and the developer
 * directory's `bin` hold, that execs the developer binary: on the Command Line
 * Tools every such `/usr/bin` name is an xcode-select shim (77 of them,
 * measured on macOS 26.4.1), so each stand-in runs the binary its shim would
 * have run. Names only the developer directory ships are NOT added, so nothing
 * new becomes visible on PATH.
 *
 * A two-line `exec` script and not a symlink: Apple's git finds its own
 * install (`libexec/git-core`, `share/git-core`) from the path it was started
 * by, and started through a link in `dir` it cannot, falls back to
 * `/Applications/Xcode.app/Contents/Developer/usr`, and there `git init` dies
 * reading a gitconfig the profile denies (measured on a macOS 15 runner with
 * Xcode installed and the Command Line Tools selected). `exec` by absolute
 * path hands every tool its real path, as the shim's own exec does.
 *
 * Recreated from scratch on every call: `dir` is inside the run's writable
 * runtime directory. Only a developer directory the profile already reads
 * qualifies (a full Xcode under /Applications does not); otherwise null.
 */
export function linkDeveloperShims(options: {
  dir: string
  developerGit: string | null
  shimDir?: string
}): string | null {
  const shimDir = options.shimDir ?? XCODE_SELECT_SHIM_DIR
  if (!options.developerGit) return null
  let developerBin: string
  try {
    developerBin = path.dirname(fs.realpathSync(options.developerGit))
  } catch {
    return null
  }
  if (!underSystemReadRoot(developerBin)) return null
  try {
    const shims = new Set(fs.readdirSync(shimDir))
    fs.rmSync(options.dir, { recursive: true, force: true })
    fs.mkdirSync(options.dir, { recursive: true })
    for (const name of fs.readdirSync(developerBin)) {
      if (!shims.has(name)) continue
      const target = path.join(developerBin, name)
      if (!isExecutableFile(target)) continue
      fs.writeFileSync(
        path.join(options.dir, name),
        `#!/bin/sh\nexec '${target.replaceAll("'", `'\\''`)}' "$@"\n`,
        { mode: 0o755 },
      )
    }
    return options.dir
  } catch {
    return null
  }
}

/**
 * The active developer directory's git, read outside the sandbox.
 *
 * The same answer the shim itself reaches -- the developer directory the link
 * names, then its `usr/bin/git` -- without spawning anything: no `xcrun` to
 * block the orchestrator, and on a Mac with no developer tools nothing that
 * could request an install (the dialog above). Never throws; a null only
 * means "no better git than before".
 */
export function findXcodeDeveloperGit(
  dependencies: {
    readlink: (pathname: string) => string | null
    isExecutableFile: (pathname: string) => boolean
  } = { readlink: readDeveloperDirLink, isExecutableFile },
): string | null {
  for (const link of XCODE_SELECT_DEVELOPER_DIR_LINKS) {
    const developerDir = dependencies.readlink(link)
    if (!developerDir || !path.isAbsolute(developerDir)) continue
    const git = path.join(developerDir, 'usr', 'bin', 'git')
    return dependencies.isExecutableFile(git) ? git : null
  }
  return null
}

function readDeveloperDirLink(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link))
  } catch {
    return null
  }
}

function isExecutableFile(pathname: string): boolean {
  try {
    if (!fs.statSync(pathname).isFile()) return false
    fs.accessSync(pathname, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The host side of {@link sponsoredMacGitPath}, as the broker uses it. */
const SPONSORED_MAC_GIT_HOST: SponsoredMacGitDependencies = {
  isExecutableFile,
  realpath: (pathname) => {
    try {
      return fs.realpathSync(pathname)
    } catch {
      return null
    }
  },
  developerGit: () => findXcodeDeveloperGit(),
}

/**
 * What a linked worktree's git needs from the USER'S REAL `.git`, and nothing more.
 *
 * ## Why this is an enumeration and not `<project>/.git`
 *
 * Granting write to the common dir would hand an advertiser-authored run
 * `.git/hooks/*` — arbitrary code execution as the user on their next git
 * operation, in a directory that never appears in the pull request they review
 * — and `.git/config`, which is arbitrary command execution through
 * `core.pager`, `core.editor`, `diff.external`, `core.fsmonitor` and aliases,
 * every one of them fired by the ORCHESTRATOR's own unsandboxed `git -C
 * <worktree>` calls. That is a worse hole than the one it fixes.
 *
 * So: READ the common dir, WRITE four subtrees and one lock file. Measured on
 * macOS 26.5 (Darwin 25.5) against a real `<project>/.git` with its refs
 * PACKED (`git pack-refs --all`), which is the harder and more realistic case:
 *
 *  - `worktrees/<name>` — this worktree's own admin dir: `index`, `HEAD`,
 *    `index.lock`, `COMMIT_EDITMSG`, `logs/HEAD`. REQUIRED; it is where the
 *    commit is actually assembled. Scoped to THIS worktree's directory, not to
 *    `worktrees/`, so one sponsored run cannot reach another's index.
 *  - `objects` — the new commit, tree and blob objects. REQUIRED, and the one
 *    grant here that is genuinely wide; see the honest limit below.
 *  - `refs/heads/<branchNamespace>` — the branch tip. Scoped to the app's own
 *    namespace, so `refs/heads/main` is NOT writable: measured, `echo x >
 *    .git/refs/heads/main` is `Operation not permitted` with this grant in
 *    place. Granting `refs/` wholesale instead would let a run rewrite or
 *    delete every branch in the user's repository.
 *  - `logs/refs/heads/<branchNamespace>` — the branch's reflog, same scoping
 *    and same reason.
 *  - `packed-refs.lock` — REQUIRED, and the least obvious entry here. A ref
 *    transaction takes this lock even when it ends up writing a LOOSE ref, so
 *    without it `git commit` fails outright on any repository whose refs have
 *    been packed. Measured both ways: with the grant `commit=ok`, without it
 *    `commit=FAIL`. It is the LOCK ONLY and deliberately not `packed-refs`
 *    itself, which stays unwritable — so a run can take the lock git needs and
 *    still cannot rewrite the packed ref table, which is where deleting
 *    somebody else's branch would happen. Linux cannot express this literal;
 *    it hides `packed-refs` from the run altogether and lets the lock land in
 *    a tmpfs instead (see `prepareLinkedWorktreeForLinux`), which is the same
 *    property by a different mechanism: git gets its lock, the table is never
 *    rewritten on the host.
 *
 * Everything else in the common dir is readable and not writable. Measured, all
 * `Operation not permitted`: `hooks/`, `config`, `config.worktree`, `info/`,
 * `packed-refs`, `refs/heads/main`, and creating any new file at the common
 * dir's root. After the run, the user's repository still resolves `main` and
 * `git fsck` is clean, while the sponsored commit is visible from it — which is
 * the point: the branch has to land in the user's own repository for the pull
 * request to be openable from it.
 *
 * ## The honest limits
 *
 * **`objects` is a real write grant on the user's repository.** A run can
 * create objects freely (that is what committing is) and can also overwrite an
 * existing loose object, which corrupts the repository. It cannot be narrowed
 * — the commit has to land where the user's git will find it, and seatbelt
 * cannot express "create but do not overwrite". It is vandalism rather than
 * privilege escalation, `git fsck` names it, and nothing about it executes
 * code; that is the whole of why it is accepted.
 *
 * **READ of `<project>/.git/config` cannot be avoided.** git opens it on every
 * command, so a repository whose remote URL carries an embedded token exposes
 * that token to the run. Measured: denying read of it makes git fail outright
 * (`fatal: unable to access '.git/config'`) on `status`, `add` and `commit`
 * alike, so there is no version of this where git works and that file is
 * unreadable. Written down rather than left to be discovered; the alternative
 * designs that avoid it are recorded in
 * `docs/freebuff-sponsored-local-execution.md` §9 along with why they cost
 * more than they save.
 */
export function sponsoredLinkedWorktreeGrants(
  linked: SponsoredLinkedWorktree,
): {
  readSubpaths: string[]
  writeSubpaths: string[]
  writeLiterals: string[]
} {
  const commonDir = path.resolve(linked.commonDir)
  return {
    readSubpaths: [commonDir],
    writeSubpaths: [
      path.resolve(linked.gitDir),
      path.join(commonDir, 'objects'),
      path.join(commonDir, 'refs', 'heads', linked.branchNamespace),
      path.join(commonDir, 'logs', 'refs', 'heads', linked.branchNamespace),
    ],
    writeLiterals: [path.join(commonDir, 'packed-refs.lock')],
  }
}

/**
 * The paths under a common dir that must NEVER be writable, whatever else is.
 *
 * Exported so the test asserts the SAME list the reasoning above names, rather
 * than a list a test author remembered. It is not consulted when building the
 * profile — the grant is an allowlist and these are simply absent from it —
 * which is the point: this is the invariant, not the mechanism.
 */
export const SPONSORED_GIT_FORBIDDEN_WRITES: readonly string[] = [
  'hooks',
  'config',
  'config.worktree',
  'info',
  'packed-refs',
]

export function sponsoredMacProfile(
  writeRoots: string[],
  additionalReadRoots: string[],
  writeLiterals: string[] = [],
  /**
   * Carved OUT of the write roots above, for an in-place run
   * (`docs/freebuff-sponsored-local-execution.md`, 2026-09-24): the
   * workspace's own `.git`, which such a run may read and must not write.
   * Seatbelt takes the LAST matching rule, so these denies are emitted after
   * the `file-write*` allow that covers the workspace.
   */
  denyWriteSubpaths: string[] = [],
): string {
  const q = JSON.stringify
  const writable = writeRoots.map(canonicalRoot)
  const extraRoots = additionalReadRoots.map(canonicalRoot)
  const readable = [
    ...SPONSORED_MAC_SYSTEM_READ_SUBPATHS,
    ...writable,
    ...extraRoots,
  ]
  // Both spellings of each root contribute ancestors: the child still reaches
  // its workspace through the symlinked path it was handed.
  const traversable = traversableAncestors([
    ...readable,
    ...writeRoots,
    ...additionalReadRoots,
  ])
  return [
    '(version 1)',
    '(deny default)',
    // NARROWER THAN `(allow process*)`, which is what this was. `process*`
    // also grants `process-info*`, and the run has no business inspecting
    // anything but itself.
    //
    // Measured on macOS 26.5, because seatbelt vocabulary is not something to
    // reason about from the manual:
    //
    //  - a blanket `(deny process-info*)` KILLS THE PROCESS at start. dyld
    //    needs process-info on self, so the deny must carry
    //    `(target others)` and the allow must carry `(target self)`.
    //  - the deny does NOT currently stop `proc_listpids`/`proc_pidpath`
    //    against another process — enumeration and executable paths are still
    //    readable with it in place. It is kept because it costs nothing, it
    //    is the correct declaration of intent, and the platform's answer here
    //    has changed before.
    //  - reading another process's ENVIRONMENT does not work on this OS at
    //    all, sandbox or not (`ps eww <other pid>` prints none). Nothing here
    //    should be read as relying on that: the orchestrator deletes its
    //    launch secret from `process.env` after reading it, which is the
    //    control that actually holds.
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info* (target self))',
    '(deny process-info* (target others))',
    '(allow signal (target self))',
    // KEPT, and needed: without it Bun aborts at startup with "memory
    // allocation of 48 bytes failed" — it reads `hw.memsize` to size its
    // heap. Measured by removing it, which broke `bun` while leaving `bash`,
    // `node` and `/bin/date` working.
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // EGRESS IS ALLOWED, LOOPBACK IS NOT, and the second half is not a detail.
    // Egress off the machine is accepted by decision (COD-336 item 8) and was
    // never bounded on Cloud either. Egress to THIS machine is a different
    // thing entirely: the Desktop orchestrator listens on 127.0.0.1:8787 and
    // its API can push a branch, open a pull request with the user's own
    // credentials, and drive the user's own unsandboxed agent. A sandbox that
    // reaches its own supervisor over loopback contains nothing.
    //
    // The `deny` has to come AFTER the `allow`: seatbelt takes the LAST
    // matching rule, so the order here is the rule.
    '(allow network*)',
    '(deny network-outbound (remote ip "localhost:*"))',
    '(deny network-inbound (local ip "localhost:*"))',
    `(allow file-read* (literal "/") ${[
      ...SPONSORED_RESOLVER_READ_LITERALS.map((item) => `(literal ${q(item)})`),
      ...SPONSORED_SHELL_SELECT_READ_LITERALS.map(
        (item) => `(literal ${q(item)})`,
      ),
      ...readable.map((item) => `(subpath ${q(item)})`),
    ].join(' ')})`,
    // Traverse, do not enumerate. See `traversableAncestors` above.
    `(allow file-read-metadata ${traversable
      .filter((item) => item !== '/')
      .map((item) => `(literal ${q(item)})`)
      .join(' ')})`,
    // The worktree and the run's private runtime directory, and after them the
    // handful of device nodes a toolchain cannot start without. See
    // SPONSORED_DEVICE_WRITE_LITERALS for why each one is on that list and why
    // the rest of `/dev` is not.
    `(allow file-write* ${[
      ...writable.map((item) => `(subpath ${q(item)})`),
      // Single FILES the run may write, which is not the same grant as a
      // subpath and must not become one: `packed-refs.lock` is granted so a
      // ref transaction can take its lock, while `packed-refs` beside it stays
      // unwritable. See `sponsoredLinkedWorktreeGrants`.
      ...writeLiterals.map((item) => `(literal ${q(canonicalFile(item))})`),
      ...SPONSORED_DEVICE_WRITE_LITERALS.map((item) => `(literal ${q(item)})`),
      ...SPONSORED_DEVICE_WRITE_SUBPATHS.map((item) => `(subpath ${q(item)})`),
    ].join(' ')})`,
    // AFTER the allow, and that order IS the rule: seatbelt takes the last
    // match. An in-place run's `.git` lives inside the write root it must
    // otherwise be able to edit, so the only way to hold the line is to grant
    // the tree and take this back.
    ...(denyWriteSubpaths.length > 0
      ? [
          `(deny file-write* ${denyWriteSubpaths
            .map((item) => `(subpath ${q(canonicalRoot(item))})`)
            .join(' ')})`,
        ]
      : []),
  ].join('\n')
}

function spawnMac(
  request: TerminalCommandSpawnRequest,
  writeRoots: string[],
  env: NodeJS.ProcessEnv,
  additionalReadRoots: string[],
  writeLiterals: string[],
  /** Carved back out of the write roots; see `sponsoredMacProfile`. */
  denyWriteSubpaths: string[] = [],
): TerminalCommandProcess {
  return processHandle(
    spawn(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        sponsoredMacProfile(
          writeRoots,
          additionalReadRoots,
          writeLiterals,
          denyWriteSubpaths,
        ),
        request.executable,
        ...request.args,
      ],
      {
        cwd: request.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  )
}

/**
 * How the Linux arm bounds the user's real `.git` (the linked worktree's
 * common dir), and why it is a tmpfs with the real entries rebound on top.
 *
 * `spawnLinux` mounts an EMPTY tmpfs at the common dir, then rebinds every
 * entry that exists there read-only — `HEAD`, `config`, `hooks/`, `info/`,
 * `refs/`, `logs/`, `worktrees/`, all of them — and finally binds the granted
 * write subpaths writable ON TOP: this worktree's admin dir, `objects`,
 * `refs/heads/<namespace>`, `logs/refs/heads/<namespace>`. bubblewrap applies
 * mounts in order, so everything an existing entry covers stays read-only
 * (`hooks/`, `config`, `info/`, every other branch's ref and reflog, every
 * other worktree's admin dir), and a NEW name at the common dir's root lands
 * in the tmpfs — visible to the run, gone when it exits, never written to the
 * user's repository.
 *
 * Two entries are deliberately NOT rebound: `packed-refs` and `packed-refs.lock`.
 *
 *  - git ≥ 2.5x takes `packed-refs.lock` on an ordinary `git commit` in a
 *    linked worktree even when the branch it updates is loose (measured on
 *    the CI runner's git 2.55; git 2.43 does not). The lock is a NEW name in
 *    the common dir, and a read-only mount cannot host one, so the previous
 *    arm — the common dir bound read-only outright — failed every commit on a
 *    modern git with `Unable to create '.git/packed-refs.lock': Read-only
 *    file system`. In the tmpfs the lock is creatable and disposable.
 *  - With `packed-refs` hidden, git sees a repository whose refs are all
 *    loose. It has no packed table to consult, lock or rewrite, so the one
 *    place deleting somebody else's branch would happen (a rewrite of that
 *    table) is not reachable at all, and a rewrite attempted anyway lands in
 *    the tmpfs. The cost is that the run cannot resolve any ref that exists
 *    ONLY packed — the user's `main` after `pack-refs`, typically. Nothing a
 *    sponsored procedure does needs another branch; it commits on its own.
 *
 * Hiding the table has one precondition, met on the host before the spawn:
 * the run's OWN branch must be loose, or HEAD would resolve to nothing and
 * the first commit would become an unrelated root commit. `pack-refs` moves a
 * branch into the table and removes its ref directory, so
 * `prepareLinkedWorktreeForLinux` reads the host's `packed-refs`, writes a
 * loose file for every ref under `refs/heads/<namespace>/` that lacks one
 * (exactly what git writes when it updates the ref; the packed entry is left
 * in place and a loose ref shadows it), and creates the two namespace
 * directories a writable bind needs as a SOURCE. Only the run's namespace is
 * touched, on the trusted side, with values read from the user's own table.
 *
 * This replaced two earlier shapes the first time the tests ran on a Linux
 * host (COD-435). A deny-list (common dir writable, dangerous paths covered
 * read-only) could not refuse a name that did not exist yet — a LOOSE
 * `refs/heads/main` on a packed repository would have let a run overwrite the
 * user's main branch. A plain read-only bind refused that, and also refused
 * git's lock. The tmpfs keeps the allowlist property and gives git its
 * scratch space, and `sdk/src/__tests__/sponsored-sandbox.test.ts` asserts
 * both halves: the existing entries stay `Read-only file system`, and nothing
 * written to a new name reaches the host.
 */
function prepareLinkedWorktreeForLinux(linked: SponsoredLinkedWorktree): void {
  const commonDir = path.resolve(linked.commonDir)
  if (!fs.existsSync(commonDir)) return
  const namespace = linked.branchNamespace.replace(/^\/+|\/+$/g, '')
  for (const dir of [
    path.join(commonDir, 'refs', 'heads', namespace),
    path.join(commonDir, 'logs', 'refs', 'heads', namespace),
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const packedRefsPath = path.join(commonDir, 'packed-refs')
  if (!fs.existsSync(packedRefsPath)) return
  const prefix = `refs/heads/${namespace}/`
  for (const line of fs.readFileSync(packedRefsPath, 'utf8').split('\n')) {
    // `<sha> <refname>`; `#` is the header, `^<sha>` a peeled tag line.
    if (line.startsWith('#') || line.startsWith('^')) continue
    const space = line.indexOf(' ')
    if (space === -1) continue
    const sha = line.slice(0, space)
    const ref = line.slice(space + 1).trim()
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !ref.startsWith(prefix)) continue
    // No traversal out of the namespace, whatever the table says.
    const rel = ref.slice('refs/heads/'.length)
    if (rel.split('/').some((part) => part === '' || part === '..')) continue
    const loose = path.join(commonDir, 'refs', 'heads', rel)
    if (fs.existsSync(loose)) continue
    fs.mkdirSync(path.dirname(loose), { recursive: true })
    fs.writeFileSync(loose, `${sha}\n`)
  }
}

/** Entries of the common dir that must not be rebound; see `prepareLinkedWorktreeForLinux`. */
const HIDDEN_COMMON_DIR_ENTRIES = new Set(['packed-refs', 'packed-refs.lock'])

/**
 * The mount plan for the common dir: an empty tmpfs, then every existing entry
 * except the hidden two rebound read-only at its own path. The writable grants
 * are bound afterwards by the caller, on top.
 */
function linuxCommonDirMounts(commonDir: string): string[] {
  const args = ['--tmpfs', commonDir]
  for (const entry of fs.readdirSync(commonDir).sort()) {
    if (HIDDEN_COMMON_DIR_ENTRIES.has(entry)) continue
    const target = path.join(commonDir, entry)
    args.push('--ro-bind', target, target)
  }
  return args
}

function spawnLinux(
  request: TerminalCommandSpawnRequest,
  writeRoots: string[],
  env: NodeJS.ProcessEnv,
  additionalReadRoots: string[],
  linkedWorktree: SponsoredLinkedWorktree | undefined,
  /** Read-only rebinds over the write roots; see the loop at the bottom. */
  denyWriteSubpaths: string[] = [],
): TerminalCommandProcess {
  const bwrap = findBubblewrap()
  if (!bwrap) {
    // Refuse, never downgrade. See the file docblock.
    throw new Error(
      'bubblewrap (bwrap) is required to contain a sponsored run on Linux.',
    )
  }
  // NO `--share-net`. bubblewrap has no firewall — it can give the run the
  // host's network namespace or a fresh empty one, and nothing in between —
  // so "network minus loopback", which is what the macOS profile above
  // expresses, is not sayable here. Faced with that, the run gets its own
  // empty namespace:
  //
  //   - loopback egress is the one that MATTERS. `--share-net` puts the run
  //     on the same 127.0.0.1 as the orchestrator, whose API pushes branches
  //     and opens pull requests with the user's real credentials.
  //   - nothing granted actually needs the sandbox to reach the internet.
  //     `read_url` and `web_search` — the two tools carrying the `network`
  //     capability — execute in the orchestrator's process, not in here, and
  //     dependency installs are refused outright (COD-336 item 5).
  //
  // So this diverges from the macOS arm, which keeps external egress, and the
  // divergence is deliberate: on Linux the choice is between blocking
  // loopback and keeping a capability nothing uses.
  const args = ['--die-with-parent', '--unshare-all', '--new-session']
  for (const dir of [
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/etc',
    '/opt',
  ]) {
    if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir)
  }
  const commonDir = linkedWorktree
    ? path.resolve(linkedWorktree.commonDir)
    : null
  for (const dir of additionalReadRoots) {
    if (!fs.existsSync(dir)) continue
    if (commonDir !== null && path.resolve(dir) === commonDir) {
      // The user's real `.git`: a tmpfs with the real entries rebound
      // read-only, not a plain read-only bind. See `prepareLinkedWorktreeForLinux`.
      args.push(...linuxCommonDirMounts(commonDir))
      continue
    }
    args.push('--ro-bind', dir, dir)
  }
  // `--dev /dev` mounts a FRESH devtmpfs the run owns, so the macOS device
  // problem does not exist on this arm: bubblewrap populates it with
  // null/zero/full/random/urandom/tty (writable, because the mount is the
  // run's own) plus the `/dev/fd -> /proc/self/fd` and stdin/stdout/stderr
  // symlinks, and it does NOT carry the host's block devices, `kmsg`, `mem`
  // or anything else. The macOS profile has to enumerate literals precisely
  // because seatbelt filters the host's real `/dev` rather than replacing it.
  //
  // Measured on Linux (bubblewrap 0.9.0, COD-435): the run's `/dev` holds
  // exactly core, fd, full, null, ptmx, pts, random, shm, stderr, stdin,
  // stdout, tty, urandom and zero, on a host whose `/dev` has 100+ entries.
  // `sdk/src/__tests__/sponsored-sandbox.test.ts` asserts that set.
  args.push('--proc', '/proc', '--dev', '/dev')
  // AFTER the read roots, which include the linked worktree's common dir as
  // a tmpfs with its entries rebound read-only: bubblewrap applies binds in
  // order, so these writable binds land on top and are the ONLY writable
  // paths under it that reach the host. `prepareLinkedWorktreeForLinux`
  // explains the tmpfs and creates the bind sources this needs.
  if (linkedWorktree) prepareLinkedWorktreeForLinux(linkedWorktree)
  for (const dir of writeRoots) {
    if (fs.existsSync(dir)) args.push('--bind', dir, dir)
  }
  // AFTER the writable binds, and that order IS the rule: bubblewrap applies
  // mounts in order, so a read-only bind here covers the writable one under
  // it. An in-place run's `.git` sits inside the workspace it must otherwise
  // be able to edit, so the tree is granted and this takes it back.
  for (const dir of denyWriteSubpaths) {
    if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir)
  }
  args.push('--chdir', request.cwd, '--clearenv')
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push('--setenv', key, value)
  }
  args.push(request.executable, ...request.args)
  return processHandle(
    spawn(bwrap, args, {
      cwd: request.cwd,
      // `bwrap` itself only needs a PATH; `--clearenv` plus the `--setenv`
      // pairs above are what the CHILD sees. Cast because some consumers
      // declare a required-key ProcessEnv, and inheriting keys to satisfy a
      // type would defeat the point of the scrub.
      env: { PATH: env.PATH } as unknown as NodeJS.ProcessEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
}

// ------------------------------------------------------ the Windows floor

/**
 * Which broker arm a sponsored run gets, or null for a refusal.
 *
 * macOS and Linux are their OS sandbox, full stop: a grant naming the floor
 * does not move them off it, and a sandbox that cannot start throws where it
 * stands rather than landing here. The floor is reachable only when BOTH are
 * true:
 *
 *  - `hostPlatform` (the platform this process is ACTUALLY running on, never
 *    an option a caller can set) is `win32`, and so is `platform`;
 *  - the server's grant names `desktop_windows` with `containment: 'floor'`.
 *
 * Everything else, Windows without that grant included, is null, and the
 * broker refuses to start a command.
 */
export type SponsoredBrokerArm = 'sandbox-exec' | 'bubblewrap' | 'floor'

export function sponsoredBrokerArm(input: {
  hostPlatform: NodeJS.Platform
  platform: NodeJS.Platform
  serverGrant?: SponsoredFloorGrantFacts | null
}): SponsoredBrokerArm | null {
  if (input.platform === 'darwin') return 'sandbox-exec'
  if (input.platform === 'linux') return 'bubblewrap'
  if (
    input.hostPlatform === 'win32' &&
    input.platform === 'win32' &&
    sponsoredComputeGrantNamesFloor(input.serverGrant)
  ) {
    return 'floor'
  }
  return null
}

/**
 * Windows PowerShell 5.1, by its fixed absolute path under the system root.
 *
 * THE SHELL DECISION (COD-642), and why this one:
 *
 *  - `powershell.exe` ships with every Windows 10 and 11 install, at this
 *    path. `pwsh` (PowerShell 7) is an optional install in no fixed place.
 *  - It is resolved by ABSOLUTE path, never looked up. Windows process
 *    creation searches the working directory before `PATH`, and the working
 *    directory here is a repository the advertiser's procedure is editing: a
 *    bare `powershell.exe` or `pwsh.exe` would run whatever the repository
 *    put there. `pwsh` has no fixed path to pin, which is the deciding reason.
 *  - One dialect, so a run on any Windows machine gets exactly the shell the
 *    model was told about (`RunOptions.terminalShell`).
 *
 * `cmd.exe` was not chosen: its quoting cannot carry an arbitrary command
 * safely through one argument. Git Bash (what an ordinary Desktop turn uses)
 * was not chosen either: it is an optional install, and a sponsored run must
 * not depend on the user having it. Commands are not translated here: the
 * model is told it is writing for Windows PowerShell 5.1.
 *
 * The system root comes from THIS process's environment, which is the user's
 * own, never from a run's.
 */
export function windowsPowerShellPath(
  env: Record<string, string | undefined> = getSystemProcessEnv(),
): string {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR].find(
    (value): value is string =>
      typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value),
  )
  return path.win32.join(
    root ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/** `taskkill.exe`, by absolute path for the same reason as PowerShell. */
function windowsTaskkillPath(): string {
  // <root>\System32\WindowsPowerShell\v1.0\powershell.exe -> <root>\System32
  const system32 = path.win32.dirname(
    path.win32.dirname(path.win32.dirname(windowsPowerShellPath())),
  )
  return path.win32.join(system32, 'taskkill.exe')
}

/**
 * The PowerShell switches every floor command runs with.
 *
 *  - `-NoProfile`: the user's profile scripts are not run. They are the user's
 *    code, can load modules and credentials, and are exactly the ambient state
 *    the floor exists to keep out of the run.
 *  - `-NonInteractive`: anything that would prompt fails instead of waiting on
 *    a console nobody can see.
 *  - `-ExecutionPolicy RemoteSigned`, for this process only: Node's own
 *    `npm.ps1`/`npx.ps1` shims are local scripts, and under the Windows client
 *    default (`Restricted`) `npm pkg get name` would fail before npm started.
 *    A policy set by Group Policy still wins over this switch. Why this is
 *    acceptable is in `docs/freebuff-sponsored-local-execution.md`, "The
 *    Desktop half (COD-642, 2026-09-24)".
 *  - `-Command`, then the command as ONE argument.
 */
export const SPONSORED_POWERSHELL_ARGS: readonly string[] = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'RemoteSigned',
  '-Command',
])

/**
 * Fixed, product-owned lines ahead of every floor command; never advertiser
 * text. Output as UTF-8, so what a command prints reaches the run intact (the
 * SDK decodes UTF-8, and PowerShell 5.1 otherwise writes the console code
 * page), and no progress records, which PowerShell 5.1 otherwise serializes
 * onto stderr as XML when its output is redirected.
 */
export const SPONSORED_POWERSHELL_PREAMBLE = [
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
].join('; ')

/** The per-run directories the floor points a Windows run at. */
export function sponsoredWindowsRunPaths(
  runtimeDir: string,
): SponsoredWindowsRunPaths {
  const home = path.join(runtimeDir, 'home')
  return {
    home,
    tmp: path.join(runtimeDir, 'tmp'),
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
  }
}

/**
 * What the floor spawns for one request. PURE, so the choice is testable on
 * any OS.
 *
 *  - A shell command (`request.command`, sent by `runTerminalCommand` because
 *    this broker owns its shell): PowerShell by absolute path, with the fixed
 *    switches, the preamble, and the command as a single argument.
 *  - Anything else (ripgrep for `code_search`): that executable directly, with
 *    no shell, and only by ABSOLUTE path, for the working-directory lookup
 *    reason given at {@link windowsPowerShellPath}.
 */
export function sponsoredWindowsFloorLaunch(
  request: TerminalCommandSpawnRequest,
  powershell: string = windowsPowerShellPath(),
): { file: string; args: string[] } {
  if (typeof request.command === 'string') {
    return {
      file: powershell,
      args: [
        ...SPONSORED_POWERSHELL_ARGS,
        `${SPONSORED_POWERSHELL_PREAMBLE}\n${request.command}`,
      ],
    }
  }
  if (!path.win32.isAbsolute(request.executable)) {
    throw new Error(
      'A sponsored run on Windows starts a program outside its shell only by absolute path.',
    )
  }
  return { file: request.executable, args: [...request.args] }
}

/**
 * A Windows process handle. No process groups here: a kill takes the whole
 * tree with `taskkill /T /F`, as the SDK's own Windows runner does. And, like
 * that runner, nothing is reaped after the command reports done: a descendant
 * the command started in the background and left running outlives it, because
 * once its parent has exited Windows can no longer name the tree.
 */
function windowsFloorProcessHandle(
  child: ReturnType<typeof spawn>,
): TerminalCommandProcess {
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  const isAlive = () =>
    Boolean(child.pid) && child.exitCode === null && child.signalCode === null
  return {
    pid: child.pid,
    stdout: child.stdout!,
    stderr: child.stderr!,
    completion,
    kill: (signal) => {
      if (child.pid && isAlive()) {
        const result = spawnSync(
          windowsTaskkillPath(),
          ['/pid', String(child.pid), '/t', '/f'],
          { stdio: 'ignore', windowsHide: true, timeout: 5_000 },
        )
        if (!result.error && result.status === 0) return
      }
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    },
    isAlive,
  }
}

/**
 * The Windows floor broker: no OS wrapper, the floor only. Built by
 * {@link createSponsoredTerminalBroker} for the `floor` arm and nothing else.
 */
function createWindowsFloorBroker(
  workspaceRoot: string,
  runtimeDir: string,
): TerminalCommandBroker {
  const paths = sponsoredWindowsRunPaths(runtimeDir)
  return {
    ownsShell: true,
    start(request) {
      assertSponsoredCommandCwd(workspaceRoot, request.cwd)
      for (const dir of [
        paths.home,
        paths.tmp,
        paths.appData,
        paths.localAppData,
      ]) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const env = scrubSponsoredWindowsEnv(request.env, paths)
      const launch = sponsoredWindowsFloorLaunch(request)
      return windowsFloorProcessHandle(
        spawn(launch.file, launch.args, {
          cwd: request.cwd,
          env: env as NodeJS.ProcessEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Hidden and NOT detached: with every stdio piped, a hidden child
          // gets a console with no window, and whatever it starts inherits
          // that console instead of opening a visible one of its own.
          windowsHide: true,
        }),
      )
    },
  }
}

/**
 * The broker a sponsored local run passes to `runTerminalCommand`.
 *
 * Note what it does to the env it is handed: it DISCARDS it and builds its
 * own. `runTerminalCommand` merges `getSystemProcessEnv()` into every request
 * before it reaches a broker, so a caller that only passed a scrubbed `env`
 * would still hand the child the user's whole environment. Scrubbing here, at
 * the last point before the spawn, is what makes that impossible to get wrong
 * from the outside.
 *
 * On Windows it is the floor broker, and only when {@link sponsoredBrokerArm}
 * says so; otherwise a Windows start throws exactly as it did before COD-642.
 */
export function createSponsoredTerminalBroker(
  options: SponsoredSandboxOptions,
): TerminalCommandBroker {
  const workspaceRoot = path.resolve(options.workspaceRoot)
  const runtimeDir = path.resolve(options.runtimeDir)
  const additionalReadRoots = (options.additionalReadRoots ?? []).map((item) =>
    path.resolve(item),
  )
  const platform = options.platform ?? process.platform
  if (
    sponsoredBrokerArm({
      hostPlatform: process.platform,
      platform,
      serverGrant: options.serverGrant,
    }) === 'floor'
  ) {
    return createWindowsFloorBroker(workspaceRoot, runtimeDir)
  }
  const linkedWorktree = options.linkedWorktree
  const scrubEnv = options.scrubEnv ?? scrubSponsoredLocalEnv
  const home = path.join(runtimeDir, 'home')
  const tmp = path.join(runtimeDir, 'tmp')
  // macOS only: which git the run's `git` names, resolved once per PATH so
  // the unsandboxed `xcrun` is asked at most once per broker. See
  // `sponsoredMacGitPath`.
  const macRunPaths = new Map<string, string | undefined>()
  const macGitHost: SponsoredMacGitDependencies = {
    ...SPONSORED_MAC_GIT_HOST,
    developerShims: () =>
      linkDeveloperShims({
        dir: path.join(runtimeDir, 'developer-shims'),
        developerGit: findXcodeDeveloperGit(),
      }),
  }
  const macRunPath = (value: string | undefined): string | undefined => {
    if (value === undefined) return value
    if (!macRunPaths.has(value)) {
      macRunPaths.set(value, sponsoredMacGitPath(value, macGitHost))
    }
    return macRunPaths.get(value)
  }

  return {
    start(request) {
      assertSponsoredCommandCwd(workspaceRoot, request.cwd)
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(tmp, { recursive: true })
      const env = scrubEnv(request.env, { home, tmp }) as NodeJS.ProcessEnv
      if (platform === 'darwin' && env.PATH !== undefined) {
        env.PATH = macRunPath(env.PATH)
      }
      // The linked worktree's grant, or nothing at all for a workspace that is
      // its own repository. Computed per start rather than once in the closure
      // because `packed-refs.lock` is canonicalised against a directory that
      // has to exist, and the worktree is created before the first command but
      // not necessarily before the broker.
      const git = linkedWorktree
        ? sponsoredLinkedWorktreeGrants(linkedWorktree)
        : { readSubpaths: [], writeSubpaths: [], writeLiterals: [] }
      const writeRoots = [workspaceRoot, runtimeDir, ...git.writeSubpaths]
      const readRoots = [...additionalReadRoots, ...git.readSubpaths]
      // An in-place run may READ the repository (`git status`, `git diff` and
      // `git log` are how a procedure understands the project) and may write
      // no part of it: no commit, no ref, and above all no `hooks/` or
      // `config`, which the orchestrator's own unsandboxed `git -C` would
      // then execute as the user.
      const denyWriteSubpaths = options.readOnlyGitDir
        ? [path.join(workspaceRoot, '.git')]
        : []
      if (platform === 'darwin') {
        return spawnMac(
          request,
          writeRoots,
          env,
          readRoots,
          git.writeLiterals,
          denyWriteSubpaths,
        )
      }
      if (platform === 'linux') {
        return spawnLinux(
          request,
          writeRoots,
          env,
          readRoots,
          linkedWorktree,
          denyWriteSubpaths,
        )
      }
      throw new Error(
        `A sponsored run cannot be contained on ${platform}, so it will not be started.`,
      )
    },
  }
}
