import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { getSdkEnv } from '../env'

import type { SdkEnv } from '../types/env'

const PLATFORM_DIRS: Record<string, string> = {
  'darwin-arm64': 'arm64-darwin',
  'darwin-x64': 'x64-darwin',
  'linux-arm64': 'arm64-linux',
  'linux-x64': 'x64-linux',
  'win32-arm64': 'arm64-win32',
  'win32-x64': 'x64-win32',
}

export function ripgrepPlatformDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const platformDir = PLATFORM_DIRS[`${platform}-${arch}`]
  if (!platformDir) throw new Error(`Unsupported platform: ${platform}-${arch}`)
  return platformDir
}

/**
 * Get the path to the bundled ripgrep binary based on the current platform
 * @param importMetaUrl - import.meta.url from the calling module
 * @returns Path to the ripgrep binary
 */
export function getBundledRgPath(
  importMetaUrl?: string,
  env: SdkEnv = getSdkEnv(),
): string {
  // Allow override via environment variable
  if (env.CODEBUFF_RG_PATH) {
    return env.CODEBUFF_RG_PATH
  }

  const platform = process.platform
  const arch = process.arch
  const platformDir = ripgrepPlatformDir(platform, arch)

  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg'

  // Try to find the bundled binary relative to this module
  let vendorPath: string | undefined

  // Use the SDK's own import.meta.url if none is provided
  const metaUrl = importMetaUrl || import.meta.url

  if (metaUrl) {
    // ESM context - use import.meta.url to find relative path
    const currentFile = fileURLToPath(metaUrl)
    const currentDir = dirname(currentFile)

    // Try relative to current file (development - from src/native/ripgrep.ts to vendor/)
    const devPath = join(
      currentDir,
      '..',
      '..',
      'vendor',
      'ripgrep',
      platformDir,
      binaryName,
    )
    if (existsSync(devPath)) {
      vendorPath = devPath
    }

    // Try relative to bundled dist file (production - from dist/index.mjs to dist/vendor/)
    const distPath = join(
      currentDir,
      'vendor',
      'ripgrep',
      platformDir,
      binaryName,
    )
    if (existsSync(distPath)) {
      vendorPath = distPath
    }
  }

  // If not found via importMetaUrl, try CJS approach or other methods
  if (!vendorPath) {
    // Try from __dirname if available (CJS context)
    const dirname = new Function(
      `try { return __dirname; } catch (e) { return undefined; }`,
    )()

    if (typeof dirname !== 'undefined') {
      const cjsPath = join(
        dirname,
        '..',
        '..',
        'vendor',
        'ripgrep',
        platformDir,
        binaryName,
      )
      if (existsSync(cjsPath)) {
        vendorPath = cjsPath
      }
      const cjsPath2 = join(
        dirname,
        'vendor',
        'ripgrep',
        platformDir,
        binaryName,
      )
      if (existsSync(cjsPath2)) {
        vendorPath = cjsPath2
      }
    }
  }

  if (vendorPath && existsSync(vendorPath)) {
    return vendorPath
  }

  // Fallback: try to find in dist/vendor (for published package)
  const distVendorPath = join(
    process.cwd(),
    'node_modules',
    '@codebuff',
    'sdk',
    'dist',
    'vendor',
    'ripgrep',
    platformDir,
    binaryName,
  )
  if (existsSync(distVendorPath)) {
    return distVendorPath
  }

  // No fallback available - bundled binaries are required
  throw new Error(
    `Ripgrep binary not found for ${platform}-${arch}. ` +
      `Expected at: ${distVendorPath}${vendorPath ? ` or ${vendorPath}` : ''}. ` +
      `Please run 'npm run fetch-ripgrep' or set CODEBUFF_RG_PATH environment variable.`,
  )
}
