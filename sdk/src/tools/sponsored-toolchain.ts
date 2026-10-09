/**
 * The user's own Node toolchain, made READABLE to a sponsored run (COD-825).
 *
 * The sandbox gives the run a private `HOME` and mounts (Linux) or allows
 * (macOS) nothing of the real one. A Node, npm or bun the user installed under
 * their home folder (nvm, mise, fnm, bun, a `~/.local` prefix) therefore
 * vanished: the run saw `PATH` naming `~/.nvm/versions/node/v22/bin`, found
 * nothing there, and concluded the machine had no Node -- the largest single
 * cause of lost sponsored runs (`missing_node`, `npx_eperm`).
 *
 * This returns the folders to pass as `additionalReadRoots`, which both arms
 * already grant READ-ONLY: a seatbelt `subpath` read on macOS (canonicalised
 * with the kernel-resolved path), a `--ro-bind` on Linux. Nothing here is ever
 * writable; npm's cache stays under the run's private `HOME`.
 *
 * What is granted, all of it under the real home folder:
 *
 *  - every `PATH` entry that exists, under both its spelling and its real
 *    path (Linux has to see the spelling: fnm's `PATH` entry is a symlink);
 *  - the directory of the real path of `node`, `npx`, `npm`, `pnpm` and
 *    `bun`, as the first `PATH` hit names them. `npx` and `npm` are symlinks
 *    into `<prefix>/lib/node_modules/npm`, which is why `npx` used to fail
 *    with EPERM while a bare `node` ran;
 *  - for a Node-style prefix (`<prefix>/bin` beside `<prefix>/lib/node_modules`)
 *    the prefix's `bin` and `lib`, and deliberately NOT the prefix itself:
 *    `<prefix>/etc/npmrc` is npm's global config and can carry a registry
 *    token. npm treats an unreadable global config as absent.
 *
 * What is refused (skipped, with the reason logged):
 *
 *  - a folder outside the real home folder. The system trees are already
 *    readable on both arms; anything else is not this helper's business;
 *  - the home folder itself, or any ancestor of it;
 *  - a folder that is, contains, or sits inside a known secret location
 *    (`.ssh`, `.aws`, `.config/...`, `.npmrc`, ...), or that holds a
 *    credential file at its top level;
 *  - a folder that does not exist.
 *
 * The workspace's own secret deny rules are unaffected and still win: they
 * are emitted after every read grant on macOS and mounted over it on Linux.
 *
 * Out of scope (COD-825): shim managers that locate their data through
 * `$HOME` (volta's `~/.volta/bin`, asdf and mise shims). Their shim folders
 * are granted like any other `PATH` entry, but the shim then looks for its
 * data under the run's private `HOME` and fails. A `PATH` that names the
 * install directly (`mise activate`, nvm, fnm) works.
 */
import fs from 'fs'
import path from 'path'

/** The commands whose real paths are resolved and granted. */
export const SPONSORED_TOOLCHAIN_COMMANDS: readonly string[] = Object.freeze([
  'node',
  'npx',
  'npm',
  'pnpm',
  'bun',
])

/**
 * Paths under the home folder a grant may never be, contain, or sit inside.
 * `.config` whole, because no toolchain lives there and gcloud, gh, our own
 * config and most other credential stores do.
 */
const HOME_SECRET_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.netrc',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.git-credentials',
  '.gitconfig',
  '.password-store',
  '.vault-token',
  '.terraform.d',
  '.local/share/keyrings',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.m2',
  '.gradle',
  'Library',
]

/**
 * Toolchain folders inside one of {@link HOME_SECRET_PATHS}: pnpm's
 * standalone install defaults to `~/Library/pnpm` on macOS. Being inside one
 * of these is allowed; containing a secret path still refuses.
 */
const HOME_SECRET_EXCEPTIONS: readonly string[] = ['Library/pnpm']

/** Files whose presence at a grant's top level refuses the whole grant. */
const ROOT_CREDENTIAL_FILES: readonly string[] = [
  '.npmrc',
  '.netrc',
  '.env',
  '.git-credentials',
  '.pypirc',
  '.yarnrc.yml',
]

export interface SponsoredToolchainSkip {
  path: string
  reason:
    | 'missing'
    | 'outside_home'
    | 'home_or_ancestor'
    | 'secret_location'
    | 'credential_file'
}

