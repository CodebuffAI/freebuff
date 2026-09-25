import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureSponsoredProjectIdentity } from '../sponsored-project-identity'

const roots: string[] = []

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)

function project(origin?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sponsored-project-identity-'))
  roots.push(root)
  const initialized = spawnSync('git', ['init', '--quiet', root])
  if (initialized.status !== 0)
    throw new Error('could not initialize Git fixture')
  if (origin) {
    const remote = spawnSync('git', [
      '-C',
      root,
      'remote',
      'add',
      'origin',
      origin,
    ])
    if (remote.status !== 0) throw new Error('could not add Git fixture remote')
  }
  return root
}

describe('ensureSponsoredProjectIdentity', () => {
  test('does not create a fallback marker in an origin-backed repository', () => {
    const root = project('git@github.com:acme/app.git')

    expect(ensureSponsoredProjectIdentity(root)).toBeNull()
    expect(existsSync(join(root, '.freebuff'))).toBe(false)
  })

  test('resolves an origin supplied through Git config includes', () => {
    const root = project()
    writeFileSync(
      join(root, 'origin.config'),
      '[remote "origin"]\n\turl = git@github.com:acme/included.git\n',
    )
    const included = spawnSync(
      'git',
      ['-C', root, 'config', 'include.path', '../origin.config'],
      { stdio: 'ignore' },
    )
    if (included.status !== 0) throw new Error('could not include Git fixture')

    expect(ensureSponsoredProjectIdentity(root)).toBeNull()
    expect(existsSync(join(root, '.freebuff'))).toBe(false)
  })

  test('creates a fallback marker only for a remote-less Git project', () => {
    const root = project()

    const identity = ensureSponsoredProjectIdentity(root)

    expect(identity).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(ensureSponsoredProjectIdentity(root)).toBe(identity)
  })

  test('keeps the fallback for an origin that cannot be a sponsored repo target', () => {
    const root = project('../local-mirror')

    expect(ensureSponsoredProjectIdentity(root)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})

describe('in Freebuff: every repository, without dirtying it (#3989)', () => {
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const status = (root: string) =>
    spawnSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).stdout.trim()

  test('an origin-backed repository gets the folder id an in-place offer is keyed to', () => {
    const root = project('git@github.com:acme/app.git')

    const identity = ensureSponsoredProjectIdentity(root, {
      everyRepository: true,
    })

    expect(identity).toMatch(UUID)
    expect(
      ensureSponsoredProjectIdentity(root, { everyRepository: true }),
    ).toBe(identity)
  })

  test('the marker never shows in git status, and the exclude is local', () => {
    const root = project('git@github.com:acme/app.git')
    ensureSponsoredProjectIdentity(root, { everyRepository: true })

    expect(status(root)).toBe('')
    expect(
      readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'),
    ).toContain('/.freebuff/')
    // `.gitignore` -- the SHARED list -- is never touched.
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
  })

  test('the exclude is written once, however many times the CLI starts', () => {
    const root = project('git@github.com:acme/app.git')
    for (let launch = 0; launch < 3; launch += 1) {
      ensureSponsoredProjectIdentity(root, { everyRepository: true })
    }
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('/.freebuff/').length - 1).toBe(1)
  })

  test('a COMMITTED marker does not grow the exclude on every launch', () => {
    // `git check-ignore` calls a tracked path "not ignored" whatever the
    // exclude says, so deciding on it alone appended once per launch.
    const root = project('git@github.com:acme/app.git')
    const identity = ensureSponsoredProjectIdentity(root, {
      everyRepository: true,
    })
    expect(identity).toMatch(UUID)
    spawnSync('git', ['-C', root, 'add', '-f', '.freebuff/project-id'])
    for (let launch = 0; launch < 3; launch += 1) {
      ensureSponsoredProjectIdentity(root, { everyRepository: true })
    }
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('/.freebuff/').length - 1).toBe(1)
  })

  test('a repository that already ignores .freebuff is left alone', () => {
    const root = project('git@github.com:acme/app.git')
    writeFileSync(join(root, '.gitignore'), '.freebuff/\n')
    const before = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')

    ensureSponsoredProjectIdentity(root, { everyRepository: true })

    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(
      before,
    )
  })

  test('a directory that is not a repository still gets nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'sponsored-project-identity-'))
    roots.push(root)
    expect(
      ensureSponsoredProjectIdentity(root, { everyRepository: true }),
    ).toBeNull()
    expect(existsSync(join(root, '.freebuff'))).toBe(false)
  })
})
