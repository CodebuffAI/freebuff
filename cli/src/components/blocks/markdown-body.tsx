import { memo, useRef } from 'react'

import {
  hasMarkdown,
  renderMarkdownChunks,
  type MarkdownPalette,
} from '../../utils/markdown-renderer'
import {
  createStreamingMarkdownCache,
  renderStreamingMarkdownGroups,
} from '../../utils/streaming-markdown'

import type { StreamingMarkdownCache } from '../../utils/streaming-markdown'
import type { ReactNode } from 'react'

interface MarkdownTextGroupProps {
  nodes: ReactNode[]
  fg?: string
  attributes?: number
  wrapMode: 'word' | 'none'
}

/**
 * One chunk of markdown (a run of whole blocks) in its own text renderable.
 *
 * `nodes` is a stable array per chunk (see the streaming cache), so an
 * unchanged chunk bails out here instead of being re-wrapped.
 */
const MarkdownTextGroup = memo(function MarkdownTextGroup({
  nodes,
  fg,
  attributes,
  wrapMode,
}: MarkdownTextGroupProps) {
  return (
    <text style={{ wrapMode, fg }} attributes={attributes}>
      {nodes}
    </text>
  )
})

export interface MarkdownBodyProps {
  content: string
  isStreaming: boolean
  codeBlockWidth: number
  palette: MarkdownPalette
  /** Text colour of the surrounding message. */
  fg?: string
  attributes?: number
  wrapMode?: 'word' | 'none'
}

/**
 * Markdown body split into one `<text>` per ~2KB of rendered blocks.
 *
 * A message drawn as a single text renderable pays for its whole content
 * whenever any part of it changes, because the text buffer is rebuilt and
 * re-wrapped end to end - and mounting one re-wraps it once per appended node.
 * Giving each chunk its own buffer means a streaming flush only re-wraps the
 * chunk holding the tail. Measured with `scripts/render-bench.tsx`, against the
 * same DOM drawn as one text per message: a 6 x 60KB page mounts in 54ms
 * against 462ms, a 1KB flush into it costs 10ms against 187ms, and a 200KB
 * answer mounts in 32ms against 645ms.
 */
export const MarkdownBody = memo(function MarkdownBody({
  content,
  isStreaming,
  codeBlockWidth,
  palette,
  fg,
  attributes,
  wrapMode = 'word',
}: MarkdownBodyProps) {
  // Streaming text only ever grows, so blocks before the last boundary keep
  // both their parse and their renderables across flushes.
  const cache = useRef<StreamingMarkdownCache | null>(null)
  if (cache.current === null) {
    cache.current = createStreamingMarkdownCache()
  }

  if (!hasMarkdown(content)) {
    return (
      <text style={{ wrapMode, fg }} attributes={attributes}>
        {content}
      </text>
    )
  }

  const options = { codeBlockWidth, palette }
  const chunks = isStreaming
    ? renderStreamingMarkdownGroups(content, options, cache.current)
    : renderMarkdownChunks(content, options)

  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      {chunks.map((nodes, index) => (
        <MarkdownTextGroup
          key={index}
          nodes={nodes}
          fg={fg}
          attributes={attributes}
          wrapMode={wrapMode}
        />
      ))}
    </box>
  )
})
