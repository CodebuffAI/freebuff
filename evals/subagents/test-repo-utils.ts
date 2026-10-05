import { execSync } from 'child_process'
import fs from 'fs'
import * as os from 'os'
import path from 'path'

import { getErrorObject } from '@codebuff/common/util/error'

const CLONE_RETRY_DELAYS_MS = [5_000, 20_000]

/** A shallow clone checked out at one commit, retried: a clone or fetch that
 *  fails is nearly always the network (a GitHub hiccup, a laptop that slept),
 *  and a task that never got its repository would otherwise be scored as an
 *  agent that did nothing. */
async function cloneAtCommit(params: {
  repoUrl: string
  repoDir: string
  sha: string
}): Promise<void> {
  const { repoUrl, repoDir, sha } = params
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true })
      execSync(`git clone --depth 1 ${repoUrl} ${repoDir}`, { stdio: 'ignore' })
      execSync(`git fetch --depth 1 origin ${sha}`, {
        cwd: repoDir,
        stdio: 'ignore',
      })
      execSync(`git checkout ${sha}`, { cwd: repoDir, stdio: 'ignore' })
      return
    } catch (error) {
      const delay = CLONE_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) throw error
      console.warn(
        `Clone of ${repoUrl} at ${sha.slice(0, 8)} failed (${getErrorObject(error).message}); retrying in ${delay / 1000}s`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Helper function to manage test repository lifecycle
 * Sets up a test repo, runs a function with the repo cwd, then cleans up
 */
export const withTestRepo = async <T>(
  repoConfig: {
    repoUrl: string
    // The sha of the commit to checkout. If you have a commit with changes to replicate, you would check out the parent commit.
    parentSha: string
    initCommand?: string
    env?: Record<string, string>
  },
  fn: (cwd: string) => Promise<T>,
): Promise<T> => {
  const { repoUrl, parentSha, initCommand, env } = repoConfig

  // Create a temporary directory for the test repo
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-eval-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    await cloneAtCommit({ repoUrl, repoDir, sha: parentSha })

    if (initCommand) {
      console.log(`Running init command: ${initCommand}...`)
      try {
        execSync(initCommand, {
          cwd: repoDir,
          stdio: 'ignore',
          env: { ...process.env, ...env },
        })
      } catch (error) {
        console.error(
          `Error running init command: ${getErrorObject(error).message}`,
        )
      }
    }

    // Run the provided function with the repo directory
    return await fn(repoDir)
  } finally {
    // Clean up the temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Failed to clean up temporary directory: ${error}`)
    }
  }
}

export const withTestRepoAndParent = async <T>(
  repoConfig: {
    repoUrl: string
    commitSha: string
    initCommand?: string
  },
  fn: (cwd: string, commitSha: string, parentSha: string) => Promise<T>,
): Promise<T | null> => {
  const { repoUrl, commitSha, initCommand } = repoConfig

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-eval-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    execSync(`git clone --depth 1 ${repoUrl} ${repoDir}`, { stdio: 'ignore' })

    execSync(`git fetch --depth 2 origin ${commitSha}`, {
      cwd: repoDir,
      stdio: 'ignore',
    })

    execSync(`git checkout ${commitSha}`, { cwd: repoDir, stdio: 'ignore' })

    let parentSha: string
    try {
      const parents = execSync(`git log --pretty=%P -n 1 ${commitSha}`, {
        cwd: repoDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()

      if (!parents) {
        console.warn(
          `Commit ${commitSha.slice(0, 8)} has no parent (initial commit)`,
        )
        return null
      }

      const parentList = parents.split(' ')
      if (parentList.length > 1) {
        console.warn(
          `Commit ${commitSha.slice(0, 8)} is a merge commit (${parentList.length} parents)`,
        )
        return null
      }

      parentSha = parentList[0]
    } catch (error) {
      console.error(`Error getting parent for ${commitSha.slice(0, 8)}:`, error)
      return null
    }

    execSync(`git checkout ${parentSha}`, { cwd: repoDir, stdio: 'ignore' })

    if (initCommand) {
      console.log(`Running init command: ${initCommand}...`)
      execSync(initCommand, { cwd: repoDir, stdio: 'ignore' })
    }

    return await fn(repoDir, commitSha, parentSha)
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Failed to clean up temporary directory: ${error}`)
    }
  }
}
