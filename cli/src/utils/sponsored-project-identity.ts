/**
 * Persistent opaque identity for a local Git project.
 *
 * This runs from project selection, not any ad request. The marker provides a
 * stable server key for the project while keeping the local path on the
 * device. A later sponsored capability inspection only reads it.
 *
 * ## Every repository, in Freebuff (#3989's in-place flow)
 *
 * An in-place sponsored offer is keyed to the FOLDER, never to `owner/repo`:
 * the offer, its Accept and its undo must all mean this checkout, and two
 * clones of one repository are two places a run could edit. The offer route
 * refuses an in-place request without this id, so a Freebuff CLI writes it in
 * every Git project it opens -- the same thing Desktop has always done in
 * every project it opens (`freebuff-desktop/src/server/repo/project-db.ts`).
 * Codebuff keeps the old rule: a marker only where no GitHub remote can key
 * the project.
 *
 * ## Without dirtying the repository
 *
 * The marker's directory is added to `.git/info/exclude` -- the repository's
 * LOCAL ignore list, which is never committed or shared -- unless something
 * already ignores it. So `git status` stays clean and nothing the CLI wrote
 * can be committed by accident. A repository that already ignores `.freebuff/`
 * is left alone.
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { repoFullNameFromRemote } from '@codebuff/common/ads/sponsored-proposal-target'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const GIT_TIMEOUT_MS = 5_000

/** Git resolves worktrees, includes and quoted remote values for us. */
function git(
  root: string,
  args: string[],
): { status: number | null; stdout: string } {
  try {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    })
    return { status: result.status, stdout: result.stdout ?? '' }
  } catch {
    return { status: null, stdout: '' }
  }
}

function originRemoteUrl(root: string): string | null {
  const result = git(root, ['remote', 'get-url', 'origin'])
  return result.status === 0 ? result.stdout.trim() : null
}

const EXCLUDE_LINE = '/.freebuff/'

/**
 * The repository's LOCAL exclude file. Read straight off `<root>/.git` in the
 * ordinary layout, so the common case costs no subprocess on every launch;
 * asked of git (`--git-path`) only for a linked worktree, whose `.git` is a
 * file.
 */
function localExcludePath(root: string): string | null {
  try {
    if (statSync(join(root, '.git')).isDirectory()) {
      return join(root, '.git', 'info', 'exclude')
    }
  } catch {
    return null
  }
  const pathResult = git(root, ['rev-parse', '--git-path', 'info/exclude'])
  if (pathResult.status !== 0) return null
  const relative = pathResult.stdout.trim()
  if (!relative) return null
  return isAbsolute(relative) ? relative : join(root, relative)
}

/**
 * Keep `.freebuff/` out of `git status` with the LOCAL exclude file. Best
 * effort: a repository we cannot write the exclude for still gets its marker,
 * which is no worse than Desktop.
 *
 * OUR LINE IS THE TEST, not `git check-ignore`. That reports a TRACKED path
 * (or one a `.gitignore` negation re-includes) as not ignored whatever the
 * exclude says, so deciding on it alone appended another copy on every
 * launch. `check-ignore` is asked only before writing, so a repository that
 * already ignores the folder some other way is not given a redundant line.
 */
export function excludeFreebuffDirectory(root: string): void {
  const exclude = localExcludePath(root)
  if (!exclude) return
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) {
      return
    }
    if (
      git(root, ['check-ignore', '-q', '.freebuff/project-id']).status === 0
    ) {
      return
    }
    mkdirSync(dirname(exclude), { recursive: true })
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    appendFileSync(
      exclude,
      `${separator}# Freebuff's local project state\n${EXCLUDE_LINE}\n`,
    )
  } catch {
    // Best effort; see above.
  }
}

export function ensureSponsoredProjectIdentity(
  root: string,
  options: { everyRepository?: boolean } = {},
): string | null {
  // A non-project directory (including a home-directory launch) never gets a
  // product marker merely because the CLI started there.
  if (!existsSync(join(root, '.git'))) return null
  // Outside Freebuff a UUID is only a fallback: do not write into a
  // repository when a supported remote identity is present.
  if (!options.everyRepository && repoFullNameFromRemote(originRemoteUrl(root)))
    return null
  const directory = join(root, '.freebuff')
  const marker = join(directory, 'project-id')
  try {
    const current = readFileSync(marker, 'utf8').trim().toLowerCase()
    if (!UUID.test(current)) return null
    if (options.everyRepository) excludeFreebuffDirectory(root)
    return current
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    )
      return null
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const identity = randomUUID()
    const temporary = `${marker}.tmp-${randomUUID()}`
    writeFileSync(temporary, `${identity}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, marker)
    if (options.everyRepository) excludeFreebuffDirectory(root)
    return identity
  } catch {
    return null
  }
}
