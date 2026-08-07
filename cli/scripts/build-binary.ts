#!/usr/bin/env bun

import { spawnSync, type SpawnSyncOptions } from 'child_process'
import { createRequire } from 'module'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { ensureOpenTuiNativeBundle } from './open-tui-native-bundle'

type TargetInfo = {
  bunTarget: string
  platform: NodeJS.Platform
  arch: string
}

const VERBOSE = process.env.VERBOSE === 'true'
const OVERRIDE_TARGET = process.env.OVERRIDE_TARGET
const OVERRIDE_PLATFORM = process.env.OVERRIDE_PLATFORM as
  | NodeJS.Platform
  | undefined
const OVERRIDE_ARCH = process.env.OVERRIDE_ARCH ?? undefined
const OVERRIDE_COMPILE_EXECUTABLE_PATH =
  process.env.BUN_COMPILE_EXECUTABLE_PATH

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const cliRoot = join(__dirname, '..')
const cliRequire = createRequire(join(cliRoot, 'package.json'))

function log(message: string) {
  if (VERBOSE) {
    console.log(message)
  }
}

function logAlways(message: string) {
  console.log(message)
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: VERBOSE ? 'inherit' : 'pipe',
    env: options.env,
  })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? ''
    throw new Error(
      `Command "${command} ${args.join(' ')}" failed with exit code ${
        result.status
      }${stderr ? `\n${stderr}` : ''}`,
    )
  }
}

function getTargetInfo(): TargetInfo {
  if (OVERRIDE_TARGET && OVERRIDE_PLATFORM && OVERRIDE_ARCH) {
    return {
      bunTarget: OVERRIDE_TARGET,
      platform: OVERRIDE_PLATFORM,
      arch: OVERRIDE_ARCH,
    }
  }

  const platform = process.platform
  const arch = process.arch

  const mappings: Record<string, TargetInfo> = {
    'linux-x64': { bunTarget: 'bun-linux-x64', platform: 'linux', arch: 'x64' },
    'linux-x64-baseline': {
      bunTarget: 'bun-linux-x64-baseline',
      platform: 'linux',
      arch: 'x64',
    },
    'linux-arm64': {
      bunTarget: 'bun-linux-arm64',
      platform: 'linux',
      arch: 'arm64',
    },
    'darwin-x64': {
      bunTarget: 'bun-darwin-x64',
      platform: 'darwin',
      arch: 'x64',
    },
    'darwin-arm64': {
      bunTarget: 'bun-darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
    },
    'win32-x64': {
      bunTarget: 'bun-windows-x64',
      platform: 'win32',
      arch: 'x64',
    },
  }

  const key = `${platform}-${arch}`
  const target = mappings[key]

  if (!target) {
    throw new Error(`Unsupported build target: ${key}`)
  }

  return target
}

function getCliTargetLabel(targetInfo: TargetInfo): string {
  const baseTarget = `${targetInfo.platform}-${targetInfo.arch}`
  return targetInfo.bunTarget.endsWith('-baseline')
    ? `${baseTarget}-baseline`
    : baseTarget
}

async function main() {
  const [, , binaryNameArg, version] = process.argv
  const binaryName = binaryNameArg ?? 'codecane'

  if (!version) {
    throw new Error('Version argument is required when building a binary')
  }

  log(`Building ${binaryName} @ ${version}`)

  const targetInfo = getTargetInfo()
  const binDir = join(cliRoot, 'bin')

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  // Generate bundled agents file before compiling
  log('Generating bundled agents...')
  runCommand('bun', ['run', 'scripts/prebuild-agents.ts'], {
    cwd: cliRoot,
    env: process.env,
  })

  // Ensure SDK assets exist before compiling the CLI
  log('Building SDK dependencies...')
  runCommand('bun', ['run', '--cwd', '../sdk', 'build'], {
    cwd: cliRoot,
    env: process.env,
  })

  prepareOpenTuiNativeBundle(targetInfo)

  const outputFilename =
    targetInfo.platform === 'win32' ? `${binaryName}.exe` : binaryName
  const outputFile = join(binDir, outputFilename)

  // Collect all NEXT_PUBLIC_* environment variables
  const nextPublicEnvVars = Object.entries(process.env)
    .filter(([key]) => key.startsWith('NEXT_PUBLIC_'))
    .map(([key, value]) => [`process.env.${key}`, `"${value ?? ''}"`])

  const defineFlags = [
    ['process.env.NODE_ENV', '"production"'],
    ['process.env.CODEBUFF_IS_BINARY', '"true"'],
    ['process.env.CODEBUFF_CLI_VERSION', `"${version}"`],
    [
      'process.env.CODEBUFF_CLI_TARGET',
      `"${getCliTargetLabel(targetInfo)}"`,
    ],
    ['process.env.FREEBUFF_MODE', `"${process.env.FREEBUFF_MODE ?? 'false'}"`],
    ...nextPublicEnvVars,
  ]

  const buildArgs = [
    'build',
    'src/entry.ts',
    '--compile',
    '--production', // Required so compiled binaries use the production JSX runtime (avoids jsxDEV crashes).
    '--no-compile-autoload-bunfig', // User project bunfig.toml must not affect the standalone CLI.
    `--target=${targetInfo.bunTarget}`,
    ...(OVERRIDE_COMPILE_EXECUTABLE_PATH
      ? [`--compile-executable-path=${OVERRIDE_COMPILE_EXECUTABLE_PATH}`]
      : []),
    `--outfile=${outputFile}`,
    '--sourcemap=none',
    ...defineFlags.flatMap(([key, value]) => ['--define', `${key}=${value}`]),
    '--env "NEXT_PUBLIC_*"', // Copies all current env vars in process.env to the compiled binary that match the pattern.
  ]

  log(
    `bun ${buildArgs
      .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
      .join(' ')}`,
  )

  runCommand('bun', buildArgs, { cwd: cliRoot })

  // Ship tree-sitter.wasm as a sibling file next to the binary. Bun
  // --compile asset embedding is unreliable on Windows (every JS-level
  // retrieval mechanism we tried — `with { type: 'file' }`, base64 string
  // literals, chunked base64, function-wrapped chunked base64 — got
  // tree-shaken, minified away, or returned an undefined binding even
  // when the bytes were in the binary). The pre-init reads it from
  // `dirname(process.execPath)`, which works the same on every platform
  // because it's a normal disk read, not a bunfs lookup.
  const sourceWasm = findWebTreeSitterWasm()
  const siblingWasm = join(binDir, 'tree-sitter.wasm')
  writeFileSync(siblingWasm, readFileSync(sourceWasm))
  logAlways(`Copied tree-sitter.wasm sibling: ${sourceWasm} → ${siblingWasm}`)

  if (targetInfo.platform !== 'win32') {
    chmodSync(outputFile, 0o755)
  }

  logAlways(
    `✅ Built ${outputFilename} (${getCliTargetLabel(targetInfo)})`,
  )
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message)
  } else {
    console.error(error)
  }
  process.exit(1)
})

