import { ALL_SPONSORED_SKILLS as ALL } from './all'
import {
  compareSponsoredSkillVersions,
  renderSponsoredSkillProcedure,
  sponsoredSkillKey,
  type SponsoredSkill,
} from '../sponsored-skill'
import { sha256Hex } from '../../util/hash'

/** Every shipped skill, by `<id>@<version>`. */
export const SPONSORED_SKILLS: ReadonlyMap<string, SponsoredSkill> = new Map(
  ALL.map((skill) => [sponsoredSkillKey(skill), skill]),
)

/** Every shipped version of one skill, oldest first. */
export function sponsoredSkillVersions(id: string): SponsoredSkill[] {
  return ALL.filter((skill) => skill.id === id).sort((a, b) =>
    compareSponsoredSkillVersions(a.version, b.version),
  )
}

/** The newest shipped version of a skill, or undefined for an unknown id. */
export function latestSponsoredSkill(id: string): SponsoredSkill | undefined {
  return sponsoredSkillVersions(id).at(-1)
}

/** A skill by `<id>` (latest) or `<id>@<version>` (exact). */
export function resolveSponsoredSkill(ref: string): SponsoredSkill | undefined {
  return ref.includes('@')
    ? SPONSORED_SKILLS.get(ref)
    : latestSponsoredSkill(ref)
}

let byProcedureHash: Map<string, SponsoredSkill> | undefined

/**
 * The skill version a stored procedure hash came from, so runs, grades and
 * Lab batches compare per version with no new column. Takes the hash every
 * surface already stores (`procedure_sha256`, `compute_procedure_sha256`,
 * `ad_agentic_run_grade.procedure_sha256`): raw hex or `sha256:`-tagged, of
 * the trimmed rendered text. Undefined for a legacy free-text procedure.
 */
export function sponsoredSkillForProcedureSha256(
  hash: string | null | undefined,
): SponsoredSkill | undefined {
  if (!hash) return undefined
  byProcedureHash ??= new Map(
    ALL.map((skill) => [
      sha256Hex(renderSponsoredSkillProcedure(skill).trim()),
      skill,
    ]),
  )
  return byProcedureHash.get(hash.replace(/^sha256:/, '').toLowerCase())
}
