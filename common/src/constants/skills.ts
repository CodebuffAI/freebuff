/**
 * Skills constants and validation rules.
 *
 * Skills are SKILL.md files with YAML frontmatter that define reusable
 * instructions that agents can load on-demand via the skill tool.
 */

/**
 * The directory name where skills are stored (within .agents/).
 */
export const SKILLS_DIR_NAME = 'skills'

/**
 * The file name for skill definitions.
 */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * Validation regex for skill names.
 * - 1-64 characters
 * - Lowercase alphanumeric with single hyphen separators
 * - Cannot start or end with hyphen
 * - No consecutive hyphens
 */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Maximum length for skill name.
 */
export const SKILL_NAME_MAX_LENGTH = 64

/**
 * Maximum length for skill description.
 */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024

/**
 * Validates a skill name according to the naming rules.
 * @param name - The skill name to validate
 * @returns true if valid, false otherwise
 */
export function isValidSkillName(name: string): boolean {
  if (!name || name.length > SKILL_NAME_MAX_LENGTH) {
    return false
  }
  return SKILL_NAME_REGEX.test(name)
}
