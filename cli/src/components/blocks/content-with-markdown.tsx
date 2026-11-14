import { memo, useRef } from 'react'

import {
  createStreamingMarkdownCache,
  renderMarkdown,
  renderStreamingMarkdownIncremental,
  hasMarkdown,
  type MarkdownPalette,
  type StreamingMarkdownCache,
} from '../../utils/markdown-renderer'

interface ContentWithMarkdownProps {
  content: string
  isStreaming: boolean
  codeBlockWidth: number
  palette: MarkdownPalette
}

export const ContentWithMarkdown = memo(
  ({
    content,
    isStreaming,
    codeBlockWidth,
    palette,
  }: ContentWithMarkdownProps) => {
    const streamCache = useRef<StreamingMarkdownCache | null>(null)
    if (!hasMarkdown(content)) {
      return content
    }
    const options = { codeBlockWidth, palette }
    if (isStreaming) {
      streamCache.current ??= createStreamingMarkdownCache()
      return renderStreamingMarkdownIncremental(
        content,
        options,
        streamCache.current,
      )
    }
    streamCache.current = null
    return renderMarkdown(content, options)
  },
)
