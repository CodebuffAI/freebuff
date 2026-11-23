import { DESIGN_SIZE, type Deck, type Slide, type SlideElement } from './slides'
import { connectorLine, contrastRatio, deckPalette, tokensFixPalette } from './slides-r5'
import { slidesOverflowIssues, slidesTextRegions, type SlideTextRegion } from './slides-overflow'

/**
 * A slide-by-slide layout report: the closest thing to a render that exists without a browser
 * (there is no server-side renderer). For each slide it lists the text regions with their length
 * against the room their box has, the free elements and where they sit, whether it has a title
 * and its images' alt text, and the problems a person would see: text that will not fit (the
 * same estimate as `slidesOverflowIssues`), elements that overlap or leave the canvas, text
 * whose colour is too close to what is behind it, images without alt text, slides without a
 * title, tiny text and connectors whose ends are gone. The editor's Checks list shows the same
 * findings; the agent's read can return it. Pure and deterministic; an estimate, never a render.
 */

export type LayoutIssueKind =
  | 'overflow'
  | 'overlap'
  | 'off-canvas'
  | 'contrast'
  | 'missing-alt'
  | 'missing-title'
  | 'small-text'
  | 'unbound-connector'

export type LayoutIssue = {
  kind: LayoutIssueKind
  slideId: string
  slideNumber: number
  /** The free elements it concerns, by id. */
  elements?: string[]
  message: string
}

export type ElementPlacement = {
  id: string
  type: SlideElement['type']
  box: { x: number; y: number; w: number; h: number }
  /** Inside the canvas, cut off at an edge, or wholly off it (invisible). */
  placement: 'inside' | 'partly-off' | 'off'
  /** A text element's character count, an image's alt, an icon's name, a link's host. */
  content?: string
}

export type SlideLayoutReport = {
  slideId: string
  slideNumber: number
  layout: Slide['layout']
  hasTitle: boolean
  regions: Array<Omit<SlideTextRegion, 'slideId' | 'slideNumber'>>
  elements: ElementPlacement[]
  images: { count: number; missingAlt: number }
  issues: LayoutIssue[]
}

/** Layouts a title belongs on (a blank slide or a quote may go without). */
const TITLED: ReadonlyArray<Slide['layout']> = ['title', 'section', 'title-body', 'two-column', 'image', 'chart']

/** Below this many px, slide text is hard to read once presented. */
const SMALL_TEXT = 12
/** How far past the edge counts as cut off (strokes and shadows may poke out a little). */
const EDGE = 8

type Box = { x: number; y: number; w: number; h: number }

function placement(box: Box, width: number, height: number): ElementPlacement['placement'] {
  if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= width || box.y >= height) return 'off'
  if (box.x < -EDGE || box.y < -EDGE || box.x + box.w > width + EDGE || box.y + box.h > height + EDGE) return 'partly-off'
  return 'inside'
}

const area = (box: Box) => Math.max(0, box.w) * Math.max(0, box.h)
function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1

/** What an element shows: text, a picture, an icon or a card (lines and connectors show none). */
function content(element: SlideElement): string | undefined {
  switch (element.type) {
    case 'text':
    case 'rect':
    case 'ellipse':
      return element.text?.trim() ? `${element.text.trim().length} chars` : undefined
    case 'image':
      return element.alt ? `image "${element.alt.slice(0, 60)}"` : 'image (no alt text)'
    case 'icon':
      return `icon ${element.icon}`
    case 'link':
      try {
        return `link to ${new URL(element.url).host}`
      } catch {
        return 'link'
      }
    default:
      return undefined
  }
}

const carries = (element: SlideElement) =>
  element.type === 'image' || element.type === 'icon' || element.type === 'link' || (('text' in element && element.text?.trim()) ? true : false)

/** The free elements' boxes with each connector drawn where its ends put it. */
function boxOf(slide: Slide, element: SlideElement): Box {
  if (element.type !== 'connector') return element
  const line = connectorLine(slide, element)
  return { x: Math.min(line.x1, line.x2), y: Math.min(line.y1, line.y2), w: Math.abs(line.x2 - line.x1), h: Math.abs(line.y2 - line.y1) }
}

