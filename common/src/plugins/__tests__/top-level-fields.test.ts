import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  CANONICAL_SCHEMA,
  expectManifestOk,
  expectManifestRejected,
  expectReportAbout,
  makeManifestRoot,
  makePluginRoot,
  TOP_LEVEL_ARRAY_JSON,
  TOP_LEVEL_NULL_JSON,
  TOP_LEVEL_STRING_JSON,
} from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('top-level fields (spec §5.2)', () => {
  /**
   * Given a plugin.json whose top level is an array, when loaded, the plugin
   * is rejected — §5.2 requires a top-level object, and an array is the
   * non-object a `typeof` check alone would accept.
   */
  test('a top-level array is rejected', () => {
    const root = makePluginRoot(TOP_LEVEL_ARRAY_JSON)

    const result = loadManifest(root)

    expectManifestRejected(result, 'top-level object')
  })

  /**
   * Given a plugin.json whose top level is a string primitive, when loaded,
   * the plugin is rejected — §5.2 requires a top-level object.
   */
  test('a top-level primitive is rejected', () => {
    const root = makePluginRoot(TOP_LEVEL_STRING_JSON)

    const result = loadManifest(root)

    expectManifestRejected(result, 'top-level object')
  })

  /**
   * Given a plugin.json whose top level is null, when loaded, the plugin is
   * rejected rather than crashing on a value `typeof` calls an object (§5.2
   * requires a top-level object).
   */
  test('a top-level null is rejected', () => {
    const root = makePluginRoot(TOP_LEVEL_NULL_JSON)

    const result = loadManifest(root)

    expectManifestRejected(result, 'top-level object')
  })

  /**
   * Given a valid manifest carrying one unknown top-level field, when
   * loaded, the plugin still loads (§5.2 MUST continue), a report names
   * the field, and the field is not carried onto the parsed manifest
   * (§5.2 MUST NOT assign semantics).
   */
  test('one unknown field is reported and ignored, plugin still loads', () => {
    const root = makeManifestRoot({ bogus: 1 })

    const result = loadManifest(root)

    const { manifest, reports } = expectManifestOk(result)
    expect(manifest).not.toHaveProperty('bogus')
    expect(reports).toHaveLength(1)
    expectReportAbout(reports, '§5.2', 'bogus')
  })

  /**
   * Given a valid manifest carrying two unknown top-level fields, when
   * loaded, one report names each field (§5.2 "report ... each unknown
   * field") — the spec orders the fields, not the reports, so the row
   * claims presence per field rather than report positions.
   */
  test('each unknown field gets its own report', () => {
    const root = makeManifestRoot({ bogus: 1, wat: 'x' })

    const result = loadManifest(root)

    const { reports } = expectManifestOk(result)
    expect(reports).toHaveLength(2)
    expectReportAbout(reports, '§5.2', 'bogus')
    expectReportAbout(reports, '§5.2', 'wat')
  })

  /**
   * Given a manifest with an unknown field and a fatal violation (name
   * missing), when loaded, the plugin is rejected (§5.3 fatality wins)
   * and the unknown-field report is still included in the rejection
   * result (§5.2 report requirement is not conditioned on the plugin
   * loading).
   */
  test('unknown-field report is included in a fatal rejection', () => {
    const root = makePluginRoot(
      JSON.stringify({ $schema: CANONICAL_SCHEMA, bogus: 1 }),
    )

    const result = loadManifest(root)

    const rejection = expectManifestRejected(result, 'name')
    expect(rejection.reports).toHaveLength(1)
    expect(rejection.reports[0].message).toContain('bogus')
  })
})
