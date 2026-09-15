/**
 * Undo snapshot store.
 *
 * Tracks the filesystem state before and after each assistant turn using a
 * dedicated, hidden git repository per project — the same approach as
 * OpenCode's snapshot service (`packages/opencode/src/snapshot/index.ts`).
 *
 * The snapshot repository never touches the project's real `.git`: every git
 * invocation runs with `--git-dir <snapshotDir> --work-tree <projectRoot>`.
 * A snapshot is the tree hash produced by `git write-tree` after staging the
 * project's changes, so restoring one is a matter of `git read-tree` +
 * `git checkout-index`. The source repository's object database is reused via
 * `objects/info/alternates` (with the source index copied) so the first
 * snapshot stays fast even on huge repositories.
 *
 * All operations are best-effort: a failure disables undo for that turn
 * rather than breaking the chat.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { getConfigDir } from './config-dir'
import { findGitRoot } from './git'
import { logger } from './logger'

/** Files larger than this are excluded from snapshots (same limit as OpenCode). */
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024

/** Absolute-path pathspec magic used with `--pathspec-from-file`. */
const topLevelLiteral = (file: string): string => `:(top,literal)${file}`

/**
 * Refs that keep a snapshot alive.
 *
 * `write-tree` returns a bare tree and nothing points at it, so git considers
 * it unreachable as soon as the snapshot index moves on with the next turn --
 * and the cleanup job's `gc --prune` collects it while the journal still lists
 * the entry. Pointing a ref at it is how git's own docs say to keep an object
 * around, and what other snapshot tools do.
 *
 * The ref is keyed by the journal entry's owner (the chat) so two chats can
 * hold the same tree without one of them releasing the other's copy. One ref
 * per live entry: `releaseSnapshot` drops it, which is what bounds the store.
 */
const ANCHOR_REF_PREFIX = 'refs/freebuff/undo/'

const anchorRefFor = (key: string, hash: string): string =>
  `${ANCHOR_REF_PREFIX}${key}/${hash}`

/**
 * Identity and signing for the anchor commit, set explicitly so the user's own
 * global git config (missing `user.email`, `commit.gpgsign` on) cannot fail it.
 */
const ANCHOR_GIT_CONFIG = [
  '-c',
  'user.name=freebuff',
  '-c',
  'user.email=freebuff@localhost',
  '-c',
  'commit.gpgsign=false',
]

type GitResult = {
  code: number
  stdout: string
  stderr: string
}

async function runGit(
  args: string[],
  cwd: string,
  options?: { input?: string; env?: Record<string, string> },
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
    if (options?.input) {
      child.stdin.write(options.input)
    }
    child.stdin.end()
  })
}

/** Serialize git operations per snapshot repo so concurrent tracks can't corrupt the index. */
const locks = new Map<string, Promise<unknown>>()

/** Hourly GC keeps snapshot repos from growing without bound (prune 7 days). */
const GC_INTERVAL_MS = 60 * 60 * 1000
const GC_PRUNE = '7.days'
const lastGcByDir = new Map<string, number>()

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(
    key,
    next.catch(() => {
      // Swallow so a failed op never wedges the chain for later ones.
    }),
  )
  return next
}

/** Where snapshot repos live. Test-overridable via setSnapshotDirOverrideForTesting. */
let snapshotDirOverride: string | undefined

export function setSnapshotDirOverrideForTesting(dir: string | undefined): void {
  snapshotDirOverride = dir
}

function getSnapshotBaseDir(): string {
  return snapshotDirOverride ?? path.join(getConfigDir(), 'undo-snapshots')
}

function snapshotDirFor(projectRoot: string): string {
  const key = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12)
  return path.join(getSnapshotBaseDir(), `${path.basename(projectRoot)}-${key}`)
}

/** git args that point every command at the snapshot repo, not the real one. */
const gitArgs = (
  snapshotDir: string,
  projectRoot: string,
  command: string[],
): string[] => ['--git-dir', snapshotDir, '--work-tree', projectRoot, ...command]

/** Whether undo can work for this project at all (it must be a git repo). */
export function isUndoAvailable(projectRoot: string): boolean {
  return findGitRoot({ cwd: projectRoot }) !== null
}