export function slidesLayoutReport(deck: Deck): SlideLayoutReport[] {
  const { width, height } = DESIGN_SIZE[deck.aspect]
  const overflow = slidesOverflowIssues(deck)
  const regions = slidesTextRegions(deck)
  const palettes = tokensFixPalette(deck) ? [{ mode: '', colors: deckPalette(deck, 'light') }] : (['light', 'dark'] as const).map((mode) => ({ mode: ` in ${mode} mode`, colors: deckPalette(deck, mode) }))
  return deck.slides.map((slide, index) => {
    const slideNumber = index + 1
    const issues: LayoutIssue[] = []
    const add = (kind: LayoutIssueKind, message: string, elements?: string[]) =>
      issues.push({ kind, slideId: slide.id, slideNumber, message, ...(elements?.length ? { elements } : {}) })

    for (const issue of overflow) if (issue.slideId === slide.id) add('overflow', `${issue.region}: ${issue.message}`, issue.region.startsWith('text box "') ? [issue.region.slice(10, -1)] : undefined)

    const hasTitle = Boolean(slide.title?.trim())
    if (!hasTitle && TITLED.includes(slide.layout))
      add('missing-title', 'no title: screen readers, the outline and the exported file can only call it "Slide ' + slideNumber + '". Give it a short title.')

    let images = 0
    let missingAlt = 0
    if (slide.image) {
      images++
      if (!slide.image.alt.trim()) {
        missingAlt++
        add('missing-alt', "the slide's picture has no alt text: describe it in a sentence (what it shows and why it is there).")
      }
    }

    const elements = slide.elements ?? []
    const placements: ElementPlacement[] = elements.map((element) => {
      const box = boxOf(slide, element)
      const where = element.rotation ? placement(rotatedBounds(box, element.rotation), width, height) : placement(box, width, height)
      const shown = content(element)
      return { id: element.id, type: element.type, box: { x: box.x, y: box.y, w: box.w, h: box.h }, placement: where, ...(shown ? { content: shown } : {}) }
    })

    elements.forEach((element, i) => {
      const where = placements[i].placement
      if (where === 'off') add('off-canvas', `element "${element.id}" is entirely off the ${width}x${height} slide, so nobody sees it. Move it on or remove it.`, [element.id])
      else if (where === 'partly-off') add('off-canvas', `element "${element.id}" runs past the slide's edge and is cut off there.`, [element.id])

      if (element.type === 'image') {
        images++
        if (!element.alt.trim()) {
          missingAlt++
          add('missing-alt', `image "${element.id}" has no alt text: describe what it shows.`, [element.id])
        }
      }
      if (element.type === 'connector') {
        const line = connectorLine(slide, element)
        if (!line.bound) add('unbound-connector', `connector "${element.id}" joins "${element.from}" and "${element.to}", but one of them is not on the slide: it is drawn in its old place. Reconnect or remove it.`, [element.id])
      }
      if ((element.type === 'text' || element.type === 'rect' || element.type === 'ellipse') && element.text?.trim()) {
        const size = element.size ?? 24
        if (size < SMALL_TEXT) add('small-text', `text in "${element.id}" is ${size}px; under ${SMALL_TEXT}px is hard to read on a projected slide.`, [element.id])
        // Its colour against what is behind it: its own fill, else the slide.
        const fill = element.fill && element.fill !== 'none' ? element.fill : 'paper'
        const ink = element.color ?? 'ink'
        const large = size >= 24 || (element.bold === true && size >= 19)
        const needed = large ? 3 : 4.5
        for (const { mode, colors } of palettes) {
          const ratio = contrastRatio(colors[ink], colors[fill])
          if (ratio < needed) {
            add('contrast', `"${element.id}": ${ink} text on ${fill === 'paper' ? 'the slide' : `a ${fill} fill`} is ${ratio}:1${mode}; text this size needs ${needed}:1. Change its colour or fill.`, [element.id])
            break
          }
        }
      }
    })

    // The deck's own colours (a design system's tokens) against its slide background.
    if (deck.tokens?.colors && index === 0) {
      for (const { mode, colors } of palettes)
        for (const role of ['ink', 'soft', 'accent'] as const) {
          const ratio = contrastRatio(colors[role], colors.paper)
          const needed = role === 'accent' ? 3 : 4.5
          if (ratio < needed) add('contrast', `the deck's ${role} colour is ${ratio}:1 against its background${mode} (needs ${needed}:1); every slide's ${role === 'ink' ? 'text' : role === 'soft' ? 'subtitles' : 'accents'} are hard to read.`)
        }
    }

    // Overlaps: two elements that both show something, partly over each other (one wholly
    // inside the other is a deliberate label on a shape, so it is left alone).
    for (let a = 0; a < elements.length; a++)
      for (let b = a + 1; b < elements.length; b++) {
        const first = elements[a]
        const second = elements[b]
        if (!carries(first) || !carries(second)) continue
        const boxA = placements[a].box
        const boxB = placements[b].box
        const shared = intersection(boxA, boxB)
        if (!shared || contains(boxA, boxB) || contains(boxB, boxA)) continue
        if (shared < Math.min(area(boxA), area(boxB)) * 0.1) continue
        add('overlap', `elements "${first.id}" and "${second.id}" overlap (${Math.round(shared)}px² shared); "${second.id}" is drawn over "${first.id}". Move one or make them not touch.`, [first.id, second.id])
      }

    return {
      slideId: slide.id,
      slideNumber,
      layout: slide.layout,
      hasTitle,
      regions: regions.filter((region) => region.slideId === slide.id).map(({ slideId: _s, slideNumber: _n, ...rest }) => rest),
      elements: placements,
      images: { count: images, missingAlt },
      issues,
    }
  })
}

/** Every finding in the deck, slide by slide (the Checks list). */
export function slidesLayoutIssues(deck: Deck): LayoutIssue[] {
  return slidesLayoutReport(deck).flatMap((slide) => slide.issues)
}

/** The axis-aligned bounds of a box turned `degrees` about its centre. */
function rotatedBounds(box: Box, degrees: number): Box {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const w = box.w * cos + box.h * sin
  const h = box.w * sin + box.h * cos
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h }
}
