import path from 'path'

import { getBundledRgPath } from '@codebuff/sdk'

import { extractRipgrep } from './ripgrep-extraction'
import { getConfigDir } from '../utils/config-dir'
import { getCliEnv } from '../utils/env'
import { logger } from '../utils/logger'

const getRipgrepPath = async (): Promise<string> => {
  const env = getCliEnv()
  // In dev mode, use the SDK's bundled ripgrep binary
  if (!env.CODEBUFF_IS_BINARY) {
    return getBundledRgPath()
  }

  // Compiled mode - self-extract the embedded binary to the same directory as the current binary
  const binaryDir = path.dirname(process.execPath)
  const rgFileName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const outPath = path.join(binaryDir, rgFileName)

  // Check if already extracted
  const outPathExists = await Bun.file(outPath).exists()
  if (outPathExists) {
    return outPath
  }

  // Extract the embedded binary
  try {
    // Use require() with literal paths to ensure the binary gets bundled into the compiled CLI
    // This is necessary for Bun's binary compilation to include the ripgrep binary
    let embeddedRgPath: string

    if (process.platform === 'darwin' && process.arch === 'arm64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/arm64-darwin/rg')
    } else if (process.platform === 'darwin' && process.arch === 'x64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/x64-darwin/rg')
    } else if (process.platform === 'linux' && process.arch === 'arm64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/arm64-linux/rg')
    } else if (process.platform === 'linux' && process.arch === 'x64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/x64-linux/rg')
    } else if (process.platform === 'win32' && process.arch === 'x64') {
      embeddedRgPath = require('../../../sdk/dist/vendor/ripgrep/x64-win32/rg.exe')
    } else {
      throw new Error(
        `Unsupported platform: ${process.platform}-${process.arch}`,
      )
    }

    // Prefer the binary directory; protected installs use the user's cache.
    const embeddedBuffer = await Bun.file(embeddedRgPath).arrayBuffer()
    return await extractRipgrep({
      outPath,
      bytes: new Uint8Array(embeddedBuffer),
      getCacheDir: () => path.join(getConfigDir(), 'cache', 'ripgrep'),
    })
  } catch (error) {
    logger.error({ error }, 'Failed to extract ripgrep binary')
    // Fallback to SDK's bundled ripgrep if extraction fails
    return getBundledRgPath()
  }
}

// Cache the promise to avoid multiple extractions
let rgPathPromise: Promise<string> | null = null

export const getRgPath = (): Promise<string> => {
  if (!rgPathPromise) {
    rgPathPromise = getRipgrepPath()
  }
  return rgPathPromise
}

/**
 * Reset the cached ripgrep path promise.
 * Used primarily for testing to force re-extraction.
 */
export const resetRgPathCache = (): void => {
  rgPathPromise = null
}
