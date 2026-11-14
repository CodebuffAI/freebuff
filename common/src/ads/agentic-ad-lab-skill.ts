/**
 * Skills in the Agentic Ads Lab: the skill maker's input, and the versions the
 * Lab keeps. A version is immutable; edits create new versions. The Lab can
 * submit the exact rendered procedure for campaign review. Accepted runs fetch
 * stored versions from the server, without a registry edit or Desktop release.
 */

import { z } from 'zod/v4'

import {
  SPONSORED_SKILL_FRAMEWORKS,
  renderSponsoredSkillProcedure,
  sponsoredSkillSha256,
  type SponsoredSkill,
} from './sponsored-skill'
import { sha256Hex } from '../util/hash'
import type { LabAd } from './agentic-ad-lab'

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    } catch {
      return false
    }
  }, 'Use an HTTPS URL.')

export const labSkillMakeInputSchema = z
  .object({
    advertiserName: z.string().trim().min(1).max(120),
    websiteUrl: httpsUrl,
    /** The docs site, when it is not under the website. */
    docsUrl: httpsUrl.optional(),
    /** One sentence: what the user ends up with. */
    goal: z.string().trim().min(10).max(600),
    frameworks: z
      .array(z.enum(SPONSORED_SKILL_FRAMEWORKS))
      .min(1)
      .max(SPONSORED_SKILL_FRAMEWORKS.length),
    /** The agentic campaign whose Lab folder the made version goes in. */
    campaignId: z.string().uuid().optional(),
  })
  .strict()
export type LabSkillMakeInput = z.infer<typeof labSkillMakeInputSchema>

/** What the maker read, so a reviewer can check a skill's facts against it. */
export type LabSkillResearch = {
  input: LabSkillMakeInput
  sources: Array<{ url: string; chars: number }>
  /** Version pins the maker corrected against the npm registry, and similar. */
  notes: string[]
  /** The campaign settings the maker read, when made from a campaign. */
  campaign?: LabSkillCampaignBrief | null
  model: string
  costUsd: number
}

export type LabSkillVersion = {
  skillId: string
  version: string
  skill: SponsoredSkill
  /** `sponsoredSkillSha256`: the hash the rendered directive line carries. */
  sha256: string
  /** Hex sha256 of the trimmed rendered procedure: what batches and runs store. */
  procedureSha256: string
  /** `shipped` is in the repository's registry; the rest live in the Lab. */
  origin: 'shipped' | 'maker' | 'edit' | 'draft' | 'layer2_edit'
  /** The campaign whose Lab folder holds it; null for shipped and unfiled versions. */
  campaignId: string | null
  research: LabSkillResearch | null
  createdBy: string | null
  createdAt: string | null
}

export const labSkillSaveInputSchema = z
  .object({
    /** The skill JSON as edited; validated by `parseSponsoredSkill`. */
    skill: z.record(z.string(), z.unknown()),
    campaignId: z.string().uuid().nullable().optional(),
  })
  .strict()

/**
 * An agentic campaign as a Lab skill folder: what it runs live, and the skill
 * that live text renders when it is one (shipped or Lab).
 */
export type LabSkillCampaign = {
  id: string
  name: string
  status: string
  advertiserName: string
  /** The advertiser's website, to prefill the skill maker. */
  websiteUrl: string | null
  /** Hex sha256 of the trimmed live procedure, as batches record it. */
  procedureSha256: string
  /** `<id>@<version>` of the skill the live procedure renders exactly, if any. */
  liveSkill: string | null
  /** What the advertiser set on the campaign; the skill maker reads it. */
  brief: LabSkillCampaignBrief
}

/**
 * An agentic campaign's advertiser-written settings, as the skill maker reads
 * them: data about what the advertiser wants, never instructions to a model.
 */
export type LabSkillCampaignBrief = {
  /** `sponsored_goal`; null for campaigns not made by guided creation. */
  goal: string | null
  /** `sponsored_targeting`: when to suggest the product. */
  targeting: string | null
  /** The live onboarding prompt (`sponsored_procedure`). */
  procedure: string
  /** The success criteria, one `title: expected` line each. */
  successCriteria: string[]
}

export type LabSkillCatalog = {
  campaigns: LabSkillCampaign[]
  versions: LabSkillVersion[]
}

export type LabSkillMakeResult =
  | { ok: true; version: LabSkillVersion }
  | {
      ok: false
      /** The last draft, for the admin to fix by hand; null when none parsed. */
      text: string | null
      errors: string[]
      research: LabSkillResearch
    }

/** Hex sha256 of the trimmed rendered procedure, as batches and runs record it. */
export function sponsoredSkillProcedureSha256(skill: SponsoredSkill): string {
  return sha256Hex(renderSponsoredSkillProcedure(skill).trim())
}

export function labSkillVersion(
  skill: SponsoredSkill,
  meta: Pick<
    LabSkillVersion,
    'origin' | 'campaignId' | 'research' | 'createdBy' | 'createdAt'
  >,
): LabSkillVersion {
  return {
    skillId: skill.id,
    version: skill.version,
    skill,
    sha256: sponsoredSkillSha256(skill),
    procedureSha256: sponsoredSkillProcedureSha256(skill),
    ...meta,
  }
}

/** The custom ad that runs a skill as a campaign would: its exact rendering. */
export function labAdFromSkill(skill: SponsoredSkill, id: string): LabAd {
  return {
    id,
    name: `${skill.id}@${skill.version}`,
    advertiserName: skill.advertiser.slice(0, 120),
    headline: skill.consent.title,
    body: skill.consent.summary,
    procedure: renderSponsoredSkillProcedure(skill),
    targeting: skill.fits,
    signupUrl: '',
  }
}

/**
 * The repository file that ships a Lab version: `<id>/<version>.ts` under
 * `common/src/ads/sponsored-skills/`, plus the lines to add to `all.ts` and
 * `versions.lock.ts`. Shipping is a reviewed pull request.
 */
export function labSkillModuleSource(skill: SponsoredSkill): {
  path: string
  source: string
  lockLine: string
} {
  const key = `${skill.id}@${skill.version}`
  return {
    path: `common/src/ads/sponsored-skills/${skill.id}/${skill.version}.ts`,
    source: [
      `import type { SponsoredSkill } from '../../sponsored-skill'`,
      '',
      '/**',
      ` * ${key}, made in the Agentic Ads Lab and merged by a reviewer.`,
      ' * Shipped versions are immutable; change it with a new version.',
      ' */',
      `export const skill: SponsoredSkill = ${JSON.stringify(skill, null, 2)}`,
      '',
    ].join('\n'),
    lockLine: `'${key}': '${sponsoredSkillSha256(skill)}',`,
  }
}

/**
 * A version's entry in `sponsored-skills/all.ts`: the name it is imported
 * under and its import line.
 */
export function labSkillRegistryEntry(skill: SponsoredSkill): {
  name: string
  importLine: string
} {
  const name = `${skill.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}_${skill.version.replace(/[^0-9A-Za-z]/g, '_')}`
  return {
    name,
    importLine: `import { skill as ${name} } from './${skill.id}/${skill.version}'`,
  }
}