/**
 * Find web-tree-sitter's tree-sitter.wasm in any plausible node_modules
 * layout — bun hoists differently across platforms and `bun install`
 * variants, and CI Windows lays it out differently than monorepo-root
 * installs.
 */
function findWebTreeSitterWasm(): string {
  const candidates = [
    join(cliRoot, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    join(cliRoot, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    join(cliRoot, '..', 'sdk', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) return found
  try {
    return cliRequire.resolve('web-tree-sitter/tree-sitter.wasm')
  } catch (err) {
    throw new Error(
      `Could not locate web-tree-sitter/tree-sitter.wasm. Searched:\n  - ` +
        candidates.join('\n  - ') +
        `\nAnd createRequire failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function prepareOpenTuiNativeBundle(targetInfo: TargetInfo) {
  const packageName = `@opentui/core-${targetInfo.platform}-${targetInfo.arch}`
  const packageFolder = `core-${targetInfo.platform}-${targetInfo.arch}`
  const cliPackageJson = JSON.parse(
    readFileSync(join(cliRoot, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
  }
  const expectedCoreVersion = cliPackageJson.dependencies?.['@opentui/core']
  const expectedReactVersion = cliPackageJson.dependencies?.['@opentui/react']
  if (!expectedCoreVersion || !expectedReactVersion) {
    throw new Error('CLI package metadata must pin OpenTUI core and react')
  }

  const corePackage = getInstalledOpenTuiPackage(
    'core',
    expectedCoreVersion,
  )
  // Resolve both packages up front so a stale split install fails before build.
  void getInstalledOpenTuiPackage('react', expectedReactVersion)

  const packagesDir = dirname(corePackage.packageDir)
  const packageDir = join(packagesDir, packageFolder)
  const version = corePackage.packageJson.optionalDependencies?.[packageName]
  if (version !== expectedCoreVersion) {
    throw new Error(
      `Installed OpenTUI core does not declare ${packageName}@${expectedCoreVersion}`,
    )
  }

  const registry =
    process.env.CODEBUFF_NPM_REGISTRY ?? process.env.NPM_REGISTRY_URL
  const installResult = ensureOpenTuiNativeBundle({
    packageDir,
    version,
    targetInfo,
    installBundle: (stagingRoot) => {
      runCommand(
        'bun',
        [
          'install',
          '--cwd',
          stagingRoot,
          '--no-save',
          `--os=${targetInfo.platform}`,
          `--cpu=${targetInfo.arch}`,
          ...(registry ? [`--registry=${registry}`] : []),
          `${packageName}@${version}`,
        ],
        { env: process.env },
      )
    },
  })

  if (installResult === 'reused') {
    log(
      `OpenTUI native bundle ${version} already present for ${targetInfo.platform}-${targetInfo.arch}`,
    )
  } else {
    logAlways(
      `Installed OpenTUI native bundle ${version} for ${targetInfo.platform}-${targetInfo.arch}`,
    )
  }
}

function getInstalledOpenTuiPackage(
  packageFolder: 'core' | 'react',
  expectedVersion: string,
): {
  packageDir: string
  packageJson: {
    name?: unknown
    version?: unknown
    optionalDependencies?: Record<string, string>
  }
} {
  const packageName = `@opentui/${packageFolder}`
  let packageDir: string
  try {
    packageDir = dirname(realpathSync(cliRequire.resolve(packageName)))
  } catch {
    throw new Error(`${packageName} is missing; run bun install before building`)
  }

  const packageJson = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as {
    name?: unknown
    version?: unknown
    optionalDependencies?: Record<string, string>
  }
  if (
    packageJson.name !== packageName ||
    packageJson.version !== expectedVersion
  ) {
    throw new Error(
      `Installed ${packageName}@${String(packageJson.version)} does not match cli/package.json (${expectedVersion}); run bun install`,
    )
  }

  return { packageDir, packageJson }
}
