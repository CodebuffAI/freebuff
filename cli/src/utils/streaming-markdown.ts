import { Fragment, createElement, memo } from 'react'

import {
  finishChunk,
  hasIncompleteCodeFence,
  MARKDOWN_CHUNK_CHARS,
  renderedTextLength,
  renderMarkdownGroups,
  renderMarkdownNodes,
  splitNodesAtLineBreaks,
  trimTrailingWhitespace,
} from './markdown-renderer'

import type { MarkdownRenderOptions } from './markdown-renderer'
import type { ReactNode } from 'react'

/**
 * Incremental renderer for the block that is still streaming.
 *
 * `renderMarkdown` costs roughly 3ms per kilobyte, and the live message is
 * re-rendered on every flush while it grows - so a long answer re-parsed its
 * whole transcript about ten times a second: a 200KB answer cost ~480ms of
 * parsing per flush, on the render thread.
 *
 * Streaming text is append-only, so every complete block before the last
 * boundary can be parsed once and reused. Only the tail - the block currently
 * being written - is re-rendered per flush.
 *
 * Parsing is only half of it. A single text renderable re-wraps its whole
 * buffer whenever any part of it changes, so `renderStreamingMarkdownGroups`
 * also hands back one group per top-level block, for a caller that draws each
 * block as its own `<text>`: a 1KB flush into a 60KB answer measured 96ms as
 * one text and 9ms with one text per block.
 */

/** Rendered once per committed segment, for the single-text callers. */
const RenderedSegment = memo(function RenderedSegment({
  nodes,
}: {
  nodes: ReactNode[]
}) {
  return createElement(Fragment, null, ...nodes)
})

export type StreamingMarkdownCache = {
  /** Already parsed and reusable. `content` must start with this. */
  prefix: string
  /** Sealed chunks: runs of whole blocks, one `<text>` each. Stable arrays. */
  chunks: ReactNode[][]
  /** Blocks parsed after the last seal, plus the tail. Rebuilt per flush. */
  pending: ReactNode[][]
  /** Rendered characters in `pending`. */
  pendingChars: number
  /** Lines of an open code fence, sealed as they scroll past the target size. */
  literalChunks: ReactNode[][]
  /** The literal text those chunks were cut from, to check it only grew. */
  literalSource: string
  /** How much of the literal text is already sealed. */
  literalChars: number
  /** The same committed segments as one flat node list. */
  segmentElements: ReactNode[]
  /** How much of `prefix` `segmentElements` already holds. Only the slice past
   *  this is rendered on a commit: re-rendering the whole prefix made the flat
   *  path quadratic, which is what the cache exists to avoid. */
  flatPrefix: string
  /** How many segments have been committed; keys segment node keys apart. */
  segments: number
  /** Whether a fenced code block is still open at the end of `prefix`. */
  fenceOpen: boolean
  /** Options the nodes were rendered with; a change invalidates them. */
  codeBlockWidth: number
  palette: unknown
}

export const createStreamingMarkdownCache = (): StreamingMarkdownCache => ({
  prefix: '',
  chunks: [],
  pending: [],
  pendingChars: 0,
  literalChunks: [],
  literalSource: '',
  literalChars: 0,
  segmentElements: [],
  flatPrefix: '',
  segments: 0,
  fenceOpen: false,
  codeBlockWidth: -1,
  palette: undefined,
})

/** A blank line only separates blocks cleanly outside lists and quotes. */
const LIST_OR_QUOTE_LINE = /^[ \t]*(?:[-*+]|\d+[.)]|>)/

const previousLine = (content: string, index: number): string => {
  let start = index - 1
  while (start >= 0 && content[start] !== '\n') start--
  return content.slice(start + 1, index)
}

const nextLine = (content: string, index: number): string => {
  let start = index
  while (
    start < content.length &&
    (content[start] === '\n' || content[start] === ' ' || content[start] === '\t')
  ) {
    start++
  }
  let end = start
  while (end < content.length && content[end] !== '\n') end++
  return content.slice(start, end)
}

const isSafeBoundary = (content: string, blankIndex: number): boolean => {
  const next = nextLine(content, blankIndex)
  // Nothing rendered after the boundary yet: no stable content to commit.
  if (!next) return false

  // A list or blockquote can continue across a blank line (loose lists), and
  // parsing the halves separately would restart ordered numbering or split the
  // quote. Leave those boundaries to the tail. Excluding them also means the
  // last committed block is never a paragraph followed by a list, which is the
  // only case where the renderer's trailing separator depends on the sibling
  // on the other side of the boundary.
  const prev = previousLine(content, blankIndex)
  if (LIST_OR_QUOTE_LINE.test(prev) || LIST_OR_QUOTE_LINE.test(next)) {
    return false
  }

  return true
}

