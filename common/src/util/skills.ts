import type { SkillDefinition, SkillsMap } from '../types/skill'

/**
 * Whether the agent may load this skill on its own. A skill is model-invocable
 * unless it opted out via `disable-model-invocation: true` (user-only) or
 * `user-invocable: false` (model-only skills ARE invocable by the model — the
 * flag hides them from the user's / menu, not from the agent).
 */
export function isSkillModelInvocable(skill: SkillDefinition): boolean {
  return skill.disableModelInvocation !== true
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
    .map((skill) => {
      const lines = [
        '  <skill>',
        `    <name>${skill.name}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
      ]
      // Claude Code parity: `when_to_use` carries extra trigger context that
      // helps the model decide when the skill applies.
      if (skill.whenToUse) {
        lines.push(`    <when_to_use>${escapeXml(skill.whenToUse)}</when_to_use>`)
      }
      lines.push('  </skill>')
      return lines.join('\n')
    })
    .join('\n')

  return `<available_skills>\n${skillsXml}\n</available_skills>`
}
