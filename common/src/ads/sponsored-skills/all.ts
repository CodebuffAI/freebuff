import type { SponsoredSkill } from '../sponsored-skill'

/**
 * The public export's stand-in for the private skill list: advertisers'
 * sponsored skill texts are not published, so a public build drives no skill
 * and refuses every install.
 */
export const ALL_SPONSORED_SKILLS: readonly SponsoredSkill[] = []