export interface SponsoredToolchainReadRoots {
  /** Pass as `additionalReadRoots`. Absolute, deduplicated, sorted. */
  roots: string[]
  /** What was considered and refused, for the log. */
  skipped: SponsoredToolchainSkip[]
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

/** The first `PATH` hit for `command`, as `bash` would find it. */
function whichOnPath(command: string, entries: string[]): string | null {
  for (const entry of entries) {
    const candidate = path.join(entry, command)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      }
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}

/**
 * The folders a real directory stands for. A Node-style prefix's `bin`
 * becomes `bin` + `lib`; a folder inside `<prefix>/lib/node_modules` (where
 * `npm`'s real path lands) becomes the prefix's `bin` + `lib`; anything else
 * is itself.
 */
function installFolders(realDir: string): string[] {
  const marker = `${path.sep}lib${path.sep}node_modules`
  const index = realDir.indexOf(`${marker}${path.sep}`)
  const prefix =
    index >= 0 || realDir.endsWith(marker)
      ? realDir.slice(0, index >= 0 ? index : realDir.length - marker.length)
      : path.basename(realDir) === 'bin' &&
          isDirectory(path.join(path.dirname(realDir), 'lib', 'node_modules'))
        ? path.dirname(realDir)
        : null
  if (prefix === null) return [realDir]
  return [path.join(prefix, 'bin'), path.join(prefix, 'lib')].filter(
    isDirectory,
  )
}

/**
 * `target` with every directory above its deepest symlink component resolved,
 * and that component and everything below it kept as spelled. `target` itself
 * when nothing on it is a link.
 */
function throughLastLink(target: string): string {
  for (let at = target; at !== path.dirname(at); at = path.dirname(at)) {
    let isLink = false
    try {
      isLink = fs.lstatSync(at).isSymbolicLink()
    } catch {
      return target
    }
    if (!isLink) continue
    const parent = realpathOrNull(path.dirname(at))
    if (parent === null) return target
    return path.join(parent, path.basename(at), path.relative(at, target))
  }
  return target
}

/**
 * Why `candidate` (absolute, under some spelling of home) may not be granted,
 * or null when it may.
 */
function refusal(
  candidate: string,
  home: string,
): SponsoredToolchainSkip['reason'] | null {
  if (!isDirectory(candidate)) return 'missing'
  if (!isInside(candidate, home)) return 'outside_home'
  if (isInside(home, candidate)) return 'home_or_ancestor'
  for (const secret of HOME_SECRET_PATHS) {
    const secretPath = path.join(home, secret)
    if (isInside(secretPath, candidate)) return 'secret_location'
    if (
      isInside(candidate, secretPath) &&
      !HOME_SECRET_EXCEPTIONS.some((exception) =>
        isInside(candidate, path.join(home, exception)),
      )
    ) {
      return 'secret_location'
    }
  }
  for (const name of ROOT_CREDENTIAL_FILES) {
    if (fs.existsSync(path.join(candidate, name))) return 'credential_file'
  }
  return null
}

/**
 * The read roots for the user's own toolchain. Never throws: a toolchain that
 * cannot be granted leaves the run exactly as contained as it was before.
 */
export function sponsoredToolchainReadRoots(
  env: Record<string, string | undefined>,
  home: string,
  log?: (skip: SponsoredToolchainSkip) => void,
): SponsoredToolchainReadRoots {
  const roots = new Set<string>()
  const skipped: SponsoredToolchainSkip[] = []
  const realHome = realpathOrNull(home)
  if (!realHome || !path.isAbsolute(home)) return { roots: [], skipped }
  const lexicalHome = path.resolve(home)

  const seen = new Set<string>()
  const consider = (candidate: string, againstHome: string) => {
    const key = `${againstHome}\0${candidate}`
    if (seen.has(key)) return
    seen.add(key)
    const reason = refusal(candidate, againstHome)
    if (reason === null) {
      roots.add(candidate)
      return
    }
    // Not under this spelling of home: nothing to say, it is not ours.
    if (reason === 'outside_home') return
    const skip = { path: candidate, reason }
    skipped.push(skip)
    log?.(skip)
  }
  /** Grant `entry` (a directory) by its spelling and by what it really is. */
  const grantDirectory = (entry: string) => {
    const real = realpathOrNull(entry)
    if (real === null) {
      if (isInside(entry, lexicalHome) || isInside(entry, realHome)) {
        const skip = { path: entry, reason: 'missing' as const }
        if (!seen.has(`missing\0${entry}`)) {
          seen.add(`missing\0${entry}`)
          skipped.push(skip)
          log?.(skip)
        }
      }
      return
    }
    const folders = installFolders(real)
    for (const folder of folders) consider(folder, realHome)
    // The spelling too, when it differs: a symlinked PATH entry has to exist
    // at that spelling inside the Linux mount namespace for a lookup through
    // it to work, and so does its `../lib` -- `bin/npx` is a RELATIVE link
    // the kernel resolves from the spelling. The REAL path is what gets
    // checked, so a spelling only ever adds a mount point for content already
    // found safe.
    if (real !== entry && isInside(entry, lexicalHome)) {
      for (const folder of folders) {
        if (refusal(folder, realHome) !== null) continue
        const spelling = path.join(entry, path.relative(real, folder))
        consider(spelling, lexicalHome)
        // And with everything above its last symlink resolved: seatbelt
        // matches the path the kernel has reached when it meets that link
        // (`/private/var/...`, not `/var/...`), so a traverse grant on the
        // lexical spelling never matches the link it has to follow.
        const linked = throughLastLink(spelling)
        if (linked !== spelling && isInside(linked, realHome)) {
          consider(linked, realHome)
        }
      }
    }
  }

  const entries = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '' && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry))

  for (const entry of entries) {
    if (isInside(entry, lexicalHome) || isInside(entry, realHome)) {
      grantDirectory(entry)
    }
  }
  for (const command of SPONSORED_TOOLCHAIN_COMMANDS) {
    const found = whichOnPath(command, entries)
    if (found === null) continue
    const real = realpathOrNull(found)
    if (real === null) continue
    grantDirectory(path.dirname(real))
  }

  // Drop anything already covered by a broader grant.
  const sorted = [...roots].sort()
  const covered = sorted.filter(
    (root) => !sorted.some((other) => other !== root && isInside(root, other)),
  )
  return { roots: covered, skipped }
}
