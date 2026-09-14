import { z } from 'zod/v4'

import {
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_REGEX,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from '../constants/skills'

/**
 * Zod schema for skill frontmatter metadata.
 *
 * Values are unconstrained on purpose: `metadata` is a free-form bag that
 * publishers and registries nest their own structures into (skills.sh writes a
 * `hermes:` block into every skill it serves). Requiring flat strings here
 * rejected the whole skill over a field nothing reads.
 */
export const SkillMetadataSchema = z.record(z.string(), z.unknown())

/**
 * Zod schema for skill frontmatter (parsed from YAML).
 */
export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(SKILL_NAME_MAX_LENGTH)
    .regex(
      SKILL_NAME_REGEX,
      'Name must be lowercase alphanumeric with single hyphen separators',
    ),
  // clamped rather than rejected: an over-long description is a reason to show
  // less of it, never a reason to make the skill unusable
  description: z
    .string()
    .min(1)
    .transform((d) => d.slice(0, SKILL_DESCRIPTION_MAX_LENGTH)),
  license: z.string().optional(),
  'disable-model-invocation': z.boolean().optional(),
  // Claude Code compatibility: `user-invocable: false` marks a skill the
  // model may invoke but the user cannot (hidden from / menu). Absent =
  // invocable by both, matching Claude Code's default.
  'user-invocable': z.boolean().optional(),
  // Claude Code compatibility: hint shown during autocomplete, e.g.
  // "[issue-number]". Freebuff does not substitute arguments yet, but the
  // field is accepted so a Claude Code skill does not fail validation.
  // Claude Code's own docs write the value unquoted, which YAML parses as a
  // single-element array — coerce that back to the display string.
  'argument-hint': z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v.join(' ') : v)),
  // Claude Code compatibility: extra trigger context appended to the
  // description in listings. Accepted and surfaced; never rejected.
  'when_to_use': z.string().optional(),
  metadata: SkillMetadataSchema.optional(),
})

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/**
 * Full skill definition including content and source path.
 */
export const SkillDefinitionSchema = z.object({
  /** Skill name (must match directory name) */
  name: z.string(),
  /** Short description for agent discovery */
  description: z.string(),
  /** Optional license */
  license: z.string().optional(),
  /** Whether only the user may invoke this skill. */
  disableModelInvocation: z.boolean().optional(),
  /** Whether only the model may invoke this skill (hidden from the / menu). */
  userInvocable: z.boolean().optional(),
  /** Autocomplete hint for expected arguments, e.g. "[issue-number]". */
  argumentHint: z.string().optional(),
  /** Extra trigger context appended to the description in listings. */
  whenToUse: z.string().optional(),
  /** Optional key-value metadata */
  metadata: SkillMetadataSchema.optional(),
  /** Full SKILL.md content (including frontmatter) */
  content: z.string(),
  /** Source file path */
  filePath: z.string(),
})

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>

export function createSkillDefinition(params: {
  frontmatter: SkillFrontmatter
  content: string
  filePath: string
}): SkillDefinition {
  const { frontmatter, content, filePath } = params
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    license: frontmatter.license,
    disableModelInvocation: frontmatter['disable-model-invocation'],
    userInvocable: frontmatter['user-invocable'],
    argumentHint: frontmatter['argument-hint'],
    whenToUse: frontmatter['when_to_use'],
    metadata: frontmatter.metadata,
    content,
    filePath,
  }
}

/**
 * Collection of skills keyed by skill name.
 */
export type SkillsMap = Record<string, SkillDefinition>
