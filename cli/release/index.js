#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')

const packaged = path.join(__dirname, 'launcher.js')
const source = path.join(__dirname, '..', 'release-core', 'launcher.js')

const { createLauncher } = require(
  fs.existsSync(packaged) ? packaged : source
)

const launcher = createLauncher({
  packageName: 'codebuff',
  displayName: 'Codebuff',
  wrapperVersion: require('./package.json').version,
  tempDownloadDirName: '.download-temp',
})

module.exports = launcher

if (require.main === module) {
  launcher.main().catch(err => {
    console.error('❌ Unexpected error:', err.message)
    process.exit(1)
  })
}
