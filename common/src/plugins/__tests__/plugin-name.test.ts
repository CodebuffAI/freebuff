import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  CANONICAL_SCHEMA,
  expectManifestOk,
  expectManifestRejected,
  makePluginRoot,
  MAX_NAME_LENGTH,
} from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('plugin name (spec §5.5)', () => {
  /**
   * Given each name the §5.5 constraints accept, when loaded, the plugin
   * loads carrying that name — including the 64-character inclusive edge.
   */
  test.each([
    ['my-plugin', 'spec valid list'],
    ['acme.tools', 'spec valid list'],
    ['lint3r', 'spec valid list'],
    ['a', 'spec valid list'],
    ['a'.repeat(MAX_NAME_LENGTH), '64 chars — inclusive edge (derived)'],
  ])('name %j → ok (%s)', (name) => {
    const root = makePluginRoot(
      JSON.stringify({ $schema: CANONICAL_SCHEMA, name }),
    )

    const result = loadManifest(root)

    const { manifest } = expectManifestOk(result)
    expect(manifest.name).toBe(name)
  })

  /**
   * Given each name that breaks a §5.5 constraint — the spec's own invalid
   * list plus the two edges derived from it — when loaded, the plugin is
   * rejected with a reason naming `name`.
   */
  test.each([
    ['My-Plugin', 'uppercase (spec invalid list)'],
    ['-start', 'leading hyphen (spec invalid list)'],
    ['has--double', 'consecutive hyphens (spec invalid list)'],
    ['too.many..dots', 'consecutive periods (spec invalid list)'],
    ['', 'empty (spec invalid list)'],
    ['end-', 'trailing hyphen (derived from start/end rule)'],
    ['a'.repeat(MAX_NAME_LENGTH + 1), '65 chars — one past the edge (derived)'],
  ])('name %j → rejected (%s)', (name) => {
    const root = makePluginRoot(
      JSON.stringify({ $schema: CANONICAL_SCHEMA, name }),
    )

    const result = loadManifest(root)

    expectManifestRejected(result, 'name')
  })
})