async function ensureInitialized(
  snapshotDir: string,
  projectRoot: string,
): Promise<boolean> {
  if (existsSync(snapshotDir)) return true
  try {
    mkdirSync(snapshotDir, { recursive: true })
    await runGit(['init'], projectRoot, {
      env: { GIT_DIR: snapshotDir, GIT_WORK_TREE: projectRoot },
    })
    const configArgs = ['--git-dir', snapshotDir, 'config']
    await runGit([...configArgs, 'core.autocrlf', 'false'], projectRoot)
    await runGit([...configArgs, 'core.longpaths', 'true'], projectRoot)
    await runGit([...configArgs, 'feature.manyFiles', 'true'], projectRoot)
    await runGit([...configArgs, 'index.version', '4'], projectRoot)
    await runGit([...configArgs, 'core.untrackedCache', 'true'], projectRoot)
    await seedFromSourceRepo(snapshotDir, projectRoot)
    return true
  } catch (error) {
    logger.debug({ error }, 'undo-snapshot: failed to initialize snapshot repo')
    return false
  }
}

/**
 * Reuse the source repo's object database (and index) so already-hashed file
 * content does not need re-hashing on the first snapshot. Best-effort.
 */
async function seedFromSourceRepo(
  snapshotDir: string,
  projectRoot: string,
): Promise<void> {
  try {
    const common = await runGit(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      projectRoot,
    )
    if (common.code !== 0) return
    const source = common.stdout.trim()
    if (!source || !existsSync(source)) return

    const sourceObjects = path.join(source, 'objects')
    if (!existsSync(sourceObjects)) return

    const alternatesDir = path.join(snapshotDir, 'objects', 'info')
    mkdirSync(alternatesDir, { recursive: true })
    writeFileSync(path.join(alternatesDir, 'alternates'), `${sourceObjects}\n`)

    const sourceIndex = path.join(source, 'index')
    if (existsSync(sourceIndex)) {
      copyFileSync(sourceIndex, path.join(snapshotDir, 'index'))
    }
  } catch (error) {
    logger.debug({ error }, 'undo-snapshot: failed to seed from source repo')
  }
}

/** Mirror the source repo's info/exclude plus blocked (oversized) files into the snapshot repo. */
function syncExcludes(
  snapshotDir: string,
  projectRoot: string,
  gitRoot: string | null,
  blocked: string[],
): void {
  try {
    const lines: string[] = []
    const sourceExclude = gitRoot
      ? path.join(gitRoot, '.git', 'info', 'exclude')
      : null
    if (sourceExclude && existsSync(sourceExclude)) {
      lines.push(...readFileSync(sourceExclude, 'utf8').split('\n'))
    }
    for (const file of blocked) {
      lines.push(`/${file.replaceAll('\\', '/')}`)
    }
    mkdirSync(path.join(snapshotDir, 'info'), { recursive: true })
    writeFileSync(
      path.join(snapshotDir, 'info', 'exclude'),
      `${lines.filter((line) => line.trim()).join('\n')}\n`,
    )
  } catch {
    // Best-effort.
  }
}

/**
 * Stage every changed, added, and deleted file (respecting the project's own
 * ignore rules and skipping files over the size limit) into the snapshot
 * index, so a following `write-tree` reflects the current state.
 * @returns false when git refused to stage something, in which case the index
 *  no longer describes the worktree and must not be turned into a snapshot.
 */
