import { describe, expect, test } from 'bun:test'

import {
  createStreamingMarkdownCache,
  renderStreamingMarkdown,
  renderStreamingMarkdownIncremental,
} from '../markdown-renderer'

const options = { codeBlockWidth: 60 }

/** Stream `doc` through one cache and compare every frame with a full render. */
const expectSameFramesAsFullRender = (doc: string, step = 1) => {
  const cache = createStreamingMarkdownCache()
  for (let end = 1; end <= doc.length; end += step) {
    const prefix = doc.slice(0, end)
    const incremental = renderStreamingMarkdownIncremental(prefix, options, cache)
    expect({ prefix, frame: incremental }).toEqual({
      prefix,
      frame: renderStreamingMarkdown(prefix, options),
    })
  }
}

const corpus: Record<string, string> = {
  paragraphs: 'First **bold** para.\n\nSecond with `code` and a [link](https://a.b).\n\nThird.\n',
  headingsAndRules: '# Title\n\nIntro.\n\n## Part\n\nBody\n\n---\n\nAfter the rule.\n\n***\n\nEnd.\n',
  nestedLists:
    'Steps:\n\n- one\n  - nested a\n  - nested b\n\n  continued item\n\n- two\n\n1. first\n2. second\n\n   still second\n\nAfter the lists.\n',
  backtickFence:
    'Before.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nBetween.\n\n```\nplain\n\n\nblock\n```\n\nAfter.\n',
  tildeFence: 'Before.\n\n~~~py\nx = 1\n\n```\nnot a close\n```\n\ny = 2\n~~~\n\nAfter.\n',
  longFence: 'Doc.\n\n````md\n```js\ninner\n\n```\n````\n\nAfter.\n',
  backtickInInfo: 'A.\n\n``` a`b\n\nB.\n',
  inlineTripleTicks: 'Use ```inline``` here.\n\nThen ``` alone in text.\n\nMore.\n\nEnd.\n',
  indentedCode: 'Para.\n\n    code line\n\n    more code\n\nAfter code.\n',
  blockquote: '> quoted\n> more\n\n> second quote\n\nPlain.\n\nPlain two.\n',
  table: 'Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter table.\n\nEnd.\n',
  setext: 'Heading\n=======\n\nText\n---\n\nPara.\n',
  crlf: 'One.\r\n\r\n```\r\ncode\r\n\r\nmore\r\n```\r\n\r\nTwo.\r\n\r\nThree.\r\n',
  definitions: 'See [the docs][d].\n\nMore text.\n\nLater.\n\n[d]: https://example.com\n',
  footnote: 'Claim[^1].\n\nMore.\n\n[^1]: Source.\n',
  htmlComment: 'A.\n\n<!-- note\n\nstill note -->\n\nB.\n',
  paragraphThenList: 'Para line\n- tight list\n\nNext para\n> tight quote\n\nEnd.\n',
}

describe('renderStreamingMarkdownIncremental', () => {
  for (const [name, doc] of Object.entries(corpus)) {
    test(`matches a full render at every prefix: ${name}`, () => {
      expectSameFramesAsFullRender(doc)
    })
  }

  test('matches a full render on a long mixed reply in coarse steps', () => {
    expectSameFramesAsFullRender(Object.values(corpus).join('\n').repeat(4), 37)
  })

  test('commits settled blocks instead of re-rendering them', () => {
    const cache = createStreamingMarkdownCache()
    const doc = Object.values(corpus)
      .filter((d) => !/\]:|<!--/.test(d))
      .join('\n')
    renderStreamingMarkdownIncremental(doc, options, cache)
    expect(cache.text.length).toBeGreaterThan(doc.length / 2)
    expect(cache.nonLocal).toBe(false)
  })

  test('starts over when the content is not an extension of the last frame', () => {
    const cache = createStreamingMarkdownCache()
    renderStreamingMarkdownIncremental('# A\n\nOne.\n\nTwo.\n', options, cache)
    const other = '# B\n\nOther.\n'
    expect(renderStreamingMarkdownIncremental(other, options, cache)).toEqual(
      renderStreamingMarkdown(other, options),
    )
  })
})
