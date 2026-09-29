import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, test } from 'bun:test'

import {
  findWithheldSources,
  parseExportManifest,
} from '../../scripts/bundle-source-guard'

const manifest = parseExportManifest(`
# comment
common
packages/agent-runtime
sdk

!common/src/constants/freebuff-trust.ts
!common/src/secret-dir
!**/knowledge.md
!**/*.tsbuildinfo
`)

describe('findWithheldSources', () => {
  test('public workspace sources and node_modules pass', () => {
    expect(
      findWithheldSources(
        [
          'common/src/constants/agents.ts',
          'packages/agent-runtime/src/run.ts',
          'sdk/src/index.ts',
          'node_modules/lodash/lodash.js',
          'packages/internal/node_modules/zod/index.js',
        ],
        manifest,
      ),
    ).toEqual([])
  })

  test('an excluded file, an excluded directory and a glob exclusion are withheld', () => {
    expect(
      findWithheldSources(
        [
          'common/src/constants/freebuff-trust.ts',
          'common/src/secret-dir/a.ts',
          'common/src/knowledge.md',
          'common/x.tsbuildinfo',
        ],
        manifest,
      ),
    ).toEqual([
      'common/src/constants/freebuff-trust.ts',
      'common/src/secret-dir/a.ts',
      'common/src/knowledge.md',
      'common/x.tsbuildinfo',
    ])
  })

  test('a workspace package outside the export is withheld', () => {
    expect(
      findWithheldSources(
        ['packages/internal/src/env.ts', 'web/src/x.ts'],
        manifest,
      ),
    ).toEqual(['packages/internal/src/env.ts', 'web/src/x.ts'])
  })

  test('prefixes match whole path segments only', () => {
    expect(
      findWithheldSources(
        ['common-private/src/x.ts', 'common/src/secret-dir-public/a.ts'],
        manifest,
      ),
    ).toEqual(['common-private/src/x.ts'])
  })

  test('the real manifest withholds the files the leak check forbids', () => {
    const real = parseExportManifest(
      readFileSync(
        join(
          import.meta.dir,
          '..',
          '..',
          '..',
          'scripts',
          'public-export-manifest.txt',
        ),
        'utf8',
      ),
    )
    expect(
      findWithheldSources(
        [
          'common/src/constants/freebuff-trust.ts',
          'common/src/constants/foreign-client-signals.ts',
          'common/src/constants/freebuff-freebucks.ts',
          'freebuff/web/src/server/x.ts',
          'common/src/constants/agents.ts',
        ],
        real,
      ),
    ).toEqual([
      'common/src/constants/freebuff-trust.ts',
      'common/src/constants/foreign-client-signals.ts',
      'common/src/constants/freebuff-freebucks.ts',
      'freebuff/web/src/server/x.ts',
    ])
  })
})
