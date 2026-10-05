import { afterEach, describe, expect, test } from 'bun:test'

import { loadManifest } from '../load-plugin-manifest'

import {
  AUTHOR,
  AUTHOR_WITH_FOREIGN_FIELD,
  AUTHOR_WITH_NON_STRING_NAME,
  CONTENT_INVALID_METADATA,
  expectManifestOk,
  expectManifestRejected,
  KEYWORDS,
  KEYWORDS_WITH_NON_STRING_ENTRY,
  makeManifestRoot,
  NON_OBJECT_AUTHOR,
} from './fixtures/manifest'
import { cleanUpPluginFixtures } from './fixtures/temp-roots'

afterEach(cleanUpPluginFixtures)

describe('metadata fields (spec §5.4)', () => {
  /**
   * Given a manifest whose metadata is correct in JSON type but invalid by
   * content, when loaded, the plugin loads, every value reaches the manifest
   * verbatim, and no report is emitted (§5.4 MUST NOT reject on the content
   * of version, homepage, repository, or license).
   */
  test('content-invalid metadata is carried verbatim, with no reports', () => {
    const root = makeManifestRoot(CONTENT_INVALID_METADATA)

    const result = loadManifest(root)

    const { manifest, reports } = expectManifestOk(result)
    expect(manifest).toMatchObject(CONTENT_INVALID_METADATA)
    expect(reports).toHaveLength(0)
  })

  /**
   * Given a manifest whose version is not a string, when loaded, the plugin
   * is rejected — metadata is validated by JSON type (§5.4), and a type
   * mismatch is fatal (§5.2).
   */
  test('a metadata field with the wrong JSON type is rejected', () => {
    const root = makeManifestRoot({ version: 42 })

    const result = loadManifest(root)

    expectManifestRejected(result, 'version')
  })

  /**
   * Given a manifest carrying the author object and the keywords list, when
   * loaded, both reach the manifest with the values the author wrote.
   */
  test('a valid author and keywords are carried verbatim', () => {
    const root = makeManifestRoot({ author: AUTHOR, keywords: KEYWORDS })

    const result = loadManifest(root)

    const { manifest } = expectManifestOk(result)
    expect(manifest.author).toEqual(AUTHOR)
    expect(manifest.keywords).toEqual(KEYWORDS)
  })

  /**
   * Given a manifest whose author carries a field outside name, email, and
   * url, when loaded, the plugin is rejected — §5.4 permits no other author
   * field.
   */
  test('an author field outside name, email, and url is rejected', () => {
    const root = makeManifestRoot({ author: AUTHOR_WITH_FOREIGN_FIELD })

    const result = loadManifest(root)

    expectManifestRejected(result, 'author')
  })

  /**
   * Given a manifest whose author carries a non-string value, when loaded,
   * the plugin is rejected — every author field holds a string (§5.4).
   */
  test('an author value that is not a string is rejected', () => {
    const root = makeManifestRoot({ author: AUTHOR_WITH_NON_STRING_NAME })

    const result = loadManifest(root)

    expectManifestRejected(result, 'author')
  })

  /**
   * Given a manifest whose author is not an object, when loaded, the plugin
   * is rejected — §5.4 declares author an object.
   */
  test('a non-object author is rejected', () => {
    const root = makeManifestRoot({ author: NON_OBJECT_AUTHOR })

    const result = loadManifest(root)

    expectManifestRejected(result, 'author')
  })

  /**
   * Given a manifest whose keywords list holds a non-string element, when
   * loaded, the plugin is rejected — §5.4 declares keywords a string[], and
   * §5.2 makes a field that does not match its declared type fatal.
   */
  test('keywords holding a non-string element is rejected', () => {
    const root = makeManifestRoot({
      keywords: KEYWORDS_WITH_NON_STRING_ENTRY,
    })

    const result = loadManifest(root)

    expectManifestRejected(result, 'keywords')
  })
})
