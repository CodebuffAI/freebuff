/**
 * A staged Freebuff Desktop rollout, carried as one hidden line in a GitHub
 * release's notes:
 *
 *   <!-- freebuff-desktop-rollout {"since":"0.1.0","percent":10} -->
 *
 * The release notes, not an attached asset, because GitHub edits a body in one
 * PATCH. Replacing an asset is a delete followed by an upload, and a feed that
 * read the release between the two would see no rollout at all and offer the
 * update to everyone.
 *
 * `since` is the first release of the staged line; an install already running
 * `since` or later is past the gate and always gets the newest release.
 * `percent` is electron-updater's `stagingPercentage` for every other install,
 * and also holds new downloads on the last release before `since`. At 100 the
 * rollout is over. Read by freebuff-web's desktop update and download routes,
 * written by freebuff-desktop/scripts/release-rollout.ts.
 */
export type DesktopRollout = { since: string; percent: number }

const MARKER_RE = /<!-- freebuff-desktop-rollout (.*?) -->/g
const RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function isDesktopRolloutPercent(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 100
  )
}

export function formatDesktopRolloutMarker(rollout: DesktopRollout): string {
  return `<!-- freebuff-desktop-rollout ${JSON.stringify({
    since: rollout.since,
    percent: rollout.percent,
  })} -->`
}

/**
 * The rollout a release's notes declare, or null when they declare none.
 * Throws on a marker it cannot read: a caller that guessed "no rollout" there
 * would offer a staged build to every install.
 */
export function readDesktopRolloutMarker(
  body: string | null | undefined,
): DesktopRollout | null {
  const markers = [...(body ?? '').matchAll(MARKER_RE)]
  if (markers.length === 0) return null
  if (markers.length > 1)
    throw new Error('Release notes carry more than one rollout marker')
  let parsed: unknown
  try {
    parsed = JSON.parse(markers[0][1])
  } catch {
    throw new Error('Unreadable rollout marker')
  }
  const { since, percent } = (parsed ?? {}) as Record<string, unknown>
  if (typeof since !== 'string' || !RELEASE_VERSION_RE.test(since))
    throw new Error('Rollout marker has no valid `since` version')
  if (!isDesktopRolloutPercent(percent))
    throw new Error('Rollout marker percent must be an integer from 0 to 100')
  return { since, percent }
}

/** `body` with its rollout marker set to `rollout`, appended if it had none. */
export function writeDesktopRolloutMarker(
  body: string | null | undefined,
  rollout: DesktopRollout,
): string {
  const marker = formatDesktopRolloutMarker(rollout)
  const text = body ?? ''
  if (readDesktopRolloutMarker(text)) return text.replace(MARKER_RE, marker)
  return text ? `${text.trimEnd()}\n\n${marker}\n` : `${marker}\n`
}

/**
 * The rollout a new release carries. A rollout already under way continues
 * through every release cut during it, so a fix ships to the same installs at
 * the same percentage without anyone having to remember it; `requested`, when
 * given, moves that percentage. With none under way, `requested` below 100
 * starts one at this release.
 */
export function planDesktopReleaseRollout({
  version,
  requested,
  previous,
}: {
  version: string
  requested: number | null
  previous: DesktopRollout | null
}): DesktopRollout | null {
  if (previous && previous.percent < 100)
    return { since: previous.since, percent: requested ?? previous.percent }
  if (requested != null && requested < 100)
    return { since: version, percent: requested }
  return null
}