/**
 * Scans the unparsed part of `content` for the last safe block boundary and
 * commits everything before it to the cache. Returns the tail - the text still
 * being written - and whether it leaves a code fence open.
 */
const advance = (
  content: string,
  options: MarkdownRenderOptions,
  cache: StreamingMarkdownCache,
): { tail: string; fenceOpenAtTail: boolean } => {
  const codeBlockWidth = options.codeBlockWidth ?? 80

  if (
    codeBlockWidth !== cache.codeBlockWidth ||
    options.palette !== cache.palette ||
    !content.startsWith(cache.prefix)
  ) {
    cache.prefix = ''
    cache.chunks = []
    cache.pending = []
    cache.pendingChars = 0
    cache.literalChunks = []
    cache.literalSource = ''
    cache.literalChars = 0
    cache.segmentElements = []
    cache.flatPrefix = ''
    cache.segments = 0
    cache.fenceOpen = false
    cache.codeBlockWidth = codeBlockWidth
    cache.palette = options.palette
  }

  let fenceOpen = cache.fenceOpen
  let split = -1
  /**
   * Fence parity AT `split`, which is not the parity at the end of the scan.
   * A boundary is only taken outside a fence, but the fences between `split`
   * and the scanned end are counted again on the next flush (that scan resumes
   * at `split`), so storing the end parity inverted every later scan and
   * suppressed every later boundary: the cache froze at the first commit that
   * preceded an unclosed fence, and every flush then re-parsed the whole tail.
   */
  let fenceOpenAtSplit = fenceOpen

  for (let i = cache.prefix.length; i < content.length; i++) {
    if (content.charCodeAt(i) === 96 /* ` */ && content.startsWith('```', i)) {
      fenceOpen = !fenceOpen
      i += 2
      continue
    }
    if (
      !fenceOpen &&
      content.charCodeAt(i) === 10 /* \n */ &&
      content[i + 1] === '\n' &&
      isSafeBoundary(content, i)
    ) {
      split = i
      fenceOpenAtSplit = fenceOpen
      i += 1
    }
  }

  if (split > cache.prefix.length) {
    const segment = content.slice(cache.prefix.length, split)
    const key = `md-seg-${cache.segments++}`
    for (const group of renderMarkdownGroups(segment, options, `${key}-`)) {
      const oversized = renderedTextLength(group) > MARKDOWN_CHUNK_CHARS
      const pieces = oversized
        ? splitNodesAtLineBreaks(group, MARKDOWN_CHUNK_CHARS)
        : [group]
      for (const piece of pieces) {
        cache.pending.push(piece)
        cache.pendingChars += renderedTextLength(piece)
        if (cache.pendingChars >= MARKDOWN_CHUNK_CHARS) {
          // Seal a chunk: its node array then never changes, so its text
          // renderable is not re-wrapped by later flushes. Sealing inside the
          // loop matters when one commit carries a whole message - the first
          // render of a resumed answer is a single segment.
          cache.chunks.push(finishChunk(cache.pending.flat()))
          cache.pending = []
          cache.pendingChars = 0
        }
      }
    }
    // Whatever an open fence had collected is now part of a committed block.
    cache.literalChunks = []
    cache.literalSource = ''
    cache.literalChars = 0
    cache.prefix = content.slice(0, split)
    cache.fenceOpen = fenceOpenAtSplit
  }

  return { tail: content.slice(cache.prefix.length), fenceOpenAtTail: fenceOpen }
}

/**
 * Renders streaming markdown as runs of whole blocks, one `<text>` each.
 *
 * Produces the same rendering as `renderStreamingMarkdown` for content that
 * extends what was rendered before; falls back to a full parse when the
 * content is replaced (chat reload, edit) or has no safe boundary yet. Sealed
 * chunks keep their array identity across flushes, so only the chunk holding
 * the tail is re-wrapped.
 */
