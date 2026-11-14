import { describe, expect, test } from 'bun:test'

import { appendTextToRootStream } from '../block-operations'

import type { ContentBlock, TextContentBlock } from '../../types/chat'

const stream = (text: string, chunkSize: number): ContentBlock[] => {
  let blocks: ContentBlock[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    blocks = appendTextToRootStream(blocks, {
      type: 'text',
      text: text.slice(i, i + chunkSize),
    })
  }
  return blocks
}

// thinkingId is a global counter, so compare everything else.
const shape = (blocks: ContentBlock[]) =>
  blocks.map((block) => {
    const { content, textType, thinkingOpen } = block as TextContentBlock
    return { type: block.type, content, textType, thinkingOpen }
  })

describe('appendTextToRootStream seam scan', () => {
  const corpus = [
    'plain text with no tags at all',
    'before<think>thought</think>after',
    '<think>a</think><think>b</think>c',
    'code: if (a < b && c > d) { return <Item value={a} /> }',
    'stray </think> close then more',
    'a <thinker> is not a tag, nor is </thin k>',
    `${'x'.repeat(5_000)}<think>late</think>tail`,
    '<think></think>',
    'open <think>never closed',
  ]

  test('chunked deltas produce the blocks of a single append', () => {
    for (const text of corpus) {
      const whole = shape(stream(text, text.length))
      for (const chunkSize of [1, 2, 3, 4, 5, 6, 7, 8, 9, 64]) {
        expect({ text, chunkSize, blocks: shape(stream(text, chunkSize)) })
          .toEqual({ text, chunkSize, blocks: whole })
      }
    }
  })

  test('a tag split at every position after a long block opens thinking', () => {
    const prefix = 'p'.repeat(50_000)
    for (let split = 1; split < '<think>'.length; split++) {
      let blocks = appendTextToRootStream([], {
        type: 'text',
        text: prefix + '<think>'.slice(0, split),
      })
      blocks = appendTextToRootStream(blocks, {
        type: 'text',
        text: '<think>'.slice(split) + 'body',
      })
      expect(shape(blocks)).toEqual([
        { type: 'text', content: prefix, textType: 'text', thinkingOpen: undefined },
        { type: 'text', content: 'body', textType: 'reasoning', thinkingOpen: true },
      ])
    }
  })

  test('a long reply full of less-than signs stays one text block', () => {
    const line = 'if (a < b) { return <Row key={i} /> }\n'
    const text = line.repeat(500)
    const blocks = stream(text, 13)
    expect(shape(blocks)).toEqual([
      { type: 'text', content: text, textType: 'text', thinkingOpen: undefined },
    ])
  })
})
