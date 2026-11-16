/**
 * What "Read aloud" says for a Freebuff artifact: a reading outline per kind, as plain
 * speakable sentences (no Markdown, no ids, no JSON). Pure and DOM-free; it never throws, and a
 * body it cannot read gives no sentences.
 *
 *   doc         the selected tab's Markdown (else every tab): headings, paragraphs, list items,
 *               quotes and table rows. Code fences, charts, images, tab markers, pending blocks
 *               and the suggestions sidecar are skipped.
 *   slides      per slide "Slide N. <title>.", then its subtitle, body, columns, the text of its
 *               free elements, and its speaker notes. `slideId` reads one slide.
 *   sheet       `range` (with `tabId`, or a `Tab!A1:C5` range) row by row; else the first tab's
 *               header row and the first five rows under it, each value paired with its header.
 *   data        the title, subtitle, then each block: KPIs as "<label>: <value>", sections,
 *               text, and chart and table titles. `blockId` reads one block.
 *   whiteboard  sections and loose notes/shapes/text/link titles in rows top-to-bottom, each row
 *               left-to-right; each section followed by the elements whose centre lies inside it.
 *   design      per board its title and then its text (and button labels) in tree order;
 *               component instances read as the main they draw. `boardId` reads one board.
 *
 * Every sentence is short enough for the browser's speech engines, which cut off or stall on
 * very long utterances: a long sentence is broken at a comma or a space.
 */

import type { ArtifactKind } from './artifacts'
import { isInstance, resolveInstance } from './artifact-kinds/design-components'
import { collectMains, validateDesign, type DesignNode, type FrameNode } from './artifact-kinds/design'
import { docBlockKind } from './artifact-kinds/doc-blocks'
import { splitDocSuggestions } from './artifact-kinds/doc-suggestions'
import { docTabs, splitBlocks } from './artifact-kinds/doc-tabs'
import { materializeDashboard } from './artifact-kinds/data-calc'
import { defaultFilterState, formatValue as formatDataValue, kpiResult } from './artifact-kinds/data-compute'
import { parseDashboard } from './artifact-kinds/data'
import { colName, parseAddress, parseSheetRange, type CellRect } from './artifact-kinds/sheet-address'
import { formatValue as formatSheetValue } from './artifact-kinds/sheet-format'
import { SheetEngine, literalValue, type CellValue } from './artifact-kinds/sheet-formula'
import { parseWorkbook, tabCols, tabRows, type SheetTab, type Workbook } from './artifact-kinds/sheet'
import { elementHasText } from './artifact-kinds/slides-elements'
import { parseDeck } from './artifact-kinds/slides'
import { LINE_HEIGHT, TEXT_SIZE_PX, parseBoard, type WhiteboardElement } from './artifact-kinds/whiteboard'

/** What part of the artifact to read; every field is optional and kind-specific. */
export type ArtifactSpeechSelection = {
  /** doc: the tab id (`docTabs`); sheet: the tab id (or name). */
  tabId?: string
  /** sheet: `A1:C5` or `B2` (on `tabId` or the first tab), or `Tab!A1:C5`. */
  range?: string
  /** slides: read only this slide. */
  slideId?: string
  /** data: read only this block. */
  blockId?: string
  /** design: read only this board. */
  boardId?: string
}

export type ArtifactSpeech = {
  title?: string
  /** One utterance each, in reading order. */
  sentences: string[]
  /** The sentences joined by a space. */
  text: string
}

/** Longest sentence handed to a speech engine before it is broken up. */
export const MAX_SPEECH_SENTENCE = 240
/** At most this many sentences are produced for one artifact. */
export const MAX_SPEECH_SENTENCES = 2000

const SHEET_DEFAULT_ROWS = 5
const SHEET_MAX_ROWS = 200
const SHEET_MAX_COLS = 40

const empty = (): ArtifactSpeech => ({ sentences: [], text: '' })

export function artifactSpeechText(kind: ArtifactKind, body: string, selection?: ArtifactSpeechSelection): ArtifactSpeech {
  try {
    if (typeof body !== 'string' || !body.trim()) return empty()
    const outline = outlineFor(kind, body, selection ?? {})
    if (!outline) return empty()
    const sentences = outline.segments
      .flatMap(splitSpeechSentences)
      .map(endSentence)
      .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
      .slice(0, MAX_SPEECH_SENTENCES)
    const title = outline.title?.trim() ? clean(outline.title) : undefined
    return { ...(title ? { title } : {}), sentences, text: sentences.join(' ') }
  } catch {
    return empty()
  }
}

