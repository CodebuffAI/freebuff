/**
 * The capability probe's git questions, with the expensive one remembered.
 *
 * Both callers of the capability probe -- the ad request
 * (`ads/ad-request.ts`) and the agentic offer (`sponsored-offer.ts`) -- ask
 * the same questions of the same folder, often seconds apart. Three of them
 * are cheap and always asked live, so HEAD, origin's URL and whether git
 * trusts the folder are never stale, whatever config or environment decides
 * them. The fourth, `ls-files`, reads the whole index and is the cost in a
 * large checkout: its answer is reused per project root while the index
 * file is unchanged.
 *
 * Git itself names the index (`rev-parse --git-path index`, asked in the same
 * call as the work-tree check), so a linked worktree, `GIT_DIR` and
 * `GIT_INDEX_FILE` all key the cache on the file git actually reads. Git
 * rewrites the index by renaming a new file over it, so staging, a commit or
 * a checkout changes its inode, size or mtime. So does a `git status` stat
 * refresh: that costs a re-probe, never a stale answer. An index written
 * within the last two seconds is not trusted as a key (git's own "racy"
 * rule), so a coarse-timestamp filesystem cannot hide a same-size rewrite.
 * The TTL is only a backstop for what the key cannot see (output config such
 * as `core.quotePath`), so it is longer than the CLI's ad cadence.
 */
import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { GitResult, GitRunner } from './sponsored-git'

export type GitProbes = {
  inside: GitResult
  remote: GitResult
  tracked: GitResult
  head: GitResult
}

type Tracked = { indexKey: string; at: number; result: Promise<GitResult> }

/**
 * Per root: where git said the index lives, and the `ls-files` answer (kept
 * as its promise, so concurrent callers share one) read under an index key.
 */
export type TrackedFilesCache = {
  now: () => number
  indexPath: (root: string) => string | undefined
  /** Null when git finds no work tree at `root`: forgets the root. */
  rememberIndexPath: (root: string, path: string | null) => void
  /** Reuse a live answer for this index and key, or run `ls-files` and keep it. */
  tracked: (
    root: string,
    indexPath: string,
    indexKey: string,
    run: () => Promise<GitResult>,
  ) => { result: Promise<GitResult>; hit: boolean }
}

const TRACKED_TTL_MS = 10 * 60_000
const RACY_MS = 2_000
const MAX_ROOTS = 16

export function createTrackedFilesCache(
  options: { ttlMs?: number; now?: () => number } = {},
): TrackedFilesCache {
  const ttlMs = options.ttlMs ?? TRACKED_TTL_MS
  const now = options.now ?? Date.now
  // Insertion order is recency order: a use moves a root to the back, and
  // the front is evicted when full, its file list with it.
  type Entry = {
    indexPath: string
    tracked?: Tracked
    expiry?: ReturnType<typeof setTimeout>
  }
  const roots = new Map<string, Entry>()
  // The one place an answer is replaced or dropped, so its expiry timer
  // (which holds the list) never outlives it.
  const setTracked = (entry: Entry, tracked?: Tracked) => {
    if (entry.expiry) clearTimeout(entry.expiry)
    entry.expiry = undefined
    entry.tracked = tracked
  }
  const drop = (root: string) => {
    const entry = roots.get(root)
    if (entry) setTracked(entry)
    roots.delete(root)
  }
  /** The root's entry for `indexPath`, most recent, created or reset. */
  const upsert = (root: string, indexPath: string): Entry => {
    const entry = roots.get(root) ?? { indexPath }
    roots.delete(root)
    roots.set(root, entry)
    if (entry.indexPath !== indexPath) {
      entry.indexPath = indexPath
      setTracked(entry)
    }
    if (roots.size > MAX_ROOTS) drop(roots.keys().next().value as string)
    return entry
  }
  return {
    now,
    indexPath: (root) => roots.get(root)?.indexPath,
    rememberIndexPath(root, path) {
      if (path === null) drop(root)
      else upsert(root, path)
    },
    tracked(root, indexPath, indexKey, run) {
      const entry = upsert(root, indexPath)
      const kept = entry.tracked
      if (kept && kept.indexKey === indexKey && now() - kept.at < ttlMs)
        return { result: kept.result, hit: true }
      const result = run()
      const tracked = { indexKey, at: now(), result }
      setTracked(entry, tracked)
      const forget = () => {
        if (entry.tracked === tracked) setTracked(entry)
      }
      // Only a clean answer is kept: a timeout (killed, exit 143), a missing
      // git (-1) or any other failure is asked again next time. An unused
      // answer is dropped at its TTL, so an idle session holds no file list.
      result.then((answer) => {
        if (entry.tracked !== tracked) return
        if (answer.exitCode !== 0) return forget()
        tracked.at = now()
        entry.expiry = setTimeout(forget, ttlMs)
        entry.expiry.unref?.()
      }, forget)
      return { result, hit: false }
    },
  }
}

