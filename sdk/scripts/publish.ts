#!/usr/bin/env node

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function log(message) {
  console.log(`📦 ${message}`)
}

/**
 * Takes an argv array, never a command line: no shell parses this, so nothing
 * a caller passes can become syntax. `execSync(command)` runs its string
 * through a shell, which is one interpolation away from an injection.
 */
function run(argv, options = {}) {
  const [file, ...args] = argv
  log(`Running: ${argv.join(' ')}`)
  try {
    return execFileSync(file, args, { stdio: 'inherit', ...options })
  } catch (error) {
    console.error(`❌ Command failed: ${argv.join(' ')}`)
    process.exit(1)
  }
}

function main() {
  const args = process.argv.slice(2)
  const isDryRun = args.includes('--dry-run')

  log('Starting SDK publishing process...')

  // Verify the package
  log('Verifying package contents...')
  run(['npm', 'pack', '--dry-run'])

  if (isDryRun) {
    log('Dry run complete! Package is ready for publishing.')
    log('To publish for real, run: bun run release')
    return
  }

  // Publish
  log('Publishing to npm...')
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  run(['npm', 'publish'])
  log('✅ SDK published successfully!')
  log(`📦 Package: ${packageJson.name}@${packageJson.version}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
