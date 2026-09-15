import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  if (initialized.status !== 0) throw new Error('could not initialize Git fixture')
  if (origin) {
    const remote = spawnSync('git', ['-C', root, 'remote', 'add', 'origin', origin])
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
