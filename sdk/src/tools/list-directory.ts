import * as path from 'path'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import { isPathInside } from '@codebuff/common/util/path'

export async function listDirectory(params: {
  directoryPath: string
  projectPath: string
  fs: CodebuffFileSystem
}): Promise<CodebuffToolOutput<'list_directory'>> {
  const { directoryPath, projectPath, fs } = params

  try {
    const projectRoot = path.resolve(projectPath)
    const resolvedPath = path.resolve(projectRoot, directoryPath)
    const realProjectRoot = await fs.realpath(projectRoot)
    const realResolvedPath = await fs.realpath(resolvedPath)

    if (!isPathInside(realProjectRoot, realResolvedPath)) {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `Invalid path: Path '${directoryPath}' is outside the project directory.`,
          },
        },
      ]
    }

    // Checking the path and then reading it are two separate lookups, so the
    // directory the check approved is not necessarily the one that gets read: a
    // component of the path can be swapped for a symlink pointing outside the
    // project in between, and the listing would come back from wherever the swap
    // pointed. Node has no readdir-on-a-descriptor, so the read cannot be pinned
    // to the inode that was approved. Pinning identity around it is what is
    // available: the directory that was approved, the one that was read, and the
    // one still at that path afterwards must all be the same inode, and the path
    // must still resolve inside the project. That does not make the swap
    // impossible - an attacker who restores the path before the recheck still
    // wins - but it turns the common case from a silent escape into a refusal.
    const identityBefore = await fs.stat(realResolvedPath)

    const entries = await fs.readdir(realResolvedPath, {
      withFileTypes: true,
    })

    const identityAfter = await fs.stat(realResolvedPath)
    const realResolvedPathAfter = await fs.realpath(realResolvedPath)

    if (
      identityAfter.dev !== identityBefore.dev ||
      identityAfter.ino !== identityBefore.ino ||
      realResolvedPathAfter !== realResolvedPath ||
      !isPathInside(realProjectRoot, realResolvedPathAfter)
    ) {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `Invalid path: Path '${directoryPath}' changed while it was being read.`,
          },
        },
      ]
    }

    const files: string[] = []
    const directories: string[] = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(entry.name)
      } else if (entry.isFile()) {
        files.push(entry.name)
      }
    }

    return [
      {
        type: 'json',
        value: {
          files,
          directories,
          path: directoryPath,
        },
      },
    ]
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return [
      {
        type: 'json',
        value: {
          errorMessage: `Failed to list directory: ${errorMessage}`,
        },
      },
    ]
  }
}
