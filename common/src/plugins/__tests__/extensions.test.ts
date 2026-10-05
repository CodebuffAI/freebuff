import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  expectManifestOk,
  expectReportAbout,
  makeManifestRoot,
} from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('extensions field (spec §8.1)', () => {
  /**
   * Given a manifest without extensions, when loaded, the manifest
   * carries no extensions value and no report is emitted (§8.1: the
   * field is optional).
   */
  test('absent extensions loads with no value and no reports', () => {
    const root = makeManifestRoot()

    const result = loadManifest(root)

    const { manifest, reports } = expectManifestOk(result)
    expect(manifest.extensions).toBeUndefined()
    expect(reports).toHaveLength(0)
  })

  /**
   * Given a manifest whose extensions is an object of namespace entries
   * (the §8.1 example), when loaded, the object reaches the manifest
   * unchanged and no report is emitted about its contents (§8.1).
   */
  test('extensions object is carried onto the manifest unchanged, with no reports', () => {
    const extensions = { 'com.example.client': { setting: true } }
    const root = makeManifestRoot({ extensions })

    const result = loadManifest(root)

    const { manifest, reports } = expectManifestOk(result)
    expect(manifest.extensions).toEqual(extensions)
    expect(reports).toHaveLength(0)
  })

  /**
   * Given a manifest whose extensions is a string, when loaded, the
   * plugin still loads (§8.1: MUST continue), a report names extensions,
   * and the manifest carries no extensions value.
   */
  test('non-object extensions is reported and ignored', () => {
    const root = makeManifestRoot({ extensions: 'nope' })

    const result = loadManifest(root)

    const { manifest, reports } = expectManifestOk(result)
    expect(manifest.extensions).toBeUndefined()
    expect(reports).toHaveLength(1)
    expectReportAbout(reports, '§8.1', 'extensions')
  })
})
