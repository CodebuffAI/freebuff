import fs from 'fs'
import path from 'path'

import { generateAnonymousId } from '@codebuff/common/analytics-core'

import { getConfigDir } from './config-dir'

/**
 * Persistent anonymous analytics id.
 *
 * Pre-login events (e.g. `cli.app_launched`) are captured under this id and
 * later aliased to the real user id on login. If the id were regenerated every
 * process start, each pre-login launch would become a distinct "person" in
 * PostHog — only the launch where login happens gets aliased, and every prior
 * launch is orphaned at the top of the funnel, inflating the apparent drop-off.
 *
 * Persisting it to the config dir means all of a user's pre-login launches
 * collapse to a single person that aliases cleanly into their account.
 *
 * Deliberately a per-install random UUID, NOT the hardware fingerprint from
 * `fingerprint.ts`: the fingerprint is stable across reinstalls, so reusing it
 * here would alias a fresh install
 * into a previous user's PostHog person — cross-account identity bleed. Keep
 * the two identities separate.
 */
const ANONYMOUS_ID_FILE = 'analytics-id.json'

let cachedAnonymousId: string | undefined

const getAnonymousIdPath = (): string =>
  path.join(getConfigDir(), ANONYMOUS_ID_FILE)

function readPersistedAnonymousId(): string | undefined {
  try {
    const raw = fs.readFileSync(getAnonymousIdPath(), 'utf8')
    const parsed = JSON.parse(raw) as { anonymousId?: unknown }
    if (typeof parsed.anonymousId === 'string' && parsed.anonymousId.trim()) {
      return parsed.anonymousId
    }
  } catch {
    // Missing/corrupt file — fall through to mint a new one.
  }
  return undefined
}

function persistAnonymousId(anonymousId: string): void {
  try {
    const configDir = getConfigDir()
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    fs.writeFileSync(
      getAnonymousIdPath(),
      JSON.stringify({ anonymousId }, null, 2),
    )
  } catch {
    // Best-effort persistence. If the disk is unwritable we still return an id
    // for this process; it just won't survive across launches.
  }
}

/**
 * Return a stable anonymous id, reading it from disk (or minting + persisting
 * one on first run). Cached for the process lifetime. Never throws — on any
 * filesystem error it falls back to an in-memory id.
 */
export function getOrCreatePersistentAnonymousId(): string {
  if (cachedAnonymousId) {
    return cachedAnonymousId
  }

  const existing = readPersistedAnonymousId()
  if (existing) {
    cachedAnonymousId = existing
    return existing
  }

  const minted = generateAnonymousId()
  persistAnonymousId(minted)
  cachedAnonymousId = minted
  return minted
}

/** Reset the in-memory cache — for testing only. */
export function resetAnonymousIdCache(): void {
  cachedAnonymousId = undefined
}
