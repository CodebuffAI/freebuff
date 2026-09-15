/**
 * What a sponsored proposal in this terminal is ABOUT (COD-339).
 *
 * `owner/name`, read from the project root's `origin` remote through the
 * shared normalizer, so the same repository sees the same offer whether it is
 * opened here, on Desktop, or on Freebuff Web. A folder with no GitHub remote
 * gets no card at all — that is the design, not a gap: without a stable name
 * there is nothing to key an offer, a decline or a frequency cap to.
 *
 * RESOLVED ONCE PER PROCESS. The CLI's project root is fixed at launch, so the
 * answer cannot change under a running process the way it can under Desktop's
 * project switcher — which is why this is a memoized promise rather than
 * Desktop's TTL cache. A `git remote add` mid-session is real, and it costs the
 * user a restart to see an offer; spawning git on every poll of an optional ad
 * rail, forever, to catch it is the worse trade.
 *
 * The MEMO IS THE PROMISE, not the value: the poll and an accept can both ask
 * before the first `git` has answered, and caching the value would run the
 * command twice.
 */
import { repoFullNameFromRemote } from '@codebuff/common/ads/sponsored-proposal-target'
import type { SponsoredLocalTarget } from '@codebuff/common/ads/sponsored-capability'
import { readFileSync } from 'fs'
import { join } from 'path'

import { logger } from './logger'
import { tryGetProjectRoot } from '../project-files'

/** A `git remote get-url origin` that answers a string or nothing. */
export type RemoteReader = (cwd: string) => Promise<string | null>

const REMOTE_TIMEOUT_MS = 5_000
const WORKSPACE_TARGET =
  /^workspace:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

/**
 * `git remote get-url origin`, or null.
 *
 * Every failure is the same answer — not a repository, no remote, git absent,
 * git wedged — because the caller's response to all four is to offer no card.
 * `Bun.spawn` rather than the CLI's own terminal broker: this is our own
 * question about the user's checkout, not a command anything modelled asked
 * for, and it must not appear in a transcript.
 */
const readOriginRemote: RemoteReader = async (cwd) => {
  try {
    const proc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    return exitCode === 0 ? stdout.trim() : null
  } catch (error) {
    logger.debug({ error }, '[sponsored-proposal] could not read origin remote')
    return null
  }
}

let cached: Promise<SponsoredLocalTarget | null> | null = null

function targetKey(target: SponsoredLocalTarget): string {
  return target.kind === 'repo'
    ? target.repoFullName
    : `workspace:${target.workspaceId}`
}

/**
 * The repository this terminal's offers are keyed to, or null.
 *
 * `read` is injected so the resolution can be tested without a checkout
 * (docs/testing.md: DI over module mocking). Passing it also bypasses the memo,
 * because a test that shared the process-wide cache would be order-dependent.
 */
export async function sponsoredProposalTarget(
  read?: RemoteReader,
): Promise<string | null> {
  const target = await sponsoredProposalLocalTarget(read)
  return target ? targetKey(target) : null
}

/**
 * The opaque local target behind a card.  This is the binding carried from
 * preview to funded accept; it is intentionally recomputed at accept time so
 * a changed remote or workspace marker cannot charge a different project.
 */
export async function sponsoredProposalLocalTarget(
  read?: RemoteReader,
): Promise<SponsoredLocalTarget | null> {
  if (read) return resolve(read)
  if (!cached) cached = resolve(readOriginRemote)
  return cached
}

async function resolve(
  read: RemoteReader,
): Promise<SponsoredLocalTarget | null> {
  // `tryGetProjectRoot`, not `getProjectRoot`: the ad rail must never be the
  // thing that throws during startup, and a root that is not set yet is
  // simply "no card this tick".
  const root = tryGetProjectRoot()
  if (!root) return null
  const repo = repoFullNameFromRemote(await read(root))
  if (repo) return { kind: 'repo', repoFullName: repo }
  // The v2 ad request already trusts only this persistent opaque UUID. Reuse
  // it here so a local project can poll the same offer it was eligible to see.
  try {
    const workspaceId = readFileSync(
      join(root, '.freebuff', 'project-id'),
      'utf8',
    )
      .trim()
      .toLowerCase()
    return WORKSPACE_TARGET.test(`workspace:${workspaceId}`)
      ? { kind: 'workspace', workspaceId }
      : null
  } catch {
    return null
  }
}

/** Test-only: forget the process-wide answer. */
export function resetSponsoredProposalTarget(): void {
  cached = null
}