type Outline = { title?: string; segments: string[] }

function outlineFor(kind: ArtifactKind, body: string, selection: ArtifactSpeechSelection): Outline | null {
  switch (kind) {
    case 'doc':
      return docOutline(body, selection)
    case 'slides':
      return slidesOutline(body, selection)
    case 'sheet':
      return sheetOutline(body, selection)
    case 'data':
      return dataOutline(body, selection)
    case 'whiteboard':
      return whiteboardOutline(body)
    case 'design':
      return designOutline(body, selection)
    default:
      return null
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

// ---- Sentences

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'st', 'fig', 'approx', 'inc', 'ltd', 'jr', 'sr', 'cf'])

/**
 * Text split into sentences for one utterance each: at a sentence end (. ! ? …) followed by a
 * space, and at line breaks. Abbreviations (e.g., vs.), initials (U.S.) and decimals (3.5) do
 * not end a sentence. A sentence longer than `MAX_SPEECH_SENTENCE` is broken at a comma, a
 * semicolon or a space. Whitespace is collapsed; empty pieces are dropped.
 */
export function splitSpeechSentences(text: string): string[] {
  const out: string[] = []
  if (typeof text !== 'string') return out
  for (const line of text.split(/\n+/)) {
    const flat = line.replace(/\s+/g, ' ').trim()
    if (!flat) continue
    const end = /[.!?…]+["'”’)\]]*(?=\s|$)/g
    let start = 0
    let match: RegExpExecArray | null
    while ((match = end.exec(flat))) {
      const stop = match.index + match[0].length
      if (match[0].startsWith('.') && match[0].length === 1) {
        const word = /([\p{L}.]+)$/u.exec(flat.slice(start, match.index))?.[1]?.toLowerCase() ?? ''
        if (ABBREVIATIONS.has(word) || /^\p{L}(\.\p{L})+$/u.test(word)) continue
      }
      pushChunked(out, flat.slice(start, stop))
      start = stop
    }
    pushChunked(out, flat.slice(start))
  }
  return out
}

function pushChunked(out: string[], piece: string): void {
  let rest = piece.trim()
  while (rest.length > MAX_SPEECH_SENTENCE) {
    const window = rest.slice(0, MAX_SPEECH_SENTENCE)
    const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '))
    const cut = soft > MAX_SPEECH_SENTENCE / 3 ? soft + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : MAX_SPEECH_SENTENCE
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
}

/** A sentence with closing punctuation, so the engine pauses after it. */
function endSentence(sentence: string): string {
  return /[.!?…:;]["'”’)\]]*$/.test(sentence) ? sentence : `${sentence}.`
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim()

// ---- Markdown to speakable text

/** Inline Markdown reduced to the words a reader sees. */
export function speakableInline(text: string): string {
  return clean(
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*]*?\S)\*(?![\p{L}\p{N}])/gu, '$1$2')
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}])/gu, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/==(?=\S)([\s\S]*?\S)==/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1'),
  )
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/

/** One top-level Markdown block as speakable segments; nothing for blocks a listener skips. */
function blockSegments(block: string): string[] {
  const kind = docBlockKind(block)
  switch (kind) {
    case 'code':
    case 'chart':
    case 'image':
    case 'divider':
    case 'toc':
    case 'tab':
    case 'pending':
    case 'meta':
      return []
    case 'heading':
      return [speakableInline(block.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, ''))]
    case 'list':
    case 'tasks': {
      const items: string[] = []
      for (const line of block.split('\n')) {
        if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, ''))
        else if (items.length) items[items.length - 1] += ` ${line.trim()}`
        else items.push(line)
      }
      return items.map(speakableInline)
    }
    case 'quote':
    case 'callout': {
      const lines = block.split('\n').map((line) => line.replace(/^\s*>\s?/, ''))
      const text = lines
        .join('\n')
        .replace(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, (_m, word: string) => `${word[0]}${word.slice(1).toLowerCase()}:`)
      return paragraphSegments(text)
    }
    case 'table': {
      const rows = block
        .split('\n')
        .filter((line) => !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line))
        .map((line) =>
          line
            .replace(/^\s*\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map((cell) => speakableInline(cell))
            .filter(Boolean)
            .join(', '),
        )
      return rows.filter(Boolean)
    }
    case 'footnote':
      return paragraphSegments(block.replace(/^\[\^[^\]]+\]:\s*/, ''))
    default:
      return paragraphSegments(block)
  }
}

