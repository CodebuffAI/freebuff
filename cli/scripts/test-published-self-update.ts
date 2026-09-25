#!/usr/bin/env bun

import { spawn, spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const [, , fromVersion, toVersion, target] = process.argv
const supportedTargets = new Set([
  'linux-x64',
  'linux-x64-baseline',
  'linux-arm64',
  'darwin-x64',
  'darwin-x64-baseline',
  'darwin-arm64',
  'win32-x64',
  'win32-x64-baseline',
])

if (!fromVersion || !toVersion || !target || !supportedTargets.has(target)) {
  console.error(
    'Usage: bun test-published-self-update.ts <from-version> <to-version> <target>',
  )
  process.exit(2)
}

const testRoot = mkdtempSync(join(tmpdir(), 'freebuff-self-update-'))
const homeDir = join(testRoot, 'home')
const npmPrefix = join(testRoot, 'npm')
const projectDir = join(testRoot, 'project')
const configDir = join(homeDir, '.config', 'manicode')
const binaryName = process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'
const binaryPath = join(configDir, binaryName)
const metadataPath = join(configDir, 'freebuff-metadata.json')
const archivePath = join(testRoot, `freebuff-${fromVersion}.tar.gz`)
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const nodeCommand = process.platform === 'win32' ? 'node.exe' : 'node'
const tarCommand =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
const testEnv = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  npm_config_prefix: npmPrefix,
  FREEBUFF_BINARY_TARGET: target,
  NO_COLOR: '1',
  TERM: 'dumb',
}
let launcherProcess: ReturnType<typeof spawn> | undefined

mkdirSync(configDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    env: testEnv,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    )
  }
  return `${result.stdout}${result.stderr}`
}

function readInstalledVersion() {
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    return metadata.version as string | undefined
  } catch {
    return undefined
  }
}

function stopProcessTree(pid: number) {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The process already exited.
  }
}

