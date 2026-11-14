/**
 * House campaign clones (the weekly refresh, `ads/house-refresh`).
 *
 * The house leg rotates evenly over its eligible campaigns, so a campaign
 * gets more turns by having more copies. A copy is a new row with a new id,
 * but the serving policy keyed by catalog id (gates, integration favicons,
 * product-tip suppression) must follow it: an ungated copy of the Desktop
 * campaign would pitch Desktop to people already on Desktop. So a clone's id
 * is its source's id plus `~dup<n>`, and every catalog lookup resolves
 * through `houseCampaignSourceId` first.
 */
const CLONE_SEPARATOR = '~dup'
const CLONE_SUFFIX = /~dup[1-9][0-9]*$/

/** The catalog id a campaign id was cloned from, or the id itself. */
export function houseCampaignSourceId(id: string): string {
  return id.replace(CLONE_SUFFIX, '')
}

/** The id of the `n`th clone of `sourceId` (n >= 1). */
export function houseCampaignCloneId(sourceId: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('clone number must be >= 1')
  return `${houseCampaignSourceId(sourceId)}${CLONE_SEPARATOR}${n}`
}

export function isHouseCampaignClone(id: string): boolean {
  return CLONE_SUFFIX.test(id)
}
