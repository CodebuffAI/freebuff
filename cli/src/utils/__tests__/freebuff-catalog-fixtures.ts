import { freebuffLegacyModelDigest } from '@codebuff/common/types/freebuff-model-catalog'

import type {
  FreebuffCatalogRow,
  FreebuffModelCatalog,
} from '@codebuff/common/types/freebuff-model-catalog'

/** A catalog row with sensible defaults; `legacyIds` become its digests. */
export function catalogRow(
  key: string,
  overrides: Partial<FreebuffCatalogRow> & { legacyIds?: string[] } = {},
): FreebuffCatalogRow {
  const { legacyIds, ...rest } = overrides
  return {
    key,
    handle: `fbm1.${key}-h1`,
    displayName: `Model ${key}`,
    tagline: `Tagline ${key}`,
    badges: [],
    multimodal: false,
    premium: false,
    dataUse: 'service',
    access: 'open',
    sortOrder: 10,
    ...(legacyIds
      ? { legacyDigests: legacyIds.map(freebuffLegacyModelDigest) }
      : {}),
    ...rest,
  }
}

export function catalogFixture(
  rows: FreebuffCatalogRow[],
  overrides: Partial<FreebuffModelCatalog> = {},
): FreebuffModelCatalog {
  return {
    protocol: 1,
    version: 'v1',
    issuedAt: 1_000_000,
    refreshAt: 1_000_000 + 30 * 60_000,
    rows,
    recommendedKey: rows[0]?.key,
    fallbackKey: rows[rows.length - 1]?.key,
    plansUrl: 'https://freebuff.com/plans?from=catalog',
    ...overrides,
  }
}

/** Every catalog handle in a catalog, by key, re-minted as `-h<n>`. */
export function rotateHandles(
  catalog: FreebuffModelCatalog,
  generation: number,
): FreebuffModelCatalog {
  return {
    ...catalog,
    rows: catalog.rows.map((row) => ({
      ...row,
      handle: `fbm1.${row.key}-h${generation}`,
    })),
  }
}
