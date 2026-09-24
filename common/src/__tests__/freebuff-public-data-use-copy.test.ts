import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  FREEBUFF_AI_TRAINING_NOTICE,
  FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK,
  FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK,
  FREEBUFF_POLICY_METADATA,
  FREEBUFF_PUBLIC_DATA_USE_COPY,
  renderFreebuffDataUseFaqMarkdown,
  renderFreebuffDataUseFaqMdx,
} from '../constants/freebuff-data-use'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8')
}

function generatedBlock(
  source: string,
  markers: { start: string; end: string },
): string {
  const start = source.indexOf(markers.start)
  const end = source.indexOf(markers.end, start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return source.slice(start, end + markers.end.length)
}

describe('public Freebuff data-use copy', () => {
  test('the September 2 legal metadata stays aligned', () => {
    expect(FREEBUFF_POLICY_METADATA).toEqual({
      version: '2026-09-02',
      effectiveDate: 'September 2, 2026',
      lastUpdated: '09/02/2026',
      privacyPolicyLastUpdated: '09/24/2026',
    })
    expect(FREEBUFF_AI_TRAINING_NOTICE).toBe('May use data for AI training')
    expect(FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer).not.toContain(
      'Starting ',
    )
  })

  test.each([
    [
      'README.md',
      FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK,
      renderFreebuffDataUseFaqMarkdown(),
    ],
    [
      'freebuff/cli/release/README.md',
      FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK,
      renderFreebuffDataUseFaqMarkdown(),
    ],
    [
      'web/src/content/advanced/privacy.mdx',
      FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK,
      renderFreebuffDataUseFaqMdx(),
    ],
    [
      'web/src/content/help/faq.mdx',
      FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK,
      renderFreebuffDataUseFaqMdx(),
    ],
  ] as const)('%s matches canonical generated copy', (path, markers, copy) => {
    expect(generatedBlock(readRepoFile(path), markers)).toBe(copy)
  })

  test('landing-lab uses the canonical data-use FAQ', () => {
    expect(readRepoFile('landing-lab/src/components/sections/Faq.tsx'))
      .toContain(`    q: '${FREEBUFF_PUBLIC_DATA_USE_COPY.storageQuestion}',
    a: '${FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer}',`)
  })
})
