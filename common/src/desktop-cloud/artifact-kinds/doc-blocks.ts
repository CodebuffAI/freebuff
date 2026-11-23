/**
 * A stored doc's body as top-level blocks with their exact byte ranges, and block edits spliced
 * back over exactly those bytes. This is the server's copy of the doc view's splice
 * (freebuff/web/.../doc/doc-edit.ts `fileDocLayout` / `applyDocEdit`, for a body without a title
 * line): the same split (blank lines, fences kept whole, `\r\n` read as `\n`), so block `n` here is
 * the block the editor draws with `data-block-index="n"`, and every block an edit does not name
 * keeps its bytes, line endings included. A parity test in the doc view holds the two together.
 */

import type { DocBlockEdit } from './doc-tabs'

export type DocBlockRange = {
  /** Offsets into the raw body; `end` excludes a trailing `\r`. */
  start: number
  end: number
  /** The block's text with `\r\n` read as `\n`: what the editor draws and an edit's `before` names. */
  source: string
}

const normalize = (text: string) => text.replace(/\r\n?/g, '\n')

/** The body's top-level blocks, in order. */
export function docBodyLayout(body: string): DocBlockRange[] {
  const blocks: DocBlockRange[] = []
  let current: { start: number; end: number } | null = null
  let fenced = false
  let lineStart = 0
  const push = () => {
    if (current) blocks.push({ ...current, source: normalize(body.slice(current.start, current.end)) })
    current = null
  }
  while (lineStart <= body.length) {
    const newline = body.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? body.length : newline
    const line = body.slice(lineStart, lineEnd)
    if (line.trimStart().startsWith('```')) fenced = !fenced
    if (!fenced && line.trim() === '') push()
    else {
      const end = line.endsWith('\r') ? lineEnd - 1 : lineEnd
      if (current) current.end = end
      else current = { start: lineStart, end }
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  push()
  return blocks
}

/** The body's block sources (`docBodyLayout(body).map(source)`). */
export const docBodySources = (body: string) => docBodyLayout(body).map((block) => block.source)

/**
 * The body with one block edit applied (the `DocBlockEdit` of doc-tabs.ts: replace `span` blocks,
 * insert with `span: 0`, or move with `moveTo`), or null when `before` no longer matches.
 */
export function applyDocBodyEdit(body: string, edit: DocBlockEdit): string | null {
  const blocks = docBodyLayout(body)
  const crlf = body.includes('\r\n')
  const endings = (text: string) => (crlf ? text.replace(/\n/g, '\r\n') : text)
  const after = normalize(edit.after).replace(/^\n+|\n+$/g, '')
  const span = edit.span ?? 1
  if (span === 0) {
    if (edit.before !== '' || edit.index < 0 || edit.index > blocks.length) return null
    return after ? insertRaw(body, blocks, edit.index, endings(after), crlf) : body
  }
  const ranges = blocks.slice(edit.index, edit.index + span)
  if (edit.index < 0 || span < 1 || ranges.length !== span) return null
  if (ranges.map((range) => range.source).join('\n\n') !== edit.before) return null
  if (edit.moveTo !== undefined) {
    if (after !== edit.before) return null
    const to = Math.max(0, Math.min(blocks.length - span, edit.moveTo))
    if (to === edit.index) return body
    const bytes = body.slice(ranges[0].start, ranges[span - 1].end)
    const removed = removeRaw(body, blocks, edit.index, span)
    return insertRaw(removed, docBodyLayout(removed), to, bytes, crlf)
  }
  if (after === edit.before) return body
  const first = ranges[0]
  const last = ranges[span - 1]
  if (after) return body.slice(0, first.start) + endings(after) + body.slice(last.end)
  return removeRaw(body, blocks, edit.index, span)
}

function removeRaw(body: string, blocks: DocBlockRange[], index: number, span: number): string {
  const start = blocks[index].start
  const end = blocks[index + span - 1].end
  const previous = blocks[index - 1]
  const next = blocks[index + span]
  if (previous) return body.slice(0, previous.end) + body.slice(end)
  if (next) return body.slice(0, start) + body.slice(next.start)
  return body.slice(0, start) + body.slice(end)
}

function insertRaw(body: string, blocks: DocBlockRange[], index: number, text: string, crlf: boolean): string {
  const gap = crlf ? '\r\n\r\n' : '\n\n'
  if (index < blocks.length) {
    const at = blocks[index].start
    return body.slice(0, at) + text + gap + body.slice(at)
  }
  if (blocks.length) {
    const at = blocks[blocks.length - 1].end
    return body.slice(0, at) + gap + text + body.slice(at)
  }
  const bom = body.startsWith('﻿') ? '﻿' : ''
  return bom + text + (body.includes('\n') ? (crlf ? '\r\n' : '\n') : '')
}

/**
 * A short, stable fingerprint of a block's source (FNV-1a, base 36): what the agent's outline
 * shows beside each block and what a block op's `hash` guard compares, so an edit refuses when
 * the block changed since it was read.
 */
export function docBlockHash(source: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(-7)
}

export type DocBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'tasks'
  | 'quote'
  | 'callout'
  | 'table'
  | 'code'
  | 'chart'
  | 'image'
  | 'divider'
  | 'toc'
  | 'footnote'
  | 'tab'
  | 'pending'
  | 'meta'

/** What a block is, for the agent's outline. */
export function docBlockKind(source: string): DocBlockKind {
  const first = source.split('\n')[0] ?? ''
  if (/^ {0,3}\[\/\/\]:[ \t]*#[ \t]+["(]tab:/.test(first)) return 'tab'
  if (/^ {0,3}\[\/\/\]:[ \t]*#[ \t]+"toc"/.test(first)) return 'toc'
  if (/^ {0,3}\[\/\/\]:[ \t]*#[ \t]+"pending:/.test(first)) return 'pending'
  if (/^ {0,3}\[\/\/\]:/.test(first)) return 'meta'
  if (/^#{1,6}\s/.test(first)) return 'heading'
  if (/^\s*```\s*chart\s*$/.test(first)) return 'chart'
  if (/^\s*(```|~~~)/.test(first) || /^( {4}|\t)/.test(first)) return 'code'
  if (/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(first)) return 'callout'
  if (/^>/.test(first)) return 'quote'
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(source)) return 'divider'
  if (/^\[\^[^\]]+\]:/.test(first)) return 'footnote'
  if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(source)) return 'image'
  if (/^\s*([-*+]|\d+[.)])\s+\[[ xX]\]/.test(first)) return 'tasks'
  if (/^\s*([-*+]|\d+[.)])\s/.test(first)) return 'list'
  if (source.split('\n').some((line, index) => index > 0 && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-')) && first.includes('|'))
    return 'table'
  return 'paragraph'
}
