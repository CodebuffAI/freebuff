import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createSponsoredRootedFileSystem,
  sponsoredStatCommand,
} from '../tools/sponsored-rooted-filesystem'

import type { TerminalCommandBroker } from '../tools/run-terminal-command'

function directBroker(): TerminalCommandBroker {
  return {
    start(request) {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        // Pin the locale for the helper subprocess. A guard failure is asserted
        // on the message coreutils prints, and coreutils translates that message
        // ("El archivo ya existe"), so without this the test passes on the
        // English CI runners and fails on any other locale. LC_ALL=C alone is
        // enough: it takes precedence over LANG and LANGUAGE.
        env: { ...request.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        completion: new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        }),
        kill: (signal) => child.kill(signal),
        isAlive: () => child.exitCode === null && child.signalCode === null,
      }
    },
  }
}

describe('sponsored rooted filesystem', () => {
  test('uses GNU stat newlines on Linux instead of the filename directive', () => {
    const command = sponsoredStatCommand('linux')
    expect(command).toBe(
      String.raw`/usr/bin/stat --printf '%s\n%X\n%F\n' -- "$1"`,
    )
    expect(command).not.toContain('%n')
  })

  test('permitted reads and brokered mutations work inside the root', async () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sponsored-rooted-fs-'),
    )
    const root = path.join(parent, 'worktree')
    const runtimeDir = path.join(parent, 'runtime')
    fs.mkdirSync(root, { recursive: true })
    try {
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        runtimeDir,
        processBroker: directBroker(),
      })
      await rooted.mkdir(path.join(root, 'src'), { recursive: true })
      await rooted.writeFile(path.join(root, 'src', 'inside.ts'), 'inside\n')
      expect(
        await rooted.readFile(path.join(root, 'src', 'inside.ts'), 'utf8'),
      ).toBe('inside\n')
      expect(await rooted.readdir(path.join(root, 'src'))).toEqual([
        'inside.ts',
      ])
      await rooted.unlink(path.join(root, 'src', 'inside.ts'))
      expect(fs.existsSync(path.join(root, 'src', 'inside.ts'))).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('a parent swap after validation never reaches a host destination write', async () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sponsored-rooted-race-'),
    )
    const root = path.join(parent, 'worktree')
    const outside = path.join(parent, 'outside')
    const runtimeDir = path.join(parent, 'runtime')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(path.join(root, 'late'))
    const starts: string[] = []
    const swappingBroker: TerminalCommandBroker = {
      start(request) {
        starts.push(request.executable)
        fs.renameSync(path.join(root, 'late'), path.join(root, 'original'))
        fs.symlinkSync(outside, path.join(root, 'late'))
        return directBroker().start(request)
      },
    }
    try {
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        runtimeDir,
        processBroker: swappingBroker,
      })
      await expect(
        rooted.writeFile(path.join(root, 'late', 'escaped.ts'), 'escaped'),
      ).rejects.toThrow(/helper exited with code 73/)
      expect(starts).toEqual(['/bin/sh'])
      expect(fs.existsSync(path.join(outside, 'escaped.ts'))).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('a failed directory guard cannot continue in the wrong ancestor', async () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sponsored-rooted-guard-race-'),
    )
    const root = path.join(parent, 'worktree')
    const runtimeDir = path.join(parent, 'runtime')
    const guarded = path.join(root, 'late')
    fs.mkdirSync(guarded, { recursive: true })
    const swappingBroker: TerminalCommandBroker = {
      start(request) {
        fs.renameSync(guarded, path.join(root, 'original-directory'))
        fs.writeFileSync(guarded, 'now a file')
        return directBroker().start(request)
      },
    }
    try {
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        runtimeDir,
        processBroker: swappingBroker,
      })
      await expect(
        rooted.writeFile(path.join(guarded, 'escaped.ts'), 'escaped'),
      ).rejects.toThrow(/mkdir:.*late.*File exists|helper exited with code 74/)
      expect(fs.existsSync(path.join(root, 'escaped.ts'))).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('a parent swap after validation cannot list outside names', async () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sponsored-rooted-list-race-'),
    )
    const root = path.join(parent, 'worktree')
    const outside = path.join(parent, 'outside')
    const runtimeDir = path.join(parent, 'runtime')
    const listed = path.join(root, 'late')
    fs.mkdirSync(listed, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'outside-secret'), 'secret')
    let swapped = false
    const swappingBroker: TerminalCommandBroker = {
      start(request) {
        if (!swapped) {
          swapped = true
          fs.renameSync(listed, path.join(root, 'original-directory'))
          fs.symlinkSync(outside, listed)
        }
        return directBroker().start(request)
      },
    }
    try {
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        runtimeDir,
        processBroker: swappingBroker,
      })
      await expect(rooted.readdir(listed)).rejects.toThrow()
      expect(swapped).toBe(true)
      expect(fs.readdirSync(outside)).toEqual(['outside-secret'])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('a parent swap after validation cannot read outside content', async () => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sponsored-rooted-read-race-'),
    )
    const root = path.join(parent, 'worktree')
    const outside = path.join(parent, 'outside')
    const runtimeDir = path.join(parent, 'runtime')
    const readParent = path.join(root, 'late')
    fs.mkdirSync(readParent, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(readParent, 'target'), 'inside')
    fs.writeFileSync(path.join(outside, 'target'), 'outside-secret')
    const swappingBroker: TerminalCommandBroker = {
      start(request) {
        fs.renameSync(readParent, path.join(root, 'original-directory'))
        fs.symlinkSync(outside, readParent)
        return directBroker().start(request)
      },
    }
    try {
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        runtimeDir,
        processBroker: swappingBroker,
      })
      await expect(
        rooted.readFile(path.join(readParent, 'target'), 'utf8'),
      ).rejects.toThrow()
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
