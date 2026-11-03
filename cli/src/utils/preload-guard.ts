/**
 * Report an injected Bun preload, and decide in code whether to run anyway.
 *
 * `BUN_OPTIONS=--preload <file>` runs caller code inside this process before
 * the first line of the shipped entry, which is how a capture bridge takes a
 * sponsored grant without ever sending a request (poc/claude-code-bridge;
 * `poc/cli-env-inheritance` measured the channel on the published binaries).
 *
 * This is a SPEED BUMP, not a barrier, and it says so on purpose: a preload
 * runs before this check, so it can rewrite `process.execArgv` and drop itself
 * from `require.cache`. What it buys is that capture stops being one
 * environment variable and becomes a patched binary — a different act, with a
 * different ban story.
 *
 * Every module the compiled binary ships lives under `/$bunfs/`; a path
 * outside it was not loaded by this build.
 */

/** The prefix of every module inside a compiled Bun binary. */
export const BUNDLE_PREFIX = '/$bunfs/'

/** The flags Bun honours as "load this file before the entry point". */
const PRELOAD_FLAGS = ['--preload', '-r', '--require'] as const

function foreignPath(candidate: string | undefined): string | null {
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  return trimmed.startsWith(BUNDLE_PREFIX) ? null : trimmed
}

/**
 * The first injected preload path, or null. Pure: the caller supplies both
 * channels, so this is testable without a Bun process.
 *
 * `execArgv` is the channel measured on the published binary. `loadedModules`
 * (the keys of `require.cache`) is best-effort: a compiled binary reports its
 * own modules under the bundle prefix, and may report none at all.
 *
 * `cwd` excludes that module channel under the working directory, and it is
 * there for one measured reason: Bun also reads `preload` from a `bunfig.toml`
 * in the current directory, so the CLI run inside a user's own repository
 * would otherwise see that repository's setup file in the cache and refuse to
 * start — a false stop on ordinary use. Measured 2026-10-27: a `bunfig.toml`
 * preload executes in this process and never appears in `execArgv`, so this
 * check cannot tell a repository's own setup file from an injection anyway;
 * excluding `cwd` states that instead of pretending otherwise.
 */
export function foreignPreloadFrom(input: {
  execArgv: readonly string[]
  loadedModules?: readonly string[]
  cwd?: string
}): string | null {
  const argv = input.execArgv
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if ((PRELOAD_FLAGS as readonly string[]).includes(arg)) {
      const next = foreignPath(argv[index + 1])
      if (next) return next
      continue
    }
    for (const flag of PRELOAD_FLAGS) {
      const prefix = `${flag}=`
      if (!arg.startsWith(prefix)) continue
      const value = foreignPath(arg.slice(prefix.length))
      if (value) return value
    }
  }
  const cwd = input.cwd?.replace(/\/+$/, '')
  for (const modulePath of input.loadedModules ?? []) {
    if (cwd && (modulePath === cwd || modulePath.startsWith(`${cwd}/`)))
      continue
    const foreign = foreignPath(modulePath)
    if (foreign) return foreign
  }
  return null
}

/**
 * Whether a build stops on an injected preload.
 *
 * A build-time decision, not a runtime one: asking a user to set an environment
 * variable to get a security control is how controls end up unset, and asking
 * them to unset it is how a legitimate instrumentation hook strands a whole
 * machine. The build ships one policy; the user launches the CLI and nothing
 * else. A hardened distribution flips this to `true` in its own build.
 *
 * Default is `false` on purpose: the preload has already run by the time this
 * check executes, so stopping cannot undo it - it can only remove the CLI from
 * a user whose toolchain loads a module this way.
 */
export const REFUSE_FOREIGN_PRELOAD = false

/**
 * One line for stderr. Names the path; does not explain how to evade it, and
 * asks the user for nothing.
 *
 * It never says "refused to start" unless this build actually refuses - a
 * message that claims a stop that did not happen sends whoever reads it after
 * the wrong thing (that wording shipped once, in `describeForeignPreload`'s
 * `enforced` branch, and is why the mode is no longer a variable).
 */
export function describeForeignPreload(preloadPath: string): string {
  return [
    `freebuff warning: code was injected into this process before it began (${preloadPath}).`,
    'It has already run; the CLI continues.',
  ].join('\n')
}
