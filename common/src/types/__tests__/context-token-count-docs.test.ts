import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

/**
 * `contextTokenCount` is documented twice, in two packages that BOTH publish:
 * `common` and `agents` are include lines in scripts/public-export-manifest.txt,
 * so both docstrings ship to the public repo with their comments intact.
 *
 * They described the same field differently — one as a local GPT-4o estimate,
 * the other as "the token count from the Anthropic API … via the
 * /api/v1/token-count endpoint", an endpoint that no longer exists. An agent
 * author reading the second one sizes their history against a number the
 * runtime never asks for. Nothing typechecks a comment, so this is the only
 * place that can hold the two together.
 */

// __tests__ → types → src → common → repo root
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

const SOURCES = [
  join(REPO_ROOT, 'common', 'src', 'types', 'session-state.ts'),
  join(
    REPO_ROOT,
    'common',
    'src',
    'templates',
    'initial-agents-dir',
    'types',
    'agent-definition.ts',
  ),
  join(REPO_ROOT, 'agents', 'types', 'agent-definition.ts'),
  // Local agent templates carry a copy of the same public type. Absent from
  // the published export, hence the existence check rather than a hard path.
  join(REPO_ROOT, '.agents', 'types', 'agent-definition.ts'),
].filter((path) => existsSync(path))

/** The docblock immediately above the `contextTokenCount: number` field. */
function contextTokenCountDoc(source: string): string {
  const field = source.indexOf('contextTokenCount: number')
  expect(field).toBeGreaterThan(-1)
  const open = source.lastIndexOf('/**', field)
  expect(open).toBeGreaterThan(-1)
  return source.slice(open, field)
}

describe('the contextTokenCount docstrings', () => {
  test('there is more than one of them, and they all publish', () => {
    // If this drops to one the rest of the file is trivially true and would
    // stop meaning anything.
    expect(SOURCES.length).toBeGreaterThanOrEqual(2)
  })

  for (const path of SOURCES) {
    const doc = contextTokenCountDoc(readFileSync(path, 'utf8'))
    const where = path.slice(REPO_ROOT.length + 1)

    test(`${where} does not promise the deleted count endpoint`, () => {
      // The deleted round trip. A comment that names an endpoint is a comment
      // someone will try to call.
      expect(doc, where).not.toContain('/api/v1/token-count')
      expect(doc.toLowerCase(), where).not.toContain(
        'token count from the anthropic api',
      )
    })

    test(`${where} says what it actually is`, () => {
      expect(doc, where).toContain(
        "Latest model call's reported input + output",
      )
      expect(doc.toLowerCase(), where).toContain('estimate')
      expect(doc.toLowerCase(), where).toContain('never accumulated')
      expect(doc, where).not.toContain('GPT-4o')
    })
  }
})
