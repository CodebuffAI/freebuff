import { SKILLS_DIR_NAME, SKILL_FILE_NAME } from '@codebuff/common/constants/skills'
import { parseSkillFileContent } from '@codebuff/common/util/parse-skill'
import type { SkillDefinition } from '@codebuff/common/types/skill'
import { isSkillModelInvocable } from '@codebuff/common/util/skills'
import { jsonToolResult } from '@codebuff/common/util/messages'
import fs from 'fs'
import path from 'path'
import os from 'os'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { ProjectFileContext } from '@codebuff/common/util/file'

/**
 * Dynamically load a single skill from disk.
 * Used when a skill is not found in the pre-loaded cache but may have been created during the session.
 */
async function loadSkillFromDisk(
  projectRoot: string,
  skillName: string,
  includeHomeSkills: boolean,
): Promise<SkillDefinition | null> {
  const home = os.homedir()
  const skillsDirs = [
    // Match loadSkills precedence: project over global, .agents over .claude.
    // This function returns the first match, so highest precedence comes first.
    path.join(projectRoot, '.agents', SKILLS_DIR_NAME),
    path.join(projectRoot, '.claude', SKILLS_DIR_NAME),
    // OFF BY DEFAULT, and deliberately a parameter rather than a constant.
    //
    // `os.homedir()` is the HOST's home, which is only the right place to look
    // when this process belongs to the user whose skills these are — an
    // interactive CLI on their own machine. On a server the same call resolves
    // to the SERVER's home while `projectRoot` points at someone else's
    // checkout: on Freebuff Cloud that is a Daytona sandbox path, so a skill
    // sitting in the web server's `~/.agents/skills` would be served in place
    // of the repo's own, and the result of this lookup WINS over the
    // pre-loaded cache (`diskSkill ?? skills[name]` below).
    //
    // `loadSkills` was given exactly this opt-in
    // (`LoadSkillsOptions.includeHomeSkills`) for exactly this reason; the fix
    // never reached this second, independent lookup.
    ...(includeHomeSkills
      ? [
          path.join(home, '.agents', SKILLS_DIR_NAME),
          path.join(home, '.claude', SKILLS_DIR_NAME),
        ]
      : []),
  ]

  for (const skillsDir of skillsDirs) {
    const skillDir = path.join(skillsDir, skillName)
    const skillFilePath = path.join(skillDir, SKILL_FILE_NAME)

    try {
      // Check if the skill directory and file exist
      const stat = fs.statSync(skillDir)
      if (!stat.isDirectory()) continue

      fs.statSync(skillFilePath) // Will throw if file doesn't exist

      // Same parser as session-start discovery, so a skill created mid-session
      // is held to the same rules (YAML-only frontmatter, name matches dir).
      const skill = parseSkillFileContent(
        fs.readFileSync(skillFilePath, 'utf8'),
        {
          directoryName: skillName,
          filePath: skillFilePath,
        },
      )
      if (skill) return skill
    } catch {
      // Skill doesn't exist in this directory, try the next one
      continue
    }
  }

  return null
}

type ToolName = 'skill'

export const handleSkill = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  fileContext: ProjectFileContext
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, fileContext } = params
  const { name } = toolCall.input

  await previousToolCallFinished

  const skills = fileContext.skills ?? {}

  // Always prefer the on-disk copy so skills installed or updated during the
  // session (e.g. via `npx skills add`) are picked up with their latest
  // contents. Fall back to the cache pre-loaded at session start.
  const diskSkill = fileContext.projectRoot
    ? await loadSkillFromDisk(
        fileContext.projectRoot,
        name,
        fileContext.includeHomeSkills === true,
      )
    : null

  const skill = diskSkill ?? skills[name]
  const isUnavailableToModel =
    skill !== undefined && !isSkillModelInvocable(skill)

  if (!skill || isUnavailableToModel) {
    const availableSkills = Object.values(skills)
      .filter(isSkillModelInvocable)
      .map((availableSkill) => availableSkill.name)
    const suggestion =
      availableSkills.length > 0
        ? ` Available skills: ${availableSkills.join(', ')}. You can also load skills created during this session by name.`
        : ' No skills are currently available. You can load skills created during this session by name.'

    const reason = isUnavailableToModel
      ? `Skill '${name}' can only be invoked by the user.`
      : `Skill '${name}' not found.`

    return {
      output: jsonToolResult({
        name,
        description: '',
        content: `Error: ${reason}${suggestion}`,
      }),
    }
  }

  const result: { name: string; description: string; content: string; license?: string } = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
  }
  if (skill.license) {
    result.license = skill.license
  }

  return {
    output: jsonToolResult(result),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
