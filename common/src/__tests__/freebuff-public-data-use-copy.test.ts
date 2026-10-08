import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Whether this tree carries `path`. The public repository is an export of the
 * private source tree, and the export ships neither the web app (`web/`) nor
 * `landing-lab/`; a test that reads one of those paths is asserting against
 * files that were never here. Skipping by presence keeps the check running in
 * the private tree, where those files do exist, and reactivates it here by
 * itself if the export ever grows to include them.
 */
function isInThisTree(path: string): boolean {
  return existsSync(resolve(REPO_ROOT, path))
}

/**
 * Collapse CRLF (and any stray lone CR) to LF so a file's line endings cannot
 * decide whether its copy matches.
 *
 * The generated block is compared as text, but the committed files carry CRLF
 * and there is no `.gitattributes` pinning either style, so on a CRLF checkout
 * every line of the block differed from the LF-only renderer's output by a
 * single invisible `\r`. The failure diff showed zero changed lines and the
 * assertion still failed. Normalizing makes the test assert the copy it is
 * named for — the words — rather than whoever's line-ending convention last
 * touched the file.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function readRepoFile(path: string): string {
  return normalizeLineEndings(readFileSync(resolve(REPO_ROOT, path), 'utf8'))
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
      codebaseEvaluationNarrowedDate: 'September 25, 2026',
      lastUpdated: '10/01/2026',
      privacyPolicyLastUpdated: '10/01/2026',
    })
    expect(FREEBUFF_AI_TRAINING_NOTICE).toBe('May use data for AI training')
    expect(FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer).not.toContain(
      'Starting ',
    )
  })

  for (const [path, markers, copy] of [
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
  ] as const) {
    test.skipIf(!isInThisTree(path))(
      `${path} matches canonical generated copy`,
      () => {
        expect(generatedBlock(readRepoFile(path), markers)).toBe(copy)
      },
    )
  }

  const LANDING_FAQ = 'landing-lab/src/components/sections/Faq.tsx'

  test.skipIf(!isInThisTree(LANDING_FAQ))(
    'landing-lab uses the canonical data-use FAQ',
    () => {
      expect(readRepoFile(LANDING_FAQ)).toContain(
        `    q: '${FREEBUFF_PUBLIC_DATA_USE_COPY.storageQuestion}',
    a: '${FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer}',`,
      )
    },
  )

  test('line endings do not decide whether the copy matches', () => {
    // The regression guard for the reader above: a CRLF rendering of the block
    // is the same copy, and has to compare equal to the LF-only renderer's
    // output. Before the reader normalized, this was the README failure — a
    // diff with zero changed lines and one extra `\r` per line.
    const copy = renderFreebuffDataUseFaqMarkdown()
    expect(copy).not.toContain('\r')
    expect(normalizeLineEndings(copy.replace(/\n/g, '\r\n'))).toBe(copy)
    expect(normalizeLineEndings(copy)).toBe(copy)
  })
})