async function stageChanges(
  snapshotDir: string,
  projectRoot: string,
  gitRoot: string | null,
): Promise<boolean> {
  try {
    const base = gitArgs(snapshotDir, projectRoot, [])
    const [diff, others] = await Promise.all([
      runGit(
        [...base, 'diff-files', '--name-only', '-z', '--', '.'],
        projectRoot,
      ),
      runGit(
        [
          ...base,
          'ls-files',
          '--full-name',
          '--others',
          '--exclude-standard',
          '-z',
          '--',
          '.',
        ],
        projectRoot,
      ),
    ])
    const changed = diff.stdout.split('\0').filter(Boolean)
    const untracked = others.stdout.split('\0').filter(Boolean)
    const all = Array.from(new Set([...changed, ...untracked]))
    if (all.length === 0) return true

    const allowed: string[] = []
    const blocked: string[] = []
    for (const file of all) {
      try {
        const stat = statSync(path.join(projectRoot, file))
        if (stat.isFile() && stat.size > MAX_SNAPSHOT_FILE_BYTES) {
          blocked.push(file)
        } else {
          allowed.push(file)
        }
      } catch {
        // Deleted or unreadable — still stage the removal.
        allowed.push(file)
      }
    }

    syncExcludes(snapshotDir, projectRoot, gitRoot, blocked)

    if (allowed.length === 0) return true
    const pathspecs = `${allowed.map(topLevelLiteral).join('\0')}\0`
    const staged = await runGit(
      [
        ...base,
        'add',
        '--all',
        '--sparse',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      projectRoot,
      { input: pathspecs },
    )
    if (staged.code !== 0) {
      // git refused a path (unreadable file, bad name, ...). The index keeps
      // the state it had before, and `write-tree` would happily return the
      // tree of that stale index: a hash that looks valid and is not.
      logger.debug(
        { stderr: staged.stderr },
        'undo-snapshot: git add failed, snapshot would be stale',
      )
      return false
    }
    return true
  } catch (error) {
    logger.debug({ error }, 'undo-snapshot: failed to stage changes')
    return false
  }
}

/**
 * Run git and return its trimmed stdout, or null when it failed.
 *
 * The journal's anchoring is synchronous on purpose. `saveUndoState` already
 * writes its file synchronously, and an entry must never be listed before its
 * snapshot is anchored -- the sweep reads the anchors and relies on that.
 * These calls only touch refs and objects, never the index, so they do not
 * contend with the staged operations above, which stay on the async path.
 */
function gitSync(args: string[], projectRoot: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (error) {
    logger.debug({ error }, 'undo-snapshot: git command failed')
    return null
  }
}

/**
 * Keep a snapshot out of git's reach by pointing a ref at it, so the cleanup
 * job's prune cannot collect a snapshot the journal still lists.
 * @returns the ref name, or null when it could not be created.
 */
export function anchorSnapshot(
  projectRoot: string,
  key: string,
  hash: string,
): string | null {
  if (!hash) return null
  if (!findGitRoot({ cwd: projectRoot })) return null
  const snapshotDir = snapshotDirFor(projectRoot)
  const base = ['--git-dir', snapshotDir, '--work-tree', projectRoot]
  const commit = gitSync(
    [
      ...ANCHOR_GIT_CONFIG,
      ...base,
      'commit-tree',
      hash,
      '-m',
      'freebuff undo snapshot',
    ],
    projectRoot,
  )
  if (!commit) return null
  const ref = anchorRefFor(key, hash)
  // `update-ref` prints nothing on success, so compare against null rather
  // than truthiness: an empty string is the happy path here.
  return gitSync([...base, 'update-ref', ref, commit], projectRoot) !== null
    ? ref
    : null
}

/**
 * Drop a snapshot's anchor so the cleanup job can reclaim it. The journal
 * calls this when it stops listing an entry (eviction, or the redo stack a new
 * turn clears).
 */
export function releaseSnapshot(
  projectRoot: string,
  key: string,
  hash: string,
): boolean {
  if (!hash) return false
  if (!findGitRoot({ cwd: projectRoot })) return false
  const snapshotDir = snapshotDirFor(projectRoot)
  return (
    gitSync(
      [
        '--git-dir',
        snapshotDir,
        '--work-tree',
        projectRoot,
        'update-ref',
        '-d',
        anchorRefFor(key, hash),
      ],
      projectRoot,
    ) !== null
  )
}

/**
 * The anchors the snapshot repo is holding, as `{ key, hash }` pairs. The
 * journal sweeps its entries against this list.
 */
export function listAnchors(
  projectRoot: string,
): { key: string; hash: string }[] {
  if (!findGitRoot({ cwd: projectRoot })) return []
  const snapshotDir = snapshotDirFor(projectRoot)
  const refs = gitSync(
    [
      '--git-dir',
      snapshotDir,
      '--work-tree',
      projectRoot,
      'for-each-ref',
      '--format=%(refname)',
      ANCHOR_REF_PREFIX,
    ],
    projectRoot,
  )
  if (!refs) return []
  return refs
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(ANCHOR_REF_PREFIX))
    .map((ref) => {
      const rest = ref.slice(ANCHOR_REF_PREFIX.length)
      const separator = rest.indexOf('/')
      if (separator <= 0) return null
      const key = rest.slice(0, separator)
      const hash = rest.slice(separator + 1)
      return key && hash && !hash.includes('/') ? { key, hash } : null
    })
    .filter((entry): entry is { key: string; hash: string } => entry !== null)
}

/**
 * Capture a snapshot of the project's current state.
 *
 * The returned tree is not referenced by anything, so it only survives while
 * its caller anchors it (`anchorSnapshot`). The cleanup job's prune has a
 * grace period of days, which leaves room to anchor after the turn instead of
 * on this path.
 *
 * @returns the snapshot hash, or null when unavailable/failed.
 */
