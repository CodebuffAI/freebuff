import '../../../../sdk/test/setup-env'

import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'

import * as configDirModule from '../../utils/config-dir'
import {
  clearRecentProjects,
  loadRecentProjects,
  removeRecentProject,
  saveRecentProject,
} from '../../utils/recent-projects'

describe('cli/utils/recent-projects', () => {
  let tempConfigDir: string
  let tempProjectsDir: string
  let restoreGetConfigDir: () => void

  beforeEach(() => {
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-config-test-'))
    tempProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-projects-test-'))

    const spy = spyOn(configDirModule, 'getConfigDir').mockReturnValue(tempConfigDir)
    restoreGetConfigDir = () => spy.mockRestore()
  })

  afterEach(() => {
    restoreGetConfigDir()
    try {
      fs.rmSync(tempConfigDir, { recursive: true, force: true })
      fs.rmSync(tempProjectsDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test('returns empty array when recent-projects.json does not exist', () => {
    expect(loadRecentProjects()).toEqual([])
  })

  test('saves and loads existing project directory', () => {
    const projectA = path.join(tempProjectsDir, 'project-a')
    fs.mkdirSync(projectA, { recursive: true })

    saveRecentProject(projectA)

    const loaded = loadRecentProjects()
    expect(loaded.length).toBe(1)
    expect(loaded[0].path).toBe(path.resolve(projectA))
  })

  test('canonicalizes paths to prevent duplicate entries', () => {
    const projectA = path.join(tempProjectsDir, 'project-a')
    fs.mkdirSync(projectA, { recursive: true })

    // Save with trailing slash
    saveRecentProject(projectA + path.sep)
    expect(loadRecentProjects().length).toBe(1)

    // Save again without trailing slash
    saveRecentProject(projectA)
    expect(loadRecentProjects().length).toBe(1)
    expect(loadRecentProjects()[0].path).toBe(path.resolve(projectA))
  })

  test('ignores non-existent project directories', () => {
    const nonExistent = path.join(tempProjectsDir, 'does-not-exist')
    saveRecentProject(nonExistent)

    expect(loadRecentProjects()).toEqual([])
  })

  test('removes project by canonical path', () => {
    const projectA = path.join(tempProjectsDir, 'project-a')
    const projectB = path.join(tempProjectsDir, 'project-b')
    fs.mkdirSync(projectA, { recursive: true })
    fs.mkdirSync(projectB, { recursive: true })

    saveRecentProject(projectA)
    saveRecentProject(projectB)
    expect(loadRecentProjects().length).toBe(2)

    // Remove projectA with trailing slash
    removeRecentProject(projectA + path.sep)
    const remaining = loadRecentProjects()
    expect(remaining.length).toBe(1)
    expect(remaining[0].path).toBe(path.resolve(projectB))
  })

  test('clears all recent projects', () => {
    const projectA = path.join(tempProjectsDir, 'project-a')
    fs.mkdirSync(projectA, { recursive: true })

    saveRecentProject(projectA)
    expect(loadRecentProjects().length).toBe(1)

    clearRecentProjects()
    expect(loadRecentProjects()).toEqual([])
  })

  test('filters out projects that have been deleted from disk', () => {
    const projectA = path.join(tempProjectsDir, 'project-a')
    const projectB = path.join(tempProjectsDir, 'project-b')
    fs.mkdirSync(projectA, { recursive: true })
    fs.mkdirSync(projectB, { recursive: true })

    saveRecentProject(projectA)
    saveRecentProject(projectB)
    expect(loadRecentProjects().length).toBe(2)

    // Delete projectA from disk
    fs.rmSync(projectA, { recursive: true, force: true })

    const loaded = loadRecentProjects()
    expect(loaded.length).toBe(1)
    expect(loaded[0].path).toBe(path.resolve(projectB))
  })

  test('caps recent projects at MAX_RECENT_PROJECTS with newest first', () => {
    const projectPaths: string[] = []
    for (let i = 0; i < 12; i++) {
      const p = path.join(tempProjectsDir, `project-${i}`)
      fs.mkdirSync(p, { recursive: true })
      projectPaths.push(p)
      saveRecentProject(p)
    }

    const loaded = loadRecentProjects()
    expect(loaded.length).toBe(10)
    // Most recent (project-11) should be first
    expect(loaded[0].path).toBe(path.resolve(projectPaths[11]))
  })
})
