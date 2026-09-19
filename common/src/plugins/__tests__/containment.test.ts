import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  expectManifestOk,
  expectManifestRejected,
  makeEscapingManifestRoot,
  makeReparsePointRoot,
  MINIMAL_NAME,
} from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('containment (spec §4.1.1)', () => {
  /**
   * Given a plugin root whose plugin.json is a reparse point resolving to a
   * valid manifest outside the root, when loaded, the plugin is rejected
   * before that manifest is read — §4.1.1 rejects the plugin itself when its
   * manifest escapes, and resolving the paths must not fall back on how the
   * root happens to be spelled.
   */
  test('a plugin.json resolving outside the root is rejected', () => {
    const root = makeEscapingManifestRoot()

    const result = loadManifest(root)

    expectManifestRejected(result, 'outside the plugin root')
  })

  /**
   * Given a plugin root reached through a reparse point with its manifest
   * inside the resolved root, when loaded, the plugin loads — §4.1.1 permits
   * reparse points that resolve within the root, so the root is resolved
   * before the comparison rather than refused for being one.
   */
  test('a root reached through a reparse point still loads', () => {
    const root = makeReparsePointRoot()

    const result = loadManifest(root)

    const { manifest } = expectManifestOk(result)
    expect(manifest.name).toBe(MINIMAL_NAME)
  })
})
