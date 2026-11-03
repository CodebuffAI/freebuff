import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { promptSuccess } from '@codebuff/common/util/error'
import { describe, expect, it } from 'bun:test'

import { processStreamWithTools } from '../tool-stream-parser'
import { createToolCallChunk } from './test-utils'

import type { StreamChunk } from '@codebuff/common/types/contracts/llm'

// The cloud agent drops the consolidated `text` event once its text was
// persisted as chunk rows. That is safe only while the event carries exactly
// the text already yielded as chunks, after them, and nothing else.
describe('the consolidated text event duplicates the yielded text chunks', () => {
  async function run(chunks: StreamChunk[]) {
    async function* stream() {
      for (const chunk of chunks) yield chunk
      return promptSuccess('id')
    }
    const order: Array<['chunk' | 'event', string]> = []
    const noop = { onTagStart: () => {}, onTagEnd: () => {} }
    for await (const chunk of processStreamWithTools({
      ...TEST_AGENT_RUNTIME_IMPL,
      stream: stream(),
      processors: { test_tool: noop },
      defaultProcessor: () => noop,
      onResponseChunk: (chunk) => {
        if (chunk.type === 'text') order.push(['event', chunk.text])
      },
      executeXmlToolCall: async () => {},
    })) {
      if (chunk.type === 'text') order.push(['chunk', chunk.text])
      if (chunk.type === 'tool-call') order.push(['chunk', `<${chunk.toolName}>`])
    }
    return order
  }

  it('repeats each text segment after its chunks, split at tool calls', async () => {
    const order = await run([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      createToolCallChunk('test_tool', {}),
      { type: 'text', text: 'Bye' },
    ])
    expect(order).toEqual([
      ['chunk', 'Hel'],
      ['chunk', 'lo'],
      ['event', 'Hello'],
      ['chunk', '<test_tool>'],
      ['chunk', 'Bye'],
      ['event', 'Bye'],
    ])
  })

  it('emits no text event when no text streamed', async () => {
    expect(await run([createToolCallChunk('test_tool', {})])).toEqual([
      ['chunk', '<test_tool>'],
    ])
  })
})