export async function trackSnapshot(projectRoot: string): Promise<string | null> {
  const gitRoot = findGitRoot({ cwd: projectRoot })
  if (!gitRoot) return null
  const snapshotDir = snapshotDirFor(projectRoot)
  return withLock(snapshotDir, async () => {
    try {
      if (!(await ensureInitialized(snapshotDir, projectRoot))) return null
      // A failed stage leaves the index stale, and `write-tree` would still
      // return that stale tree. Refuse rather than hand back a hash that
      // would later revert the worktree to the wrong state.
      if (!(await stageChanges(snapshotDir, projectRoot, gitRoot))) return null
      const result = await runGit(
        [...gitArgs(snapshotDir, projectRoot, ['write-tree'])],
        projectRoot,
      )
      const hash = result.code === 0 ? result.stdout.trim() : ''
      if (!hash) return null
      void maybePrune(snapshotDir, projectRoot)
      return hash
    } catch (error) {
      logger.debug({ error }, 'undo-snapshot: track failed')
      return null
    }
  })
}

/**
 * Run `git gc --prune=7.days` at most once per hour per snapshot repo.
 * Fire-and-forget; never throws.
 */
async function maybePrune(snapshotDir: string, projectRoot: string): Promise<void> {
  const last = lastGcByDir.get(snapshotDir) ?? 0
  if (Date.now() - last < GC_INTERVAL_MS) return
  lastGcByDir.set(snapshotDir, Date.now())
  const result = await runGit(
    ['--git-dir', snapshotDir, 'gc', `--prune=${GC_PRUNE}`],
    projectRoot,
  )
  if (result.code !== 0) {
    logger.debug({ stderr: result.stderr }, 'undo-snapshot: gc failed')
  }
}

/**
 * List the files that changed since the given snapshot.
 * @returns project-relative file paths (empty when nothing changed).
 */
