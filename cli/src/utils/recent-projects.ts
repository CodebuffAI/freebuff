import fs from 'fs'
import path from 'path'

import { getConfigDir } from './auth'
import { logger } from './logger'

const MAX_RECENT_PROJECTS = 10

export interface RecentProject {
  path: string
  lastOpened: number
}

/**
 * Get the recent projects file path
 */
export const getRecentProjectsPath = (): string => {
  return path.join(getConfigDir(), 'recent-projects.json')
}

/**
 * Load recent projects from file system
 * @returns Array of recent projects, sorted by most recent first
 */
export const loadRecentProjects = (): RecentProject[] => {
  const recentProjectsPath = getRecentProjectsPath()

  if (!fs.existsSync(recentProjectsPath)) {
    return []
  }

  try {
    const fileContent = fs.readFileSync(recentProjectsPath, 'utf8')
    const parsed = JSON.parse(fileContent)

    if (!Array.isArray(parsed)) {
      return []
    }

    // Validate and filter entries
    const validProjects = parsed.filter(
      (item): item is RecentProject =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.path === 'string' &&
        typeof item.lastOpened === 'number',
    )

    // Filter out projects that no longer exist on disk
    const existingProjects = validProjects.filter((project) => {
      try {
        return fs.existsSync(project.path)
      } catch {
        return false
      }
    })

    // Sort by most recent first
    return existingProjects.sort((a, b) => b.lastOpened - a.lastOpened)
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Error reading recent projects',
    )
    return []
  }
}

/**
 * Save a project to the recent projects list.
 * Updates the timestamp if the project already exists, otherwise adds it.
 * Keeps only the most recent MAX_RECENT_PROJECTS projects.
 * Validates that the path exists before saving.
 */
export const saveRecentProject = (projectPath: string): void => {
  // Validate path exists before saving
  if (!fs.existsSync(projectPath)) {
    logger.debug({ projectPath }, 'Skipping save for non-existent project path')
    return
  }

  const configDir = getConfigDir()
  const recentProjectsPath = getRecentProjectsPath()

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // Load existing projects
    const existingProjects = loadRecentProjects()

    // Remove the project if it already exists (we'll add it back at the top)
    const filteredProjects = existingProjects.filter(
      (p) => p.path !== projectPath,
    )

    // Add the new/updated project at the beginning
    const updatedProjects: RecentProject[] = [
      { path: projectPath, lastOpened: Date.now() },
      ...filteredProjects,
    ].slice(0, MAX_RECENT_PROJECTS)

    fs.writeFileSync(
      recentProjectsPath,
      JSON.stringify(updatedProjects, null, 2),
    )
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Error saving recent project',
    )
  }
}
