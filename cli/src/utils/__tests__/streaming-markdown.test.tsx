import { describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { MarkdownBody } from '../../components/blocks/markdown-body'
import {
  hasIncompleteCodeFence,
  renderMarkdown,
  renderStreamingMarkdown,
} from '../markdown-renderer'
import {
  createStreamingMarkdownCache,
  renderStreamingMarkdownCached,
  renderStreamingMarkdownGroups,
} from '../streaming-markdown'

import type { MarkdownPalette } from '../markdown-renderer'
import type { ReactNode } from 'react'

const WIDTH = 72
const HEIGHT = 90

const renderFrame = async (node: ReactNode): Promise<string> => {
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  const root = createRoot(setup.renderer)
  try {
    flushSync(() =>
      root.render(
        <box flexDirection="column">
          <text>{node as React.ReactNode}</text>
        </box>,
      ),
    )
    await setup.renderOnce()
    return setup.captureCharFrame()
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
}

const DOC = `## Streaming equivalence

A paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com).

- first bullet with \`code\`
- second bullet
- third bullet

1. ordered one
2. ordered two

> a quoted line
> with two lines

| column a | column b |
| -------- | -------- |
| value 1  | value 2  |

\`\`\`ts
export const answer = 42
function add(a: number, b: number) {
  return a + b
}
\`\`\`

A closing paragraph that mentions a < b and 5 > 3 as plain text.
`

/** Every prefix that ends at a line boundary, i.e. where a flush could land. */
const prefixEnds = (text: string): number[] => {
  const ends: number[] = []
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\n') ends.push(i + 1)
  }
  return ends
}

describe('renderStreamingMarkdownCached', () => {
  test('matches a full render at every streaming step', async () => {
    const cache = createStreamingMarkdownCache()
    const options = { codeBlockWidth: 72 }

    for (const end of prefixEnds(DOC)) {
      const content = DOC.slice(0, end)
      const expected = await renderFrame(renderStreamingMarkdown(content, options))
      const actual = await renderFrame(
        renderStreamingMarkdownCached(content, options, cache),
      )

      // Guard against a vacuous pass: an empty or error frame would compare
      // equal to another empty frame.
      expect(expected).toContain('Streaming equivalence')
      expect({ at: end, frame: actual }).toEqual({ at: end, frame: expected })
    }
  })

  test('matches a full render inside an unterminated code fence', async () => {
    const cache = createStreamingMarkdownCache()
    const options = { codeBlockWidth: 72 }
    const open = `Intro text.\n\n\`\`\`ts\nconst a = 1\nconst b = 2\n`

    const expected = await renderFrame(renderStreamingMarkdown(open, options))
    const actual = await renderFrame(
      renderStreamingMarkdownCached(open, options, cache),
    )

    expect(expected).toContain('const a = 1')
    expect(actual).toEqual(expected)
  })

  test('a paragraph directly followed by a list keeps the same spacing', async () => {
    const cache = createStreamingMarkdownCache()
    const options = { codeBlockWidth: 72 }
    const content = `Intro line.\n\n- one\n- two\n\nAfter the list.\n`

    const expected = await renderFrame(renderStreamingMarkdown(content, options))
    const actual = await renderFrame(
      renderStreamingMarkdownCached(content, options, cache),
    )

    expect(expected).toContain('After the list.')
    expect(actual).toEqual(expected)
  })

  test('replaced content re-renders from scratch', async () => {
    const cache = createStreamingMarkdownCache()
    const options = { codeBlockWidth: 72 }

    renderStreamingMarkdownCached(DOC, options, cache)

    const replacement = `# A different message\n\nWith **its own** body.\n`
    const expected = await renderFrame(
      renderStreamingMarkdown(replacement, options),
    )
    const actual = await renderFrame(
      renderStreamingMarkdownCached(replacement, options, cache),
    )

    expect(expected).toContain('A different message')
    expect(actual).toEqual(expected)
  })

  test('a width change invalidates the cached prefix', async () => {
    const cache = createStreamingMarkdownCache()

    renderStreamingMarkdownCached(DOC, { codeBlockWidth: 72 }, cache)

    const expected = await renderFrame(
      renderStreamingMarkdown(DOC, { codeBlockWidth: 40 }),
    )
    const actual = await renderFrame(
      renderStreamingMarkdownCached(DOC, { codeBlockWidth: 40 }, cache),
    )

    expect(expected).toContain('Streaming equivalence')
    expect(actual).toEqual(expected)
  })
})

const PALETTE = { codeTextFg: 'white' } as unknown as MarkdownPalette

const renderBody = async (
  node: ReactNode,
  height = HEIGHT,
): Promise<string> => {
  const setup = await createTestRenderer({ width: WIDTH, height })
  const root = createRoot(setup.renderer)
  try {
    flushSync(() =>
      root.render(<box style={{ flexDirection: 'column', width: WIDTH }}>{node}</box>),
    )
    await setup.renderOnce()
    return setup.captureCharFrame()
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
}

/** Trailing spaces removed and blank-line runs collapsed to one blank line. */
const normalizeFrame = (frame: string): string =>
  frame
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

describe('one text per markdown block', () => {
  // Same blocks, same order, same wrapping. Blank-line runs are collapsed
  // before comparing: the single-text renderer draws two blank lines after a
  // blockquote, and per-block drawing normalises that to one.
  test('draws the same content as a single text renderable', async () => {
    const options = { codeBlockWidth: 60, palette: PALETTE }

    const single = await renderBody(
      <text style={{ wrapMode: 'word' }}>
        {renderMarkdown(DOC, options)}
      </text>,
    )
    const perBlock = await renderBody(
      <MarkdownBody
        content={DOC}
        isStreaming={false}
        codeBlockWidth={60}
        palette={PALETTE}
      />,
    )

    // Guard against a vacuous pass: an empty frame would match another empty
    // frame.
    expect(single).toContain('Streaming equivalence')
    expect(normalizeFrame(perBlock)).toEqual(normalizeFrame(single))
  })

  test('keeps sealed chunks by identity across a streaming flush', () => {
    // The flush cost stays proportional to the tail only if committed chunks
    // keep the same node array (and so the same text renderable).
    const cache = createStreamingMarkdownCache()
    const options = { codeBlockWidth: 60, palette: PALETTE }
    const paragraph = 'word '.repeat(200)
    const first = `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\nPar`

    const before = renderStreamingMarkdownGroups(first, options, cache)
    const after = renderStreamingMarkdownGroups(
      `${first}agraph grows.\n\nA new block.\n`,
      options,
      cache,
    )

    // Guard against a vacuous pass: one chunk would make the identity check
    // meaningless.
    expect(before.length).toBeGreaterThanOrEqual(2)
    expect(after.length).toBeGreaterThanOrEqual(2)
    // A sealed chunk survives unchanged; the chunk holding the tail is rebuilt.
    expect(after[0]).toBe(before[0])
    expect(after[after.length - 1]).not.toBe(before[before.length - 1])
  })
})

describe('a block larger than one chunk', () => {
  const fence = (lines: number): string =>
    '```ts\n' +
    Array.from({ length: lines }, (_, i) => `const v${i} = ${i}`).join('\n') +
    '\n```\n'

  test('a large code fence is drawn as several texts, unchanged', async () => {
    const doc = fence(400)
    const options = { codeBlockWidth: 60, palette: PALETTE }

    const single = await renderBody(
      <text style={{ wrapMode: 'word' }}>
        {renderMarkdown(doc, options)}
      </text>,
      440,
    )
    const perBlock = await renderBody(
      <MarkdownBody
        content={doc}
        isStreaming={false}
        codeBlockWidth={60}
        palette={PALETTE}
      />,
      440,
    )

    expect(single).toContain('const v399 = 399')
    expect(normalizeFrame(perBlock)).toEqual(normalizeFrame(single))
  })

  test('an open fence seals its complete lines as it grows', async () => {
    const cache = createStreamingMarkdownCache()
    const options = { codeBlockWidth: 60, palette: PALETTE }
    const open = `\`\`\`ts\n${Array.from(
      { length: 300 },
      (_, i) => `const v${i} = ${i}`,
    ).join('\n')}\n`

    const before = renderStreamingMarkdownGroups(open, options, cache)
    const after = renderStreamingMarkdownGroups(
      `${open}const last = 0\n`,
      options,
      cache,
    )

    // Sealed lines plus the tail still being written.
    expect(before.length).toBeGreaterThan(1)
    // A sealed chunk keeps its identity, so its text is not re-wrapped.
    expect(after[0]).toBe(before[0])

    // The chunk boundary must not draw a blank line: every code line follows
    // the previous one.
    const frame = await renderBody(
      <MarkdownBody
        content={open}
        isStreaming
        codeBlockWidth={60}
        palette={PALETTE}
      />,
      340,
    )
    const lines = frame
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const codeLines = lines.filter((line) => line.startsWith('const v'))
    expect(codeLines[0]).toBe('const v0 = 0')
    expect(codeLines[codeLines.length - 1]).toBe('const v299 = 299')
    // 300 code lines and the fence header, nothing else.
    expect(lines.length).toBe(301)
  })
})

describe('merged styled runs keep block boundaries', () => {
  // Regression: merging same-styled nodes must not swallow the blank line
  // between a code block and the paragraph that follows it.
  test('a paragraph after a code block starts on its own line', async () => {
    const doc = `\`\`\`ts
const a = 1
const b = 2
\`\`\`

After the block.
`
    const frame = await renderFrame(
      renderStreamingMarkdown(doc, { codeBlockWidth: 60 }),
    )
    const lines = frame.split('\n').map((line) => line.trimEnd())

    expect(lines).toContain('const b = 2')
    expect(lines).toContain('After the block.')
    expect(lines.some((line) => line.includes('const b = 2After'))).toBe(false)
  })

  test('code block lines stay on separate lines', async () => {
    const doc = `\`\`\`ts
const a = 1
const b = 2
const c = 3
\`\`\`
`
    const frame = await renderFrame(
      renderStreamingMarkdown(doc, { codeBlockWidth: 60 }),
    )
    const lines = frame.split('\n').map((line) => line.trimEnd())

    expect(lines).toContain('const a = 1')
    expect(lines).toContain('const b = 2')
    expect(lines).toContain('const c = 3')
  })
})

/**
 * A fence in the middle of a document used to invert the cached fence parity,
 * after which no boundary was accepted again: the prefix froze at the first
 * commit before an unclosed fence and every flush re-parsed the whole tail.
 * Rendering stayed correct, which is why the frame-equality tests above do not
 * catch it - only progress does. Asserted for both entry points.
 */
describe('the cache keeps advancing past code fences', () => {
  // The flush that used to freeze it: a chunk that ends INSIDE a fence, leaving
  // a commit before it. The stored parity then described the scanned end rather
  // than the committed prefix, the next scan counted the fence twice and
  // inverted, and every boundary after it was suppressed.
  const DOC =
    'Intro paragraph.\n\n\`\`\`ts\nconst a = 1\n\nconst b = 2\n\`\`\`\n\n' +
    'After the block.\n\nLast line with **bold** text.\n'
  const midFence = DOC.indexOf('const b = 2')
  const afterFence = DOC.indexOf('After the block.')

  test('groups path stores the parity of the committed prefix', () => {
    const cache = createStreamingMarkdownCache()
    renderStreamingMarkdownGroups(
      DOC.slice(0, midFence),
      { codeBlockWidth: 60 },
      cache,
    )
    // The invariant, not a length heuristic: the next scan resumes at
    // `cache.prefix`, so the stored parity must describe the prefix.
    expect({
      at: cache.prefix.length,
      fenceOpen: cache.fenceOpen,
    }).toEqual({
      at: cache.prefix.length,
      fenceOpen: hasIncompleteCodeFence(cache.prefix),
    })

    renderStreamingMarkdownGroups(DOC, { codeBlockWidth: 60 }, cache)
    expect(cache.fenceOpen).toBe(false)
    expect(cache.prefix.length).toBeGreaterThan(afterFence)
  })

  test('flat path stores the parity of the committed prefix', () => {
    const cache = createStreamingMarkdownCache()
    renderStreamingMarkdownCached(
      DOC.slice(0, midFence),
      { codeBlockWidth: 60 },
      cache,
    )
    expect({
      at: cache.prefix.length,
      fenceOpen: cache.fenceOpen,
    }).toEqual({
      at: cache.prefix.length,
      fenceOpen: hasIncompleteCodeFence(cache.prefix),
    })

    renderStreamingMarkdownCached(DOC, { codeBlockWidth: 60 }, cache)
    expect(cache.fenceOpen).toBe(false)
    expect(cache.prefix.length).toBeGreaterThan(afterFence)
  })
})
