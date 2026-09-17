import path from 'path'

import { setProjectRoot } from '../project-files'
import { resetCodebuffClient } from './codebuff-client'
import { reloadLocalAgentRegistry } from './local-agent-registry'

interface ActivateProjectOptions {
  reloadAgentRegistry?: boolean
}

export async function activateProject(
  projectPath: string,
  { reloadAgentRegistry = true }: ActivateProjectOptions = {},
): Promise<void> {
  process.chdir(projectPath)
  setProjectRoot(projectPath)

  if (reloadAgentRegistry) {
    await reloadLocalAgentRegistry()
  }

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