export function renderStreamingMarkdownGroups(
  content: string,
  options: MarkdownRenderOptions,
  cache: StreamingMarkdownCache,
): ReactNode[][] {
  const { tail } = advance(content, options, cache)
  const pending = [...cache.pending]
  let openFence: string | null = null

  if (tail && hasIncompleteCodeFence(tail)) {
    // Same split as renderStreamingMarkdown: rendered blocks, then the
    // unterminated fence as literal text so it is not half-highlighted.
    const lastFence = tail.lastIndexOf('```')
    pending.push(
      ...renderMarkdownGroups(tail.slice(0, lastFence), options, 'md-tail-'),
    )
    openFence = tail.slice(lastFence)
  } else if (tail) {
    pending.push(...renderMarkdownGroups(tail, options, 'md-tail-'))
  }

  const chunks = [...cache.chunks]
  if (pending.length > 0) {
    chunks.push(finishChunk(pending.flat()))
  }

  if (openFence !== null) {
    // An open fence is drawn as literal text, and it only ever grows, so its
    // complete lines can be sealed: a long code block then streams by adding
    // to its last chunk instead of re-rendering hundreds of lines.
    const { sealed, rest } = sealFenceLines(cache, openFence)
    if (sealed > 0) {
      chunks.push(...cache.literalChunks)
    }
    if (rest) {
      chunks.push([rest])
    }
  }

  // The document's trailing separator would draw a blank line below it.
  const last = chunks.length - 1
  if (last >= 0) {
    chunks[last] = trimTrailingWhitespace(chunks[last])
    if (chunks[last].length === 0) {
      chunks.pop()
    }
  }
  return chunks
}

/**
 * Seals whole lines of an open fence once it outgrows a chunk.
 *
 * Returns how many chunks are sealed and the unsealed remainder. A chunk ends
 * where a line already ends, and the newline itself is consumed by the chunk
 * boundary (two stacked texts are already on separate lines), so the rendered
 * lines stay contiguous.
 */
const sealFenceLines = (
  cache: StreamingMarkdownCache,
  literal: string,
): { sealed: number; rest: string } => {
  if (!literal.startsWith(cache.literalSource)) {
    cache.literalChunks = []
    cache.literalChars = 0
  }
  cache.literalSource = literal

  while (literal.length - cache.literalChars >= MARKDOWN_CHUNK_CHARS) {
    const cut = literal.indexOf('\n', cache.literalChars + MARKDOWN_CHUNK_CHARS)
    if (cut === -1) break
    cache.literalChunks.push([literal.slice(cache.literalChars, cut)])
    cache.literalChars = cut + 1
  }

  return {
    sealed: cache.literalChunks.length,
    rest: literal.slice(cache.literalChars),
  }
}

/**
 * The same incremental render as one flat node list, for callers that draw
 * markdown inside an existing text run and so cannot own the renderables.
 */
export function renderStreamingMarkdownCached(
  content: string,
  options: MarkdownRenderOptions,
  cache: StreamingMarkdownCache,
): ReactNode {
  const { tail } = advance(content, options, cache)

  // Only the newly committed slice is parsed. Rendering the whole prefix here
  // was O(prefix) per commit - quadratic over an answer, and once the fence
  // parity fix let the prefix advance it was the entire cost of this path.
  if (cache.flatPrefix.length !== cache.prefix.length) {
    const segmentStart = cache.flatPrefix.length
    const segment = cache.prefix.slice(segmentStart)
    cache.flatPrefix = cache.prefix
    const nodes = trimTrailingWhitespace(
      // `segmentStart` makes the key prefix unique per commit: a fixed prefix
      // restarts node numbering in every segment and duplicates React keys.
      renderMarkdownNodes(segment, options, `md-flat-${segmentStart}-`),
    )
    if (nodes.length > 0) {
      const wrapped = createElement(RenderedSegment, { nodes })
      cache.segmentElements = cache.segmentElements.length
        ? [...cache.segmentElements, wrapped, '\n\n']
        : [wrapped, '\n\n']
    }
  }

  if (tail && hasIncompleteCodeFence(tail)) {
    // Same split as renderStreamingMarkdown: rendered blocks, then the
    // unterminated fence as literal text so it is not half-highlighted. That
    // function trims the trailing separator before appending the literal text
    // (so the pending fence continues the previous line); trimming here too
    // keeps the stitched output identical.
    const lastFence = tail.lastIndexOf('```')
    const trimmedBefore = trimTrailingWhitespace([
      ...cache.segmentElements,
      ...renderMarkdownNodes(tail.slice(0, lastFence), options, 'md-tail-'),
    ])
    return createElement(
      Fragment,
      null,
      ...trimmedBefore,
      tail.slice(lastFence),
    )
  }

  const tailNodes = tail
    ? renderMarkdownNodes(tail, options, 'md-tail-')
    : []
  const trimmed = trimTrailingWhitespace([...cache.segmentElements, ...tailNodes])
  if (trimmed.length === 0) {
    return ''
  }
  if (trimmed.length === 1) {
    return trimmed[0]
  }
  return createElement(Fragment, null, ...trimmed)
}
