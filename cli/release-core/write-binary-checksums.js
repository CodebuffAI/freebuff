#!/usr/bin/env node

/**
 * Stamp the sha256 of every release archive into a launcher package.json, and
 * verify the result.
 *
 *   node write-binary-checksums.js write  --binary-name freebuff --binaries-dir binaries --package-dir freebuff/cli/release
 *   node write-binary-checksums.js verify --package-dir freebuff/cli/release
 *
 * `write` hashes `<binaries-dir>/<name>-<target>/<name>-<target>.tar.gz` for
 * every target in TARGET_KEYS — the artifact layout actions/download-artifact
 * produces, and the very files softprops/action-gh-release uploads to the
 * GitHub release — and writes them as `binaryChecksums` keyed by target. It
 * exits non-zero if any archive is missing or empty.
 *
 * `verify` re-reads the package.json and fails unless every target has a
 * well-formed checksum. The release workflows run it immediately before
 * `npm publish`: the launcher fails CLOSED on a missing checksum, so a
 * package published without a complete map would refuse to install on some
 * platform. Breaking the release here is the cheaper failure.
 *
 * Standalone on purpose (no dependencies, runs under the publish job's plain
 * Node): launcher.js requires `tar` at load time, so the target list is
 * repeated here and a test pins it to the launcher's PLATFORM_TARGET_KEYS.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const TARGET_KEYS = [
  'linux-x64',
  'linux-x64-baseline',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-x64-baseline',
]

const SHA256_HEX = /^[0-9a-f]{64}$/

function archiveFileName(binaryName, targetKey) {
  return `${binaryName}-${targetKey}.tar.gz`
}

function archivePath(binariesDir, binaryName, targetKey) {
  const fileName = archiveFileName(binaryName, targetKey)
  return path.join(binariesDir, `${binaryName}-${targetKey}`, fileName)
}

function sha256File(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')
}

/**
 * @returns {{ checksums: Record<string, string>, missing: string[] }}
 */
function computeChecksums(binariesDir, binaryName) {
  const checksums = {}
  const missing = []
  for (const targetKey of TARGET_KEYS) {
    const filePath = archivePath(binariesDir, binaryName, targetKey)
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      size = 0
    }
    if (size === 0) {
      missing.push(filePath)
      continue
    }
    checksums[targetKey] = sha256File(filePath)
  }
  return { checksums, missing }
}

/** @returns {string[]} problems; empty when every target is covered */
function findChecksumProblems(checksums) {
  const problems = []
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)) {
    return ['package.json has no binaryChecksums object']
  }
  for (const targetKey of TARGET_KEYS) {
    const value = checksums[targetKey]
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
      problems.push(
        `${targetKey}: ${value === undefined ? 'missing' : `not a sha256 hex digest (${JSON.stringify(value)})`}`,
      )
    }
  }
  for (const key of Object.keys(checksums)) {
    if (!TARGET_KEYS.includes(key)) {
      problems.push(`${key}: not a known target`)
    }
  }
  return problems
}

function readPackageJson(packageDir) {
  return JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  )
}

function writeChecksums({ binariesDir, binaryName, packageDir }) {
  const packageJsonPath = path.join(packageDir, 'package.json')
  const packageJson = readPackageJson(packageDir)
  if (packageJson.name !== binaryName) {
    throw new Error(
      `Refusing to stamp ${binaryName} archives into package "${packageJson.name}" (${packageJsonPath})`,
    )
  }

  const { checksums, missing } = computeChecksums(binariesDir, binaryName)
  if (missing.length > 0) {
    throw new Error(
      `Missing or empty release archives; refusing to publish an unverifiable launcher:\n  ${missing.join('\n  ')}`,
    )
  }

  packageJson.binaryChecksums = checksums
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')

  for (const targetKey of TARGET_KEYS) {
    console.log(
      `${checksums[targetKey]}  ${archiveFileName(binaryName, targetKey)}`,
    )
  }
  console.log(
    `Wrote binaryChecksums for ${packageJson.name}@${packageJson.version} to ${packageJsonPath}`,
  )
  return checksums
}

function verifyChecksums({ packageDir }) {
  const packageJson = readPackageJson(packageDir)
  const problems = findChecksumProblems(packageJson.binaryChecksums)
  if (problems.length > 0) {
    throw new Error(
      `${packageJson.name}@${packageJson.version} package.json binaryChecksums is incomplete:\n  ${problems.join('\n  ')}`,
    )
  }
  console.log(
    `Verified binaryChecksums for ${packageJson.name}@${packageJson.version}: ${TARGET_KEYS.length} targets`,
  )
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Bad argument: ${flag}`)
    }
    options[flag.slice(2)] = value
  }
  return { command, options }
}

function main(argv) {
  const { command, options } = parseArgs(argv)
  if (command === 'write') {
    for (const required of ['binary-name', 'binaries-dir', 'package-dir']) {
      if (!options[required]) throw new Error(`write requires --${required}`)
    }
    writeChecksums({
      binariesDir: path.resolve(options['binaries-dir']),
      binaryName: options['binary-name'],
      packageDir: path.resolve(options['package-dir']),
    })
    return
  }
  if (command === 'verify') {
    if (!options['package-dir'])
      throw new Error('verify requires --package-dir')
    verifyChecksums({ packageDir: path.resolve(options['package-dir']) })
    return
  }
  throw new Error(
    'Usage: write-binary-checksums.js write --binary-name <name> --binaries-dir <dir> --package-dir <dir> | verify --package-dir <dir>',
  )
}

module.exports = {
  TARGET_KEYS,
  archiveFileName,
  archivePath,
  computeChecksums,
  findChecksumProblems,
  writeChecksums,
  verifyChecksums,
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error.message}`)
    process.exit(1)
  }
}
