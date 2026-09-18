#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const packagedLauncherPath = path.join(__dirname, 'launcher.js')
const sourceLauncherPath = path.join(
  __dirname,
  '..',
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
  packageName: 'codecane',
  displayName: 'Codecane',
  wrapperVersion: packageJson.version,
  binaryChecksums: packageJson.binaryChecksums ?? null,
  includeTreeSitterWasm: false,
  startupBanner: [
    '\x1b[1m\x1b[91m' + '='.repeat(60) + '\x1b[0m',
    '\x1b[1m\x1b[93m❄️ CODECANE STAGING ENVIRONMENT ❄️\x1b[0m',
    '\x1b[1m\x1b[91mFOR TESTING PURPOSES ONLY - NOT FOR PRODUCTION USE\x1b[0m',
    '\x1b[1m\x1b[91m' + '='.repeat(60) + '\x1b[0m',
  ],
  telemetryProperties: { isStaging: true },
  tempDownloadDirName: '.download-temp-staging',
})

module.exports = launcher

if (require.main === module) {
  launcher.main().catch((error) => {
    console.error('❌ Unexpected error:', error.message)
    process.exit(1)
  })
}
