import {
  DECK_SPACING_SCALE,
  DESIGN_SIZE,
  TEXT_SIZE_SCALE,
  type Deck,
  type Slide,
  type SlideElement,
  type TextElement,
} from './slides'

/**
 * Slide overflow, one vocabulary for the editor and the agent. The editor measures its drawn
 * slide (freebuff/web SlideElements.tsx `overflowRegions`, the on-stage flag); the agent, with no
 * DOM, gets `slidesOverflowIssues`, an estimate from the same boxes. Both name a region with
 * `overflowRegionLabel`, so "text box \"callout\"" or "left column" means the same thing in a
 * warning the person sees and in the issue read_artifact returns. Pure and deterministic.
 */

/** Where a slide's text does not fit: the layout's body or a column, a free text element, or the slide. */
export type OverflowRegion =
  | { kind: 'body' }
  | { kind: 'column'; index: number }
  | { kind: 'element'; id: string }
  | { kind: 'slide' }

/** The one name of an overflow region, in the editor's warning and the agent's issue alike. */
export function overflowRegionLabel(region: OverflowRegion): string {
  switch (region.kind) {
    case 'body':
      return 'body'
    case 'column':
      return region.index === 0 ? 'left column' : 'right column'
    case 'element':
      return `text box "${region.id}"`
    case 'slide':
      return 'slide'
  }
}

/** A free element's default text size (px), as the editor draws it. */
export const ELEMENT_DEFAULT_TEXT_SIZE = 24

/**
 * One text region of a slide as the estimate sees it: how much text it holds against the room
 * its box has (the layout report, slides-layout-report.ts, lists these).
 */
export type SlideTextRegion = {
  slideId: string
  slideNumber: number
  region: string
  /** Characters a reader sees (Markdown markers and URLs left out). */
  chars: number
  /** About how many characters the box holds at this size (when the text is like this one). */
  capacity: number
  /** Height needed over height available: above 1 does not fit. */
  fill: number
}

export type SlideOverflowIssue = {
  slideId: string
  slideNumber: number
  /** The layout text it concerns (a free text box reports `body`; `region` names the box). */
  element: TextElement
  /** The region, named as the editor's on-stage warning names it (`overflowRegionLabel`). */
  region: string
  message: string
}

/*
 * The renderer's boxes, from freebuff/web components/workspace/slides/slides-canvas.css: the
 * canvas pads 52 at the top and 64 each side, a footer takes 44 at the bottom (a cover pads 52
 * there instead), a title is 34px at line-height 1.15 with 24 below it, body text 21px at 1.45.
 * Text does not shrink to fit: what does not fit is cut off at the slide's edge.
 */
const PAD_TOP_BASE = 52
const PAD_INLINE_BASE = 64
const FOOTER = 44
/** Average glyph width as a share of the font size (a sans text face). */
const CHAR_WIDTH = 0.55
/** Flag only clear overflow: the estimate must exceed the room by this factor. */
const SLACK = 1.15
/** A title over this many lines crowds out the slide even when the body still fits. */
const MAX_TITLE_LINES = 3

type Font = { px: number; lineHeight: number }

const TITLE: Font = { px: 34, lineHeight: 1.15 }
const BODY: Font = { px: 21, lineHeight: 1.45 }