async function main() {
  console.log(`Installing npm launcher freebuff@${fromVersion}...`)
  run(npmCommand, [
    'install',
    '--global',
    `freebuff@${fromVersion}`,
    '--no-audit',
    '--no-fund',
  ])

  const globalRoot = run(npmCommand, ['root', '--global']).trim()
  const packageDir = join(globalRoot, 'freebuff')
  const packageVersion = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ).version
  if (packageVersion !== fromVersion) {
    throw new Error(
      `Expected npm launcher ${fromVersion}, installed ${packageVersion}`,
    )
  }

  const assetName = `freebuff-${target}.tar.gz`
  const assetUrl = `https://github.com/CodebuffAI/codebuff-community/releases/download/freebuff-v${fromVersion}/${assetName}`
  console.log(`Seeding ${assetName} from ${assetUrl}...`)
  const response = await fetch(assetUrl)
  if (!response.ok) {
    throw new Error(
      `Failed to download old release asset: HTTP ${response.status}`,
    )
  }
  await Bun.write(archivePath, await response.arrayBuffer())
  // Git Bash puts its GNU tar first on PATH and interprets `C:\...` as an
  // obsolete remote-tape address. Use Windows' native bsdtar explicitly.
  run(tarCommand, ['-xzf', archivePath, '-C', configDir])
  if (!existsSync(binaryPath)) {
    throw new Error(`Old release archive did not contain ${binaryName}`)
  }
  if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)

  writeFileSync(
    metadataPath,
    JSON.stringify({ version: fromVersion, target }, null, 2),
  )
  const oldVersionOutput = run(binaryPath, ['--version'])
  if (!oldVersionOutput.includes(fromVersion)) {
    throw new Error(`Seeded binary is not ${fromVersion}: ${oldVersionOutput}`)
  }

  console.log(`Launching ${fromVersion} and waiting for ${toVersion}...`)
  const launcherPath = join(packageDir, 'index.js')
  // For deferred wrappers, drive the same lifecycle as main() but await the
  // background check so we know the download is ready before requesting exit.
  // Historical wrappers still exercise their immediate-relaunch path.
  const launcher = spawn(
    nodeCommand,
    [
      '-e',
      `
    const fs = require('fs')
    const path = require('path')
    const launcher = require(process.argv[1])
    async function run() {
      if (!launcher.config.deferUpdatesUntilExit) return launcher.main()
      const t = launcher.__testing
      await t.ensureBinaryReady()
      const child = t.spawnInstalledBinary()
      const exitListener = t.attachExitHandler(child)
      process.on('message', (message) => {
        if (message === 'finish-session') child.kill('SIGTERM')
      })
      await t.checkForUpdates(child, exitListener)
      if (!fs.existsSync(path.join(t.CONFIG.tempDownloadDir, t.CONFIG.binaryName))) {
        throw new Error('No verified update was staged')
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('The running CLI exited during its update download')
      }
      process.send({ type: 'update-staged' })
    }
    run().catch((error) => { console.error(error); process.exit(1) })
  `,
      launcherPath,
    ],
    {
      cwd: projectDir,
      env: testEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  launcherProcess = launcher
  let deferredUpdateReady = false
  launcher.on('message', (message) => {
    if ((message as { type?: string })?.type === 'update-staged')
      deferredUpdateReady = true
  })
  const launcherExited = new Promise<number | null>((resolve) =>
    launcher.once('close', resolve),
  )
  let output = ''
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-2_000_000)
  }
  launcher.stdout!.on('data', append)
  launcher.stderr!.on('data', append)

  const deadline = Date.now() + 6 * 60_000
  while (
    Date.now() < deadline &&
    readInstalledVersion() !== toVersion &&
    !deferredUpdateReady
  ) {
    if (launcher.exitCode !== null) {
      throw new Error(
        `Launcher exited before updating (code ${launcher.exitCode})\n${output.slice(-16_000)}`,
      )
    }
    await Bun.sleep(1_000)
  }

  if (deferredUpdateReady) {
    if (readInstalledVersion() !== fromVersion) {
      throw new Error(
        'Update replaced the installed binary before the session exited',
      )
    }
    console.log(
      'Update staged; ending the CLI session to allow installation...',
    )
    launcher.send('finish-session')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exitCode = await Promise.race([
        launcherExited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('CLI did not exit after the deferred update')),
            15_000,
          )
        }),
      ])
      // Windows terminates the child directly for SIGTERM; POSIX runs the
      // CLI's clean-exit handler. Both must retain the original exit result.
      const expectedExitCode = process.platform === 'win32' ? 1 : 0
      if (exitCode !== expectedExitCode)
        throw new Error(`CLI exited with ${exitCode}\n${output.slice(-16_000)}`)
    } finally {
      clearTimeout(timer)
    }
    if (
      !output.includes(
        `Updated Freebuff to ${toVersion}. Ready for your next launch.`,
      )
    ) {
      throw new Error(
        `Missing deferred-install message\n${output.slice(-16_000)}`,
      )
    }
  }

  if (readInstalledVersion() !== toVersion) {
    throw new Error(`Timed out waiting for self-update to ${toVersion}`)
  }

  if (!deferredUpdateReady) {
    await Bun.sleep(3_000)
    if (launcher.exitCode !== null) {
      throw new Error(
        `Launcher exited after installing ${toVersion} (code ${launcher.exitCode})\n${output.slice(-16_000)}`,
      )
    }
    if (!output.includes('Update available:')) {
      throw new Error(
        `Missing update handoff message\n${output.slice(-16_000)}`,
      )
    }
    if (!output.includes('Download complete! Starting Freebuff')) {
      throw new Error(
        `Missing successful relaunch message\n${output.slice(-16_000)}`,
      )
    }
  }

  const newVersionOutput = run(binaryPath, ['--version'])
  if (!newVersionOutput.includes(toVersion)) {
    throw new Error(`Installed binary is not ${toVersion}: ${newVersionOutput}`)
  }
  const treeSitterOutput = run(binaryPath, ['--smoke-tree-sitter'])
  if (!treeSitterOutput.includes('tree-sitter smoke ok')) {
    throw new Error(`Tree-sitter smoke failed: ${treeSitterOutput}`)
  }

  console.log(
    `Self-update OK: npm launcher ${fromVersion}, ${target} binary ${fromVersion} -> ${toVersion}`,
  )
  if (launcher.exitCode === null) {
    stopProcessTree(launcher.pid!)
    await Bun.sleep(1_000)
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
  .finally(() => {
    if (launcherProcess?.pid && launcherProcess.exitCode === null) {
      stopProcessTree(launcherProcess.pid)
    }
    rmSync(testRoot, { recursive: true, force: true })
  })
