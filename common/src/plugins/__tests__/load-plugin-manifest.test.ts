import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  CANONICAL_SCHEMA,
  expectManifestOk,
  expectManifestRejected,
  makePluginRoot,
  makeRootWithoutManifest,
  MINIMAL_NAME,
  NON_JSON_TEXT,
} from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('loadManifest', () => {
  /**
   * Given the manifest of the spec's own §5.2 example, when loaded, the
   * plugin loads carrying that name and no report is emitted.
   */
  test('minimal valid manifest (spec 1.0.0 §5.2 example) → ok with no reports', () => {
    const root = makePluginRoot(
      JSON.stringify({ $schema: CANONICAL_SCHEMA, name: MINIMAL_NAME }),
    )

    const result = loadManifest(root)

    const { manifest, reports } = expectManifestOk(result)
    expect(manifest.name).toBe(MINIMAL_NAME)
    expect(reports).toHaveLength(0)
  })

  /**
   * Given a plugin.json that is not valid JSON, when loaded, the plugin is
   * rejected with a reason saying the manifest is not valid JSON (§5.2: the
   * manifest MUST be JSON).
   */
  test('a plugin.json that is not valid JSON is rejected', () => {
    const root = makePluginRoot(NON_JSON_TEXT)

    const result = loadManifest(root)

    expectManifestRejected(result, 'not valid JSON')
  })

  /**
   * Given a plugin root with no plugin.json, when loaded, the plugin is
   * rejected with a reason naming the missing manifest (§5.1: clients MUST
   * check for a manifest at plugin.json) and no report, since a report
   * describes a manifest that was read. A path that is present but resolves
   * nowhere — a dangling reparse point — yields no readable manifest either
   * and reaches the same refusal.
   */
  test('a root without plugin.json is rejected, naming the missing manifest', () => {
    const root = makeRootWithoutManifest()

    const result = loadManifest(root)

    const rejection = expectManifestRejected(result, 'no plugin.json')
    expect(rejection.reports).toHaveLength(0)
  })

  describe('required fields (spec §5.3)', () => {
    /**
     * Given a manifest without $schema, when loaded, the plugin is rejected
     * with the reason naming $schema.
     */
    test('a manifest without $schema is rejected, naming $schema', () => {
      const root = makePluginRoot(JSON.stringify({ name: MINIMAL_NAME }))

      const result = loadManifest(root)

      expectManifestRejected(result, '$schema')
    })

    /**
     * Given a manifest without name, when loaded, the plugin is rejected
     * with the reason naming name.
     */
    test('a manifest without name is rejected, naming name', () => {
      const root = makePluginRoot(JSON.stringify({ $schema: CANONICAL_SCHEMA }))

      const result = loadManifest(root)

      expectManifestRejected(result, 'name')
    })

    /**
     * Given a manifest whose name is not a string, when loaded, the plugin
     * is rejected with the reason naming name.
     */
    test('a manifest with a non-string name is rejected, naming name', () => {
      const root = makePluginRoot(
        JSON.stringify({ $schema: CANONICAL_SCHEMA, name: 42 }),
      )

      const result = loadManifest(root)

      expectManifestRejected(result, 'name')
    })

    /**
     * Given a manifest whose $schema is not a string, when loaded, the
     * plugin is rejected with the reason naming $schema.
     */
    test('a manifest with a non-string $schema is rejected, naming $schema', () => {
      const root = makePluginRoot(
        JSON.stringify({ $schema: null, name: MINIMAL_NAME }),
      )

      const result = loadManifest(root)

      expectManifestRejected(result, '$schema')
    })
  })
})