/** Markdown down to the characters a reader sees: link and image text, no markers or URLs. */
function visibleText(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:[^>]*>/g, 'link')
    .replace(/[*_`~]/g, '')
}

/** Lines a run of `text` wraps to in a box `width` wide. */
function wrappedLines(text: string, width: number, px: number): number {
  const perLine = Math.max(1, Math.floor(width / (px * CHAR_WIDTH)))
  return Math.max(1, Math.ceil(text.length / perLine))
}

function plainHeight(text: string, width: number, font: Font): number {
  const lines = text.split('\n').reduce((sum, line) => sum + wrappedLines(line, width, font.px), 0)
  return lines * font.px * font.lineHeight
}

/**
 * The height a Markdown body takes in a box `width` wide: paragraphs (14 below), list items
 * (indented 1.4em, 10 below; nested ones at 0.88em), pipe-table rows (0.81em text, 24 padding).
 */
function markdownHeight(markdown: string, width: number, font: Font): number {
  let height = 0
  let gap = 0
  let inTable = false
  let inParagraph = false
  for (const raw of markdown.split('\n')) {
    if (raw.trim() === '') {
      inTable = false
      inParagraph = false
      continue
    }
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (line.startsWith('|')) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue
      const px = font.px * 0.81
      height += gap + px * font.lineHeight + (inTable ? 24 : 10)
      gap = 0
      inTable = true
      continue
    }
    inTable = false
    const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (item) {
      const nested = indent >= 2
      const px = nested ? font.px * 0.88 : font.px
      const inset = font.px * 1.4 * (nested ? 2 : 1)
      height += gap + wrappedLines(visibleText(item[2] ?? ''), width - inset, px) * px * font.lineHeight
      gap = 10
      inParagraph = false
    } else {
      // A line straight after a paragraph line continues that paragraph (a soft break).
      const px = heading ? font.px * 1.2 : font.px
      height += (inParagraph ? 0 : gap) + wrappedLines(visibleText(heading ? (heading[1] ?? '') : line), width, px) * px * font.lineHeight
      gap = 14
      inParagraph = !heading
    }
  }
  return height
}

/**
 * How wide a pipe table's narrowest layout is: each column at least as wide as its longest word
 * (cells wrap between words, never inside one; 0.81em text, 24px of cell padding). Zero without a table.
 */
function tableMinWidth(markdown: string, font: Font): number {
  const rows = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(line))
  if (!rows.length) return 0
  const px = font.px * 0.81
  const widths: number[] = []
  for (const row of rows) {
    row
      .replace(/^\||\|$/g, '')
      .split('|')
      .forEach((cell, i) => {
        const longest = Math.max(0, ...visibleText(cell).split(/\s+/).map((word) => word.length))
        widths[i] = Math.max(widths[i] ?? 0, longest * px * CHAR_WIDTH + 24)
      })
  }
  return widths.reduce((sum, width) => sum + width, 0)
}

const visibleLength = (markdown: string) =>
  markdown
    .split('\n')
    .map((line) => visibleText(line.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, '')).replace(/\|/g, ' ').trim())
    .join(' ')
    .trim().length

const scaled = (font: Font, slide: Slide, element: TextElement): Font => ({
  px: font.px * TEXT_SIZE_SCALE[slide.style?.[element]?.size ?? 'md'],
  lineHeight: font.lineHeight,
})

/**
 * Text likely to overflow its slide, judged from the deck's canvas (960x540 or 720x540), each
 * layout's boxes and the text sizes: a title too long, a body (columns, quote, takeaway, caption)
 * with more lines than its box holds. An estimate, conservative by design: it flags clear
 * overflow only, and never speaker notes.
 */
export function slidesOverflowIssues(deck: Deck): SlideOverflowIssue[] {
  return scanDeck(deck).issues
}

/** Every text region the estimate measures, with its text length against its room. */
export function slidesTextRegions(deck: Deck): SlideTextRegion[] {
  return scanDeck(deck).regions
}

function scanDeck(deck: Deck): { issues: SlideOverflowIssue[]; regions: SlideTextRegion[] } {
  const canvas = DESIGN_SIZE[deck.aspect]
  // The deck's spacing token scales the canvas padding (slides-canvas.css `--fb-slide-pad-*`).
  const pad = DECK_SPACING_SCALE[deck.tokens?.spacing ?? 'normal']
  const PAD_TOP = PAD_TOP_BASE * pad
  const PAD_INLINE = PAD_INLINE_BASE * pad
  const contentWidth = canvas.width - PAD_INLINE * 2
  const noFooter = deck.footer === '' && deck.slideNumbers === false
  const issues: SlideOverflowIssue[] = []
  const regions: SlideTextRegion[] = []

  deck.slides.forEach((slide, index) => {
    const slideNumber = index + 1
    const report = (element: TextElement, message: string, region?: OverflowRegion) =>
      issues.push({
        slideId: slide.id,
        slideNumber,
        element,
        region: overflowRegionLabel(region ?? (element === 'body' ? { kind: 'body' } : { kind: 'slide' })),
        message,
      })
    // Only the cover pads its bottom; other layouts end at the footer, or at the edge without one.
    const bottom = slide.layout === 'title' ? PAD_TOP : noFooter ? 0 : FOOTER
    const room = canvas.height - PAD_TOP - bottom
    const over = (need: number, have: number) => need > have * SLACK
    const lines = (px: number, font: Font) => Math.round(px / (font.px * font.lineHeight))
    // Capacity: the lines the box holds times the characters a line holds (with the box's width
    // and font), else in proportion to how much of the box this text fills.
    const measured = (region: string, text: string | undefined, need: number, have: number, box?: { width: number; font: Font }) => {
      if (!text?.trim() || need <= 0) return
      const chars = visibleLength(text)
      const fill = have > 0 ? need / have : 99
      const capacity = box
        ? Math.floor(Math.max(0, have) / (box.font.px * box.font.lineHeight)) * Math.max(1, Math.floor(box.width / (box.font.px * CHAR_WIDTH)))
        : Math.floor(chars / fill)
      regions.push({ slideId: slide.id, slideNumber, region, chars, capacity: Math.max(0, capacity), fill: Math.round(fill * 100) / 100 })
    }
    const wide = (element: TextElement, markdown: string | undefined, width: number, font: Font, region?: OverflowRegion) => {
      if (!markdown) return
      const need = tableMinWidth(markdown, font)
      if (need > width * SLACK)
        report(
          element,
          `the table in the ${overflowRegionLabel(region ?? { kind: 'body' })} needs about ${Math.round(need)}px across but its box is ${Math.round(width)}px wide, so its right side is cut off. Use fewer columns or shorter words, or split the table.`,
          region,
        )
    }
    const tooMuch = (element: TextElement, need: number, have: number, font: Font, cut: string, text?: string, width = contentWidth) => {
      measured(element, text, need, have, { width, font })
      if (!over(need, have)) return
      const fits = Math.max(1, lines(have, font))
      report(
        element,
        `the ${element} runs to about ${lines(need, font)} lines; its box holds about ${fits} at this size, and text past it is cut off. ${cut}`,
      )
    }

    // A title on top of the slide (every layout but the cover, section, quote and blank).
    let titleHeight = 0
    if (slide.title && ['title-body', 'two-column', 'image', 'chart'].includes(slide.layout)) {
      const font = scaled(TITLE, slide, 'title')
      const titleLines = slide.title.split('\n').reduce((sum, line) => sum + wrappedLines(line, contentWidth, font.px), 0)
      titleHeight = titleLines * font.px * font.lineHeight + 24
      measured('title', slide.title, titleLines, MAX_TITLE_LINES)
      if (titleLines > MAX_TITLE_LINES)
        report('title', `the title wraps to about ${titleLines} lines and crowds out the slide; keep it to one or two lines and move the rest into the body.`)
    }
    const below = room - titleHeight
    const shorten = 'Cut or split it over two slides (or move detail into notes), or set a smaller style size.'

    switch (slide.layout) {
      case 'title-body': {
        const font = scaled(BODY, slide, 'body')
        if (slide.body) tooMuch('body', markdownHeight(slide.body, contentWidth, font), below, font, shorten, slide.body)
        wide('body', slide.body, contentWidth, font)
        break
      }
      case 'two-column': {
        const font = scaled({ px: 19, lineHeight: BODY.lineHeight }, slide, 'body')
        const width = (contentWidth - 48) / 2
        const heights = (slide.columns ?? []).map((column) => markdownHeight(column, width, font))
        const tallest = Math.max(...heights, 0)
        const index = heights.indexOf(tallest)
        ;(slide.columns ?? []).forEach((column, i) => {
          measured(overflowRegionLabel({ kind: 'column', index: i }), column, heights[i] ?? 0, below, { width, font })
          wide('body', column, width, font, { kind: 'column', index: i })
        })
        if (over(tallest, below)) {
          const fits = Math.max(1, lines(below, font))
          report(
            'body',
            `the ${overflowRegionLabel({ kind: 'column', index })} runs to about ${lines(tallest, font)} lines; its box holds about ${fits} at this size, and text past it is cut off. ${shorten}`,
            { kind: 'column', index },
          )
        }
        break
      }
      case 'image':
      case 'chart': {
        // The picture or chart shrinks to what is left; leave it at least a third of the slide.
        const element: TextElement = slide.layout === 'image' ? 'subtitle' : 'body'
        const text = slide.layout === 'image' ? slide.subtitle : slide.body
        const font = scaled({ px: slide.layout === 'image' ? 15 : 18, lineHeight: BODY.lineHeight }, slide, element)
        if (text) tooMuch(element, markdownHeight(text, contentWidth, font), below - room / 3, font, 'Keep it to a line or two.', text)
        break
      }
      case 'title':
      case 'section': {
        const cover = slide.layout === 'title'
        const width = Math.min(cover ? 720 : 680, contentWidth)
        const font = scaled({ px: cover ? 54 : 46, lineHeight: cover ? 1.06 : 1.15 }, slide, 'title')
        const title = slide.title ? plainHeight(slide.title, width, font) : 0
        const sub = scaled({ px: 22, lineHeight: 1.4 }, slide, 'subtitle')
        const subtitle = slide.subtitle ? plainHeight(slide.subtitle, width, sub) : 0
        const chrome = cover ? 20 + 6 + (subtitle ? 20 : 0) : 4 + 16 + (subtitle ? 16 : 0)
        measured('title', [slide.title, slide.subtitle].filter(Boolean).join(' '), title + subtitle + chrome, room)
        if (over(title + subtitle + chrome, room)) {
          const element: TextElement = title >= subtitle ? 'title' : 'subtitle'
          report(element, `the ${cover ? 'cover' : 'section'} text is taller than the slide (about ${Math.round(title + subtitle + chrome)}px of ${room}px); shorten the ${element}.`)
        }
        break
      }
      case 'quote': {
        const width = Math.min(760, contentWidth)
        const font = scaled({ px: 36, lineHeight: 1.25 }, slide, 'body')
        const by = slide.subtitle ? 18 * TEXT_SIZE_SCALE[slide.style?.subtitle?.size ?? 'md'] * BODY.lineHeight + 16 : 0
        if (slide.body) tooMuch('body', markdownHeight(slide.body, width, font), room - by, font, 'Quote less, or set a smaller style size.', slide.body, width)
        break
      }
      case 'blank': {
        const font = scaled({ px: 30, lineHeight: 1.3 }, slide, 'body')
        if (slide.body) tooMuch('body', markdownHeight(slide.body, contentWidth, font), room, font, shorten, slide.body)
        break
      }
    }

    for (const element of slide.elements ?? []) {
      elementOverflow(element, report)
      const text = 'text' in element && typeof element.text === 'string' ? element.text.trim() : ''
      if (text && (element.type === 'text' || element.type === 'rect' || element.type === 'ellipse')) {
        const shape = element.type !== 'text'
        const font: Font = { px: element.size ?? ELEMENT_DEFAULT_TEXT_SIZE, lineHeight: 1.25 }
        const width = Math.max(1, element.w - (shape ? 24 : 0))
        measured(overflowRegionLabel({ kind: 'element', id: element.id }), text, plainHeight(text, width, font), element.h - (shape ? 16 : 0), { width, font })
      }
    }
  })
  return { issues, regions }
}

/**
 * A free element whose text is taller than its box (text boxes at 1.25 line height; rect and
 * ellipse labels inside 8/12 padding), as the editor's on-stage flag measures it.
 */
function elementOverflow(
  element: SlideElement,
  report: (element: TextElement, message: string, region: OverflowRegion) => void,
): void {
  if (element.type !== 'text' && element.type !== 'rect' && element.type !== 'ellipse') return
  const text = element.text?.trim()
  if (!text) return
  const shape = element.type !== 'text'
  const font: Font = { px: element.size ?? ELEMENT_DEFAULT_TEXT_SIZE, lineHeight: 1.25 }
  const width = element.w - (shape ? 24 : 0)
  const height = element.h - (shape ? 16 : 0)
  const need = plainHeight(text, Math.max(1, width), font)
  if (need <= height * SLACK) return
  const region: OverflowRegion = { kind: 'element', id: element.id }
  report(
    'body',
    `the ${overflowRegionLabel(region)} needs about ${Math.round(need)}px of its ${Math.round(height)}px height; text past it is cut off. Shorten it, make the box taller, or set a smaller size.`,
    region,
  )
}