export const sharedTrackedFilesCache: TrackedFilesCache =
  createTrackedFilesCache()

/**
 * The index file's identity, or null when it cannot be trusted as a key: it
 * is missing (nothing staged yet) or was written too recently to tell apart.
 */
export function indexKey(path: string, now: number): string | null {
  try {
    const stat = statSync(path)
    if (now - Math.max(stat.mtimeMs, stat.ctimeMs) < RACY_MS) return null
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    return null
  }
}

/**
 * The four answers the capability probe reads, always asked together so a
 * runner that rejects is handled in one place. `inside` carries only the
 * work-tree line, as its own call used to.
 *
 * `ls-files` is keyed on the index path git named last time (on a first
 * probe, the ordinary `.git/index`), statted BEFORE it runs: an index that
 * changes while it runs leaves a key that no longer matches. If git now
 * names a different index, the answer is thrown away and asked again.
 */
export async function sponsoredGitProbes(
  rootInput: string,
  git: GitRunner,
  cache: TrackedFilesCache | null,
): Promise<GitProbes> {
  const root = resolve(rootInput)
  const lsFiles = () => git(['-C', root, 'ls-files'])
  const keyedPath = cache?.indexPath(root) ?? join(root, '.git', 'index')
  const key = cache ? indexKey(keyedPath, cache.now()) : null
  const keyed = key ? cache!.tracked(root, keyedPath, key, lsFiles) : null
  const [located, remote, tracked, head] = await Promise.all([
    git([
      '-C',
      root,
      'rev-parse',
      '--is-inside-work-tree',
      ...(cache ? ['--git-path', 'index'] : []),
    ]),
    git(['-C', root, 'remote', 'get-url', 'origin']),
    keyed?.result ?? lsFiles(),
    git(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
  ])
  const [workTree = '', gitPath] = located.stdout.split('\n')
  const probes = {
    inside: { ...located, stdout: `${workTree}\n` },
    remote,
    tracked,
    head,
  }
  if (!cache) return probes
  const insideOk = located.exitCode === 0 && workTree.trim() === 'true'
  // Forget the root only when git answered cleanly that it is no work tree
  // (`false`, or 128: not a repository); a timed-out or failed git keeps it.
  if (!insideOk) {
    if (located.exitCode === 0 || located.exitCode === 128)
      cache.rememberIndexPath(root, null)
    return probes
  }
  const path = gitPath?.trim()
  const named = path ? (isAbsolute(path) ? path : join(root, path)) : null
  cache.rememberIndexPath(root, named)
  // A different index (a new repository, a worktree conversion) resets the
  // root above. A fresh `ls-files` already read the index git uses; a
  // REUSED answer from the old one is not served, and its replacement is
  // kept under the new index.
  if (keyed?.hit && named !== keyedPath) {
    const newKey = named ? indexKey(named, cache.now()) : null
    const fresh =
      named && newKey
        ? cache.tracked(root, named, newKey, lsFiles).result
        : lsFiles()
    return { ...probes, tracked: await fresh }
  }
  return probes
}