export async function patchSnapshot(
  projectRoot: string,
  hash: string,
): Promise<string[]> {
  const gitRoot = findGitRoot({ cwd: projectRoot })
  if (!gitRoot) return []
  const snapshotDir = snapshotDirFor(projectRoot)
  return withLock(snapshotDir, async () => {
    try {
      if (!(await stageChanges(snapshotDir, projectRoot, gitRoot))) return []
      const result = await runGit(
        [
          ...gitArgs(snapshotDir, projectRoot, [
            'diff',
            '--cached',
            '--no-ext-diff',
            '--name-only',
            hash,
            '--',
            '.',
          ]),
        ],
        projectRoot,
      )
      if (result.code !== 0) return []
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch (error) {
      logger.debug({ error }, 'undo-snapshot: patch failed')
      return []
    }
  })
}

/** Restore the entire worktree to a snapshot. Returns false on failure. */
export async function restoreSnapshot(
  projectRoot: string,
  hash: string,
): Promise<boolean> {
  const gitRoot = findGitRoot({ cwd: projectRoot })
  if (!gitRoot) return false
  const snapshotDir = snapshotDirFor(projectRoot)
  return withLock(snapshotDir, async () => {
    try {
      const base = gitArgs(snapshotDir, projectRoot, [])
      const read = await runGit([...base, 'read-tree', hash], projectRoot)
      if (read.code !== 0) return false
      const checkout = await runGit(
        [...base, 'checkout-index', '-a', '-f'],
        projectRoot,
      )
      return checkout.code === 0
    } catch (error) {
      logger.debug({ error }, 'undo-snapshot: restore failed')
      return false
    }
  })
}

/**
 * Whether a snapshot can still be restored from.
 *
 * A stored hash is a tree the journal kept by hand, and it can be gone: the
 * cleanup job collected it before this module started anchoring snapshots, or
 * the snapshot directory was wiped while `undo.json` stayed behind. Callers
 * must ask before reverting.
 *
 * The tree surviving is not enough on its own. This module borrows the
 * project's object database, so the project's own cleanup can collect a blob
 * a kept tree still lists. Restoring from such a tree is not merely partial:
 * `git checkout` removes the worktree file whose content it cannot read, so a
 * snapshot with holes deletes files instead of restoring them. Ask about the
 * content too.
 *
 * Assumes the caller already holds the snapshot repo's lock.
 */
async function snapshotIsComplete(
  snapshotDir: string,
  projectRoot: string,
  hash: string,
): Promise<boolean> {
  const base = gitArgs(snapshotDir, projectRoot, [])
  const tree = await runGit([...base, 'cat-file', '-e', hash], projectRoot)
  if (tree.code !== 0) return false
  // One command reports every object the tree references and cannot find,
  // marking each with a leading `?`.
  const objects = await runGit(
    [...base, 'rev-list', '--objects', '--missing=print', hash],
    projectRoot,
  )
  if (objects.code !== 0) return false
  return !objects.stdout
    .split('\n')
    .some((line) => line.trimStart().startsWith('?'))
}

export async function isSnapshotAvailable(
  projectRoot: string,
  hash: string,
): Promise<boolean> {
  if (!hash) return false
  const gitRoot = findGitRoot({ cwd: projectRoot })
  if (!gitRoot) return false
  const snapshotDir = snapshotDirFor(projectRoot)
  return withLock(snapshotDir, async () => {
    try {
      return await snapshotIsComplete(snapshotDir, projectRoot, hash)
    } catch (error) {
      logger.debug({ error }, 'undo-snapshot: availability check failed')
      return false
    }
  })
}

/**
 * Restore a specific set of files to a snapshot. Files that did not exist in
 * the snapshot (created after it) are deleted.
 * @returns the files that were restored and the files that were deleted.
 */
export async function revertFiles(
  projectRoot: string,
  hash: string,
  files: string[],
): Promise<{ restored: string[]; deleted: string[] }> {
  const empty = { restored: [] as string[], deleted: [] as string[] }
  const gitRoot = findGitRoot({ cwd: projectRoot })
  if (!gitRoot || files.length === 0) return empty
  const snapshotDir = snapshotDirFor(projectRoot)
  return withLock(snapshotDir, async () => {
    const result = { restored: [] as string[], deleted: [] as string[] }
    try {
      // Never start reverting against content that is not all there: the
      // checkout below deletes a file whose blob it cannot read, so a snapshot
      // with holes would destroy the worktree instead of restoring it.
      if (!(await snapshotIsComplete(snapshotDir, projectRoot, hash))) {
        logger.debug(
          { hash },
          'undo-snapshot: snapshot incomplete, leaving the worktree alone',
        )
        return result
      }
      const base = gitArgs(snapshotDir, projectRoot, [])
      const root = path.resolve(projectRoot)
      for (const file of files) {
        // Defense in depth: never touch a path that escapes the project.
        const resolved = path.resolve(root, file)
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          continue
        }
        const checkout = await runGit(
          [...base, 'checkout', hash, '--', file],
          projectRoot,
        )
        if (checkout.code === 0) {
          result.restored.push(file)
          continue
        }
        const tree = await runGit(
          [...base, 'ls-tree', hash, '--', file],
          projectRoot,
        )
        if (tree.code !== 0) {
          // The snapshot's tree itself is unreachable, so there is no way to
          // tell whether this file was in it. Reading "we could not look" as
          // "the turn created it" is how a missing snapshot deletes files the
          // user had: leave the worktree alone instead.
          logger.debug(
            { file, hash },
            'undo-snapshot: snapshot missing, leaving the file as it is',
          )
          continue
        }
        if (tree.stdout.trim()) {
          // It was in the snapshot, but bringing its content back did not work
          // and the tree alone cannot say why (a collected object, most
          // likely). Leave the file as it is and do not report a restore that
          // did not happen: the caller's summary has to stay true.
          logger.debug(
            { file, hash },
            'undo-snapshot: content unavailable, leaving the file as it is',
          )
          continue
        }
        // Really was not in the snapshot — the turn created it.
        try {
          rmSync(resolved, { force: true })
          result.deleted.push(file)
        } catch {
          // Keep going with the remaining files.
        }
      }
      return result
    } catch (error) {
      logger.debug({ error }, 'undo-snapshot: revert failed')
      return result
    }
  })
}

/**
 * Compact diff stat of everything that changed since a snapshot (used in the
 * /undo result message). Empty string when there is nothing or on failure.
 */
export async function diffSnapshot(
  projectRoot: string,
  hash: string,
): Promise<string> {
  const gitRoot = findGitRoot({ cwd: projectRoot })
  if (!gitRoot) return ''
  const snapshotDir = snapshotDirFor(projectRoot)
  return withLock(snapshotDir, async () => {
    try {
      if (!(await stageChanges(snapshotDir, projectRoot, gitRoot))) return ''
      const result = await runGit(
        [
          ...gitArgs(snapshotDir, projectRoot, [
            'diff',
            '--cached',
            '--no-ext-diff',
            '--stat',
            hash,
            '--',
            '.',
          ]),
        ],
        projectRoot,
      )
      return result.code === 0 ? result.stdout : ''
    } catch {
      return ''
    }
  })
}