/** A paragraph: soft line breaks join, so a wrapped sentence stays one sentence. */
function paragraphSegments(text: string): string[] {
  const joined = speakableInline(text.split('\n').map((line) => line.trim()).join(' '))
  return joined ? [joined] : []
}

/** Markdown (a doc tab, a slide body, a text block) as speakable segments. */
export function markdownSpeechSegments(markdown: string): string[] {
  return splitBlocks(markdown).flatMap(blockSegments)
}

// ---- doc

function docOutline(body: string, selection: ArtifactSpeechSelection): Outline {
  const { content } = splitDocSuggestions(body)
  const blocks = splitBlocks(content)
  const tabs = docTabs(blocks)
  const tab = selection.tabId ? tabs.find((t) => t.id === selection.tabId) : undefined
  const chosen = tab ? blocks.slice(tab.start, tab.end) : blocks
  const heading = chosen.find((block) => /^#\s/.test(block))
  return {
    title: heading ? speakableInline(heading.replace(/^#\s+/, '')) : undefined,
    segments: chosen.flatMap(blockSegments),
  }
}

// ---- slides

function slidesOutline(body: string, selection: ArtifactSpeechSelection): Outline | null {
  const parsed = parseDeck(parseJson(body))
  if (!parsed.ok) return null
  const deck = parsed.deck
  const segments: string[] = []
  deck.slides.forEach((slide, index) => {
    if (selection.slideId && slide.id !== selection.slideId) return
    const title = slide.title ? clean(slide.title) : ''
    segments.push(title ? `Slide ${index + 1}. ${endSentence(title)}` : `Slide ${index + 1}.`)
    if (slide.subtitle) segments.push(clean(slide.subtitle))
    if (slide.body) segments.push(...markdownSpeechSegments(slide.body))
    for (const column of slide.columns ?? []) segments.push(...markdownSpeechSegments(column))
    if (slide.chart?.title) segments.push(`Chart: ${clean(slide.chart.title)}`)
    for (const element of slide.elements ?? []) {
      if (elementHasText(element) && element.text?.trim()) segments.push(element.text)
    }
    if (slide.notes?.trim()) segments.push('Speaker notes.', slide.notes)
  })
  return { title: deck.title, segments }
}

// ---- sheet

function sheetOutline(body: string, selection: ArtifactSpeechSelection): Outline | null {
  const parsed = parseWorkbook(parseJson(body))
  if (!parsed.ok) return null
  const workbook = parsed.workbook
  let tab: SheetTab | undefined = selection.tabId
    ? workbook.tabs.find((t) => t.id === selection.tabId || t.name.toLowerCase() === selection.tabId?.toLowerCase())
    : undefined
  let rect: CellRect | null = null
  if (selection.range) {
    const bang = selection.range.lastIndexOf('!')
    const source = bang === -1 ? selection.range.toUpperCase() : `${selection.range.slice(0, bang + 1)}${selection.range.slice(bang + 1).toUpperCase()}`
    const range = parseSheetRange(source.replace(/\$/g, '').trim())
    if (range) {
      rect = range.rect
      if (range.tab) tab = workbook.tabs.find((t) => t.name.toLowerCase() === range.tab?.toLowerCase()) ?? tab
    }
  }
  tab ??= workbook.tabs[0]
  if (!tab) return null
  const read = cellReader(workbook, tab)
  const segments: string[] = []
  if (workbook.tabs.length > 1) segments.push(`${tab.name}.`)

  if (rect) {
    const bottom = Math.min(rect.bottom, tabRows(tab) - 1, rect.top + SHEET_MAX_ROWS - 1)
    const right = Math.min(rect.right, tabCols(tab) - 1, rect.left + SHEET_MAX_COLS - 1)
    if (rect.top === rect.bottom && rect.left === rect.right) {
      const text = read(rect.top, rect.left)
      segments.push(`${colName(rect.left)}${rect.top + 1}: ${text || 'empty'}`)
    } else {
      for (let row = rect.top; row <= bottom; row += 1) {
        const values: string[] = []
        for (let col = rect.left; col <= right; col += 1) {
          const text = read(row, col)
          if (text) values.push(text)
        }
        if (values.length) segments.push(`Row ${row + 1}: ${values.join(', ')}`)
      }
    }
    return { title: workbook.title, segments }
  }

  // No range: the header row (the first row holding anything) and the five rows under it.
  const used = usedBounds(tab)
  if (!used) return { title: workbook.title, segments }
  const right = Math.min(used.right, used.left + SHEET_MAX_COLS - 1)
  const headers: string[] = []
  for (let col = used.left; col <= right; col += 1) headers.push(read(used.top, col))
  const named = headers.filter(Boolean)
  if (named.length) segments.push(`Columns: ${named.join(', ')}`)
  let taken = 0
  for (let row = used.top + 1; row <= used.bottom && taken < SHEET_DEFAULT_ROWS; row += 1) {
    const pairs: string[] = []
    for (let col = used.left; col <= right; col += 1) {
      const text = read(row, col)
      if (!text) continue
      const header = headers[col - used.left]
      pairs.push(header ? `${header}: ${text}` : text)
    }
    if (!pairs.length) continue
    taken += 1
    segments.push(`Row ${row + 1}. ${pairs.join(', ')}`)
  }
  return { title: workbook.title, segments }
}

/** The cells' text as the page shows it: formulas computed, values formatted. */
function cellReader(workbook: Workbook, tab: SheetTab): (row: number, col: number) => string {
  let engine: SheetEngine | null = null
  try {
    engine = SheetEngine.build(workbook)
  } catch {
    engine = null
  }
  return (row, col) => {
    const cell = tab.cells[`${colName(col)}${row + 1}`]
    let value: CellValue
    try {
      value = engine ? engine.value(tab.id, row, col) : literalValue(cell)
    } catch {
      value = literalValue(cell)
    }
    try {
      return clean(
        formatSheetValue(value, cell?.fmt, {
          decimals: cell?.decimals,
          dateStyle: cell?.dateStyle,
          currency: cell?.currency,
          locale: workbook.locale,
        }),
      )
    } catch {
      return typeof value === 'string' || typeof value === 'number' ? clean(String(value)) : ''
    }
  }
}

function usedBounds(tab: SheetTab): CellRect | null {
  let rect: CellRect | null = null
  for (const [address, cell] of Object.entries(tab.cells)) {
    if (cell.v === undefined && cell.f === undefined) continue
    const pos = parseAddress(address)
    if (!pos) continue
    rect = rect
      ? {
          top: Math.min(rect.top, pos.row),
          left: Math.min(rect.left, pos.col),
          bottom: Math.max(rect.bottom, pos.row),
          right: Math.max(rect.right, pos.col),
        }
      : { top: pos.row, left: pos.col, bottom: pos.row, right: pos.col }
  }
  return rect
}

// ---- data

function dataOutline(body: string, selection: ArtifactSpeechSelection): Outline | null {
  const parsed = parseDashboard(parseJson(body))
  if (!parsed.ok) return null
  const dashboard = materializeDashboard(parsed.dashboard)
  const state = defaultFilterState(dashboard)
  const segments: string[] = []
  if (!selection.blockId) {
    segments.push(dashboard.title)
    if (dashboard.subtitle) segments.push(dashboard.subtitle)
  }
  for (const block of dashboard.blocks) {
    if (selection.blockId && block.id !== selection.blockId) continue
    switch (block.kind) {
      case 'kpi': {
        let spoken = 'no data'
        let delta = ''
        try {
          const result = kpiResult(dashboard, block, state)
          if (result.value !== null) spoken = formatDataValue(result.value, block.format, dashboard.currency)
          if (result.delta) delta = ` (${[result.delta.text, result.delta.label].filter(Boolean).join(' ')})`
        } catch {
          spoken = 'no data'
        }
        segments.push(`${clean(block.label)}: ${spoken}${delta}`)
        if (block.note) segments.push(block.note)
        break
      }
      case 'section':
        segments.push(block.title)
        if (block.description) segments.push(block.description)
        break
      case 'text':
        segments.push(...markdownSpeechSegments(block.markdown))
        break
      case 'chart':
        segments.push(`Chart: ${clean(block.title)}`)
        if (block.note) segments.push(block.note)
        break
      case 'table':
        segments.push(`Table: ${clean(block.title)}`)
        break
    }
  }
  return { title: dashboard.title, segments }
}

// ---- whiteboard

type Placed = { element: WhiteboardElement; x: number; y: number; h: number; cx: number; cy: number; text: string[] }

/**
 * Reading order on a board: rows top to bottom, each left to right. An element joins the current
 * row while its top is above that row's first element's vertical middle, so a taller shape a
 * little higher than its neighbours still reads in its place along the row.
 */
function readingOrder<T extends Placed>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: T[][] = []
  let middle = Number.NEGATIVE_INFINITY
  for (const item of sorted) {
    const row = rows[rows.length - 1]
    if (row && item.y < middle) row.push(item)
    else {
      rows.push([item])
      middle = item.y + item.h / 2
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
}

/** A note's or shape's text without its marks: **bold**, *italic*, and "- " bullets as lines. */
function boardText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => speakableInline(line.replace(/^\s*[-•]\s+/, '')))
    .filter(Boolean)
}

function whiteboardOutline(body: string): Outline | null {
  const parsed = parseBoard(body)
  if (!parsed.ok) return null
  const board = parsed.board
  const sections: Array<Placed & { w: number; h: number; members: Placed[] }> = []
  const readable: Placed[] = []
  for (const element of board.elements) {
    switch (element.type) {
      case 'section':
        sections.push({
          element,
          x: element.x,
          y: element.y,
          cx: element.x + element.w / 2,
          cy: element.y + element.h / 2,
          w: element.w,
          h: element.h,
          text: element.title.trim() ? [clean(element.title)] : [],
          members: [],
        })
        break
      case 'note':
      case 'shape': {
        const text = boardText(element.text ?? '')
        if (text.length)
          readable.push({ element, x: element.x, y: element.y, h: element.h, cx: element.x + element.w / 2, cy: element.y + element.h / 2, text })
        break
      }
      case 'text': {
        const text = boardText(element.text)
        const w = element.w ?? 0
        const h = TEXT_SIZE_PX[element.size] * LINE_HEIGHT * text.length
        if (text.length) readable.push({ element, x: element.x, y: element.y, h, cx: element.x + w / 2, cy: element.y + h / 2, text })
        break
      }
      case 'link':
        if (element.title.trim())
          readable.push({ element, x: element.x, y: element.y, h: element.h, cx: element.x + element.w / 2, cy: element.y + element.h / 2, text: [clean(element.title)] })
        break
      default:
        break
    }
  }
  const loose: Placed[] = []
  for (const item of readable) {
    // The innermost (smallest) section whose box holds the element's centre owns it.
    let owner: (typeof sections)[number] | undefined
    for (const section of sections) {
      const inside =
        item.cx >= section.x && item.cx <= section.x + section.w && item.cy >= section.y && item.cy <= section.y + section.h
      if (inside && (!owner || section.w * section.h < owner.w * owner.h)) owner = section
    }
    if (owner) owner.members.push(item)
    else loose.push(item)
  }
  const top: Placed[] = readingOrder<Placed>([...sections, ...loose])
  const segments: string[] = []
  for (const item of top) {
    segments.push(...item.text)
    const section = sections.find((s) => s === item)
    if (section) for (const member of readingOrder(section.members)) segments.push(...member.text)
  }
  return { title: board.title, segments }
}

// ---- design

function designOutline(body: string, selection: ArtifactSpeechSelection): Outline | null {
  const parsed = validateDesign(parseJson(body))
  if (!parsed.ok) return null
  const design = parsed.design
  const mains = collectMains(design.boards)
  const segments: string[] = []
  const walk = (node: DesignNode, depth: number) => {
    if (node.hidden || depth > 64) return
    switch (node.type) {
      case 'frame': {
        const frame: FrameNode = isInstance(node) ? resolveInstance(node, mains) : node
        for (const child of frame.children) walk(child, depth + 1)
        break
      }
      case 'text':
        if (node.text.trim()) segments.push(node.text)
        break
      case 'button':
        if (node.label.trim()) segments.push(node.label)
        break
      default:
        break
    }
  }
  for (const board of design.boards) {
    if (selection.boardId && board.id !== selection.boardId) continue
    if (board.title.trim()) segments.push(board.title)
    walk(board.root, 0)
  }
  return { title: design.title, segments }
}
