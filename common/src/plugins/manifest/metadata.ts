import { isPlainObject } from '../json-value'

import type { PluginAuthor, PluginManifest } from './plugin-manifest'

/** The §5.4 metadata fields whose JSON type is a string, in spec order. */
const STRING_METADATA_FIELDS = [
  'version',
  'description',
  'homepage',
  'repository',
  'license',
] as const

/** One field name from the §5.4 string metadata table. */
type StringMetadataField = (typeof STRING_METADATA_FIELDS)[number]

/** The §5.4 author object fields, in spec order. */
const AUTHOR_FIELDS = ['name', 'email', 'url'] as const

/** One field name from the §5.4 author object. */
type AuthorField = (typeof AUTHOR_FIELDS)[number]

/** The metadata values a manifest carries, keyed as the manifest keys them. */
export type ManifestMetadata = Pick<
  PluginManifest,
  | 'version'
  | 'description'
  | 'author'
  | 'homepage'
  | 'repository'
  | 'license'
  | 'keywords'
>

/**
 * Reads every §5.4 metadata field the manifest carries: the strings, the
 * author object, and the keywords list.
 *
 * Values are taken as declared — their JSON type is checked, never their
 * content (§5.4) — so `version` is not judged as Semantic Versioning and
 * `homepage`, `repository`, `author.url`, `author.email`, and `license` are
 * not judged as URLs, addresses, or SPDX identifiers. The two fields §5.4
 * constrains structurally, `author` (closed to name, email, and url, each a
 * string) and `keywords` (a `string[]`), reject the manifest when they break
 * that structure, because §5.2 makes a permitted field that does not match
 * its declared type fatal.
 */
export function readMetadata(
  fields: Record<string, unknown>,
): { ok: true; values: ManifestMetadata } | { ok: false; reason: string } {
  const strings = readStringMetadata(fields)
  if (!strings.ok) return strings

  const author = readAuthor(fields.author)
  if (!author.ok) return author

  const keywords = readKeywords(fields.keywords)
  if (!keywords.ok) return keywords

  return {
    ok: true,
    values: {
      ...strings.values,
      ...(author.author && { author: author.author }),
      ...(keywords.keywords && { keywords: keywords.keywords }),
    },
  }
}

/**
 * Reads the §5.4 metadata strings the manifest carries. A field that is
 * present must be a string — metadata is validated by JSON type and nothing
 * else, so a value is never judged for Semantic Versioning, URL, or SPDX
 * validity. The offending field is found first, leaving the values to be
 * projected rather than accumulated in place.
 */
function readStringMetadata(
  fields: Record<string, unknown>,
):
  | { ok: true; values: Partial<Record<StringMetadataField, string>> }
  | { ok: false; reason: string } {
  const mistyped = STRING_METADATA_FIELDS.find(
    (field) => fields[field] !== undefined && typeof fields[field] !== 'string',
  )
  if (mistyped) {
    return { ok: false, reason: `manifest.${mistyped} must be a string (§5.4)` }
  }

  return {
    ok: true,
    values: STRING_METADATA_FIELDS.reduce<
      Partial<Record<StringMetadataField, string>>
    >(
      (values, field) =>
        typeof fields[field] === 'string'
          ? { ...values, [field]: fields[field] }
          : values,
      {},
    ),
  }
}

/**
 * Reads the §5.4 author object, the one metadata field §5.4 constrains
 * beyond JSON type: only name, email, and url, each a string. The first
 * entry that breaks either constraint decides the reason, so a rejection
 * blames the field the author wrote first, and the permitted values are
 * projected afterwards.
 */
function readAuthor(
  value: unknown,
): { ok: true; author?: PluginAuthor } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true }
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'manifest.author must be an object (§5.4)' }
  }

  const offending = Object.entries(value).find(
    ([field, entry]) => !isAuthorField(field) || typeof entry !== 'string',
  )
  if (offending) {
    const [field] = offending
    return {
      ok: false,
      reason: isAuthorField(field)
        ? `manifest.author.${field} must be a string (§5.4)`
        : `manifest.author has an unknown field "${field}" (§5.4)`,
    }
  }

  return {
    ok: true,
    author: AUTHOR_FIELDS.reduce<PluginAuthor>(
      (author, field) =>
        typeof value[field] === 'string'
          ? { ...author, [field]: value[field] }
          : author,
      {},
    ),
  }
}

/**
 * Reads the §5.4 keywords list. §5.4 declares it `string[]` and §5.2 makes a
 * permitted field that does not match its declared type fatal, so a
 * non-string element rejects the plugin — the permissive §5.4 sentence
 * forbids judging content, never types.
 */
function readKeywords(
  value: unknown,
): { ok: true; keywords?: string[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true }
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  ) {
    return {
      ok: false,
      reason: 'manifest.keywords must be an array of strings (§5.4)',
    }
  }
  return { ok: true, keywords: value }
}

/** True when `field` is one of the three names §5.4 permits in author. */
function isAuthorField(field: string): field is AuthorField {
  return AUTHOR_FIELDS.some((known) => known === field)
}
