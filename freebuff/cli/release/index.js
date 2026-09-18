#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const packagedLauncherPath = path.join(__dirname, 'launcher.js')
const sourceLauncherPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'cli',
  'release-core',
  'launcher.js',
)
// Published packages must not let an unrelated sibling path shadow their
// bundled launcher. Source checkouts only fall back when that copy is absent.
const { createLauncher } = require(
  fs.existsSync(packagedLauncherPath)
    ? packagedLauncherPath
    : sourceLauncherPath,
)

const packageJson = require('./package.json')

const launcher = createLauncher({
  packageName: 'freebuff',
  displayName: 'Freebuff',
  wrapperVersion: packageJson.version,
  binaryChecksums: packageJson.binaryChecksums ?? null,
  telemetryEvent: 'cli.update_freebuff_failed',
})

module.exports = launcher

if (require.main === module) {
  launcher.main().catch((error) => {
    console.error('❌ Unexpected error:', error.message)
    process.exit(1)
  })
}
