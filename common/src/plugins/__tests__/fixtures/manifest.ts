import path from 'node:path'

import { writeFileSync } from 'node:fs'

import { expect } from 'bun:test'

import { linkJunction, makeOutsideDir, makeTempDir } from './temp-roots'

import type { LoadManifestResult } from '../../load-plugin-manifest'
import type { PluginReport } from '../../report'

/**
 * The manifest-component fixtures: §5 constants, manifest-root builders
 * (including the §4.1.1 escape arrangements), and the load-result assertion
 * helpers. Skill fixtures live in `skills.ts`, the shared machinery in
 * `temp-roots.ts`.
 */

/** The $schema id every valid 1.0.0 manifest must carry (spec §5.2). */
export const CANONICAL_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/** A canonical-looking schema id for a spec version this client cannot load. */
export const UNSUPPORTED_SCHEMA =
  'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json'

/** The §5.5 name of the §5.2 minimal-manifest example, used across the tests. */
export const MINIMAL_NAME = 'minimal-plugin'

/** Longest allowed plugin name — 64 is the inclusive upper edge (spec §5.5). */
export const MAX_NAME_LENGTH = 64

/**
 * §5.4 metadata that is correct in JSON type but invalid by content — freebuff
 * carries it without judging Semantic Versioning, URLs, or SPDX identifiers.
 */
export const CONTENT_INVALID_METADATA = {
  version: 'banana',
  description: 'A plugin that does nothing yet',
  homepage: 'not a url',
  repository: 'also not a url',
  license: 'nope',
}

/** The §5.4 author object, carrying every field §5.4 permits. */
export const AUTHOR = {
  name: 'Google LLC',
  email: 'author@example.com',
  url: 'https://cloud.google.com',
}

/** The same author plus a field §5.4 does not permit. */
export const AUTHOR_WITH_FOREIGN_FIELD = {
  name: 'Google LLC',
  twitter: '@google',
}

/** The same author with a name whose JSON type is wrong, not its content. */
export const AUTHOR_WITH_NON_STRING_NAME = { name: 42 }

/** An author of the wrong JSON type — §5.4 declares an object. */
export const NON_OBJECT_AUTHOR = 'Google LLC'

/** A §5.4 keywords list as the spec declares it. */
export const KEYWORDS = ['google-cloud', 'gcloud']

/** The same keywords list with one element that is not a string. */
export const KEYWORDS_WITH_NON_STRING_ENTRY = ['google-cloud', 7]

/** Manifest text that is not JSON at all (§5.2: the manifest MUST be JSON). */
export const NON_JSON_TEXT = 'this is not JSON'

/**
 * Manifest text that parses as JSON but whose top level is an array — the
 * non-object a `typeof` check alone would wave through (§5.2 requires an
 * object).
 */
export const TOP_LEVEL_ARRAY_JSON = '[]'

/**
 * Manifest text whose top level is a string primitive — rejected by the type
 * clause of the object rule (§5.2 requires an object).
 */
export const TOP_LEVEL_STRING_JSON = '"just a string"'

/**
 * Manifest text whose top level is null — JSON-valid, and the case `typeof`
 * alone reports as an object, so this row also pins that reading it cannot
 * crash.
 */
export const TOP_LEVEL_NULL_JSON = 'null'

/** A plugin root whose plugin.json holds exactly the given manifest text. */
export function makePluginRoot(manifestJson: string): string {
  const root = makeTempDir('freebuff-plugin-')
  writeFileSync(path.join(root, 'plugin.json'), manifestJson, 'utf8')
  return root
}

/** A plugin root that carries no plugin.json at all (§5.1). */
export function makeRootWithoutManifest(): string {
  return makeTempDir('freebuff-plugin-')
}

/**
 * A plugin root whose manifest carries the required fields plus the given
 * extras, so a test body states only the field it is about.
 */
export function makeManifestRoot(
  extraFields: Record<string, unknown> = {},
): string {
  return makePluginRoot(minimalManifestJson(extraFields))
}

/**
 * A plugin root whose `plugin.json` is a reparse point resolving to a valid
 * manifest outside the root — §4.1.1 rejects the plugin itself when its
 * manifest escapes.
 */
export function makeEscapingManifestRoot(): string {
  const root = makeTempDir('freebuff-plugin-')
  const outside = makeOutsideDir(root)
  writeFileSync(
    path.join(outside, 'plugin.json'),
    minimalManifestJson(),
    'utf8',
  )
  // The junction sits at plugin.json and resolves to the outside directory:
  // a junction pointing at a FILE is created but then dangles (every stat on
  // it throws ENOENT), so the manifest would be unreadable rather than
  // escaping — the fixture must make containment, not readability, fail.
  linkJunction(path.join(root, 'plugin.json'), outside)
  return root
}

/**
 * A plugin root reached through a reparse point, with its manifest inside the
 * resolved root — the arrangement §4.1.1 permits, and the one a check that
 * resolved only the manifest would reject. That is the everyday case on a
 * platform whose temp directory is itself a symlink.
 */
export function makeReparsePointRoot(): string {
  const target = makePluginRoot(minimalManifestJson())
  const root = path.join(makeTempDir('freebuff-plugin-link-'), 'root')
  linkJunction(root, target)
  return root
}

/** The §5.2 minimal manifest as JSON text, with the given fields added. */
function minimalManifestJson(
  extraFields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    $schema: CANONICAL_SCHEMA,
    name: MINIMAL_NAME,
    ...extraFields,
  })
}

/**
 * Asserts the load succeeded, failing with the loader's reason otherwise,
 * and returns the manifest so tests assert on plugin values, never on the
 * result's shape.
 *
 * Rejection rows use expectManifestRejected rather than negating this one:
 * a rejection is not the boolean complement of success — "not ok" also
 * covers a crash, which the loader never does — and the rejection helper
 * additionally asserts the reason blames the field under test.
 */
export function expectManifestOk(result: LoadManifestResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result
}

/**
 * Asserts the plugin does not exist (the fatal branch) and that the loader's
 * reason names the cause given by `blame` — a field for field rules, the
 * refused shape or manifest text for the §5.2 structural rules — so a
 * rejection for the wrong cause still fails the test. Returns the rejection,
 * so a row that also asserts on the reports it carries does not need its own
 * narrowing branch.
 */
export function expectManifestRejected(
  result: LoadManifestResult,
  blame: string,
): Extract<LoadManifestResult, { ok: false }> {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(`expected rejection blaming ${blame}, got ok`)
  expect(result.reason).toContain(blame)
  return result
}

/**
 * Asserts one report about `field` under `section` exists and returns it,
 * so a row claims the report's presence and adds field-specific claims
 * without reaching into report indices the spec never ordered.
 */
export function expectReportAbout(
  reports: PluginReport[],
  section: string,
  field: string,
): PluginReport {
  const report = reports.find(
    (candidate) =>
      candidate.section === section && candidate.message.includes(field),
  )
  expect(report).toBeDefined()
  if (!report)
    throw new Error(`expected a ${section} report naming ${field}, got none`)
  return report
}
