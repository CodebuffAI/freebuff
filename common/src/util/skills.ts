import type { SkillDefinition, SkillsMap } from '../types/skill'

export function isSkillModelInvocable(skill: SkillDefinition): boolean {
  return skill.disableModelInvocation !== true
}

/** Keep bundled resource paths usable in both tool and user-invoked skills. */
export function formatSkillContent(
  skill: Pick<SkillDefinition, 'content' | 'filePath'>,
): string {
  // Forward slashes work in Windows file tools and Git Bash as well as POSIX.
  // Preserve the supplying host's path rather than resolving it on this host.
  const filePath = skill.filePath.replace(/\\/g, '/')
  const baseDirectory = filePath.slice(0, filePath.lastIndexOf('/') + 1) || './'
  return `Base directory for this skill: ${JSON.stringify(baseDirectory)}
Resolve skill-relative paths (such as scripts/, references/, and assets/) against this directory, not the project's working directory.

${skill.content}`
}

/**
 * Escapes special XML characters in a string.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Formats available skills as XML for inclusion in tool descriptions.
 */
export function formatAvailableSkillsXml(skills: SkillsMap): string {
  const skillEntries = Object.values(skills).filter(isSkillModelInvocable)
  if (skillEntries.length === 0) {
    return ''
  }

  const skillsXml = skillEntries
    .map(
      (skill) =>
        `  <skill>\n    <name>${skill.name}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`,
    )
    .join('\n')

  return `<available_skills>\n${skillsXml}\n</available_skills>`
}
