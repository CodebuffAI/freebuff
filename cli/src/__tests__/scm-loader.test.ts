import { describe, expect, test } from 'bun:test'

import goQuery from '../../../packages/code-map/src/tree-sitter-queries/tree-sitter-go-tags.scm'

/**
 * Guards test/setup-scm-loader.ts (registered as a preload in
 * cli/bunfig.toml). Without it, importing any module that reaches
 * @codebuff/sdk — which re-exports code-map, which imports .scm
 * tree-sitter query files — dies at import time with "Unknown file type",
 * which bun reports as an unhandled error between tests rather than a
 * failure (see docs/testing.md). This file imports a .scm directly: if the
 * preload is missing or regresses, the whole file fails to load instead of
 * passing vacuously.
 */
describe('setup-scm-loader preload', () => {
  test('loads .scm imports as strings', () => {
    expect(typeof goQuery).toBe('string')
    expect(goQuery.length).toBeGreaterThan(0)
    // Tree-sitter queries capture nodes with @capture names; the go tags
    // query is nontrivial, so this also proves the content came through
    // intact rather than as an empty stub.
    expect(goQuery).toContain('@')
  })
})
