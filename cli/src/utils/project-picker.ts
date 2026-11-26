import path from 'path'

import { setProjectRoot } from '../project-files'
import { resetCodebuffClient } from './codebuff-client'
import { reloadLocalAgentRegistry } from './local-agent-registry'
import { initializeSkillRegistry } from './skill-registry'

interface ActivateProjectOptions {
  /**
   * Returns the agent directories the new project may load, after the trust
   * gate. Omitted when `--agent` is set, which leaves the registry as it is,
   * the same way startup skips local `.agents` in that case.
   */
  resolveAgentDirs?: () => Promise<string[]>
}

export async function activateProject(
  projectPath: string,
  { resolveAgentDirs }: ActivateProjectOptions = {},
): Promise<void> {
  process.chdir(projectPath)
  setProjectRoot(projectPath)

  // Resolved after the move: the candidate directories are relative to cwd.
  if (resolveAgentDirs) {
    await reloadLocalAgentRegistry(await resolveAgentDirs())
  }
  await initializeSkillRegistry()

  resetCodebuffClient()
}

export function shouldShowProjectPicker(
  startCwd: string,
  homeDir: string,
): boolean {
  const relativeToHome = path.relative(startCwd, homeDir)
  return (
    relativeToHome === '' ||
    (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome))
  )
}
