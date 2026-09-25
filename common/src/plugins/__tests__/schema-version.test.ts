import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  expectManifestRejected,
  makePluginRoot,
  MINIMAL_NAME,
  UNSUPPORTED_SCHEMA,
} from './fixtures/manifest'
import {
  cleanUpPluginFixtures,
  watchNetworkAccess,
} from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('schema version selection (spec §5.2)', () => {
  /**
   * Given a manifest declaring a specification version this client does not
   * support, when loaded, the plugin is rejected and the reason names the
   * version it declared (§5.2 SHOULD report the unsupported version).
   */
  test('an unsupported version is rejected, naming the version it declared', () => {
    const root = makePluginRoot(
      JSON.stringify({ $schema: UNSUPPORTED_SCHEMA, name: MINIMAL_NAME }),
    )

    const result = loadManifest(root)

    expectManifestRejected(result, UNSUPPORTED_SCHEMA)
  })

  /**
   * Given a client loading a plugin, when the manifest is read, nothing
   * reaches for the network to fetch the schema it names (§5.2 MUST NOT
   * retrieve a schema while loading a plugin).
   */
  test('loading a plugin does not retrieve the declared schema', () => {
    const fetchSpy = watchNetworkAccess()

    const root = makePluginRoot(
      JSON.stringify({ $schema: UNSUPPORTED_SCHEMA, name: MINIMAL_NAME }),
    )

    loadManifest(root)

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
