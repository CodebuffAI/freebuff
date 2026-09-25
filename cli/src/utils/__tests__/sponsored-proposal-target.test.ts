/**
 * What an offer in this terminal is keyed to. The folder's id wins over
 * `owner/repo` because the server keys every IN-PLACE offer to the folder
 * (#3989): a repository polled by its remote would never find its own rows.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { setProjectRoot } = await import('../../project-files')
const { sponsoredProposalLocalTarget } =
  await import('../sponsored-proposal-target')

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const roots: string[] = []
afterAll(() =>
  roots.forEach((root) => rmSync(root, { recursive: true, force: true })),
)

function folder(withId: boolean): string {
  // No `.git`, so selecting it never writes a marker of its own.
  const root = mkdtempSync(join(tmpdir(), 'sponsored-target-'))
  roots.push(root)
  if (withId) {
    mkdirSync(join(root, '.freebuff'))
    writeFileSync(join(root, '.freebuff', 'project-id'), `${ID}\n`)
  }
  return root
}

describe('the sponsored target', () => {
  test('is the folder id when there is one, even with a GitHub remote', async () => {
    setProjectRoot(folder(true))
    expect(
      await sponsoredProposalLocalTarget(
        async () => 'git@github.com:acme/app.git',
      ),
    ).toEqual({ kind: 'workspace', workspaceId: ID })
  })

  test('falls back to owner/repo only where no id exists', async () => {
    setProjectRoot(folder(false))
    expect(
      await sponsoredProposalLocalTarget(
        async () => 'git@github.com:acme/app.git',
      ),
    ).toEqual({ kind: 'repo', repoFullName: 'acme/app' })
  })

  test('is nothing with neither', async () => {
    setProjectRoot(folder(false))
    expect(await sponsoredProposalLocalTarget(async () => null)).toBeNull()
  })
})
