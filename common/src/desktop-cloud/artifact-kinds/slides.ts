/**
 * Freebuff Slides — the deck content model (version 1).
 *
 * ===========================================================================
 * FOR AN AGENT AUTHORING A DECK
 * ===========================================================================
 * A deck is ONE JSON object. It is declarative data, never HTML: there is no
 * field that takes markup, CSS or script, and Markdown bodies are rendered
 * without raw HTML (any `<tag>` shows as text). Unknown keys are rejected, so
 * a typo fails validation instead of being silently dropped.
 *
 *   {
 *     "version": 1,
 *     "title": "Q4 launch plan",            // 1-200 chars
 *     "aspect": "16:9",                      // or "4:3"
 *     "theme": "plain",                      // optional: "plain" | "tinted" | "bold"
 *     "accent": "brand",                     // optional: "brand" | "blue" | "green" | "amber" | "red"
 *     "transition": "fade",                  // optional, present mode: "none" | "fade" | "slide" | "push" | "magic" (absent: fade)
 *     "fonts": { "heading": "serif", "body": "system" },  // optional, DECK_FONT_IDS (system stacks + the app's web fonts)
 *     "tokens": { "name": "Acme", "colors": { "accent": "#0057ff" }, "spacing": "roomy" },  // optional design system
 *     "footer": "Acme · Confidential",       // optional, <= 120 chars; absent: the deck title, "": none
 *     "slideNumbers": false,                 // optional; absent: numbers shown
 *     "slides": [ Slide, ... ]               // 1-200 slides, in presenting order
 *   }
 *
 * Slide:
 *   {
 *     "id": "cover",            // unique in the deck; letters, digits, "-" or "_", 1-64 chars.
 *                               // Keep ids stable: edits, comments and "Ask Buffy" address slides by id.
 *     "layout": "title",        // see the table below
 *     "title": "...",           // optional, <= 200 chars, plain text
 *     "subtitle": "...",        // optional, <= 300 chars, plain text
 *     "body": "...",            // optional Markdown, <= 4000 chars
 *     "columns": ["md", "md"],  // exactly two Markdown strings, each <= 4000 chars
 *     "image": { "src": "/_asset/<id>", "alt": "...", "fit": "contain" },  // fit optional: "contain" | "cover"
 *                               // position optional: { "x": 0-100, "y": 0-100 }, the point kept in view under cover
 *     "section": "Results",     // optional, <= 80 chars: this slide starts a section of that name
 *     "chart": { ...the Docs chart spec, see below... },
 *     "notes": "...",           // optional speaker notes, plain text, <= 4000 chars
 *     "style": { "title": { "size": "lg", "align": "center", "color": "accent" } },
 *                               // optional per element (title | subtitle | body): size sm|md|lg|xl,
 *                               // align start|center|end, color ink|soft|accent (theme roles)
 *     "build": "bullets",       // optional: present mode reveals top-level bullets one per click ("all": nested too)
 *     "sectionDescription": "…", // optional, <= 300 chars, with `section`: what that section covers
 *     "transition": "slide",    // optional: how present mode arrives at this slide (absent: the deck's)
 *     "elements": [ Element ]   // optional, <= 40: free-position text boxes, shapes, lines, arrows,
 *                               // images above the layout, back to front (see SLIDES_GUIDE)
 *   }
 *
 * Layouts (the canvas is a fixed 960x540 for 16:9, 720x540 for 4:3, scaled to fit):
 *   title       Cover. Big `title`, `subtitle` under it. `body` is ignored.
 *   section     Divider between parts. `title`, optional `subtitle`.
 *   title-body  `title` on top, `body` below: bullets, numbered lists, bold, links, tables.
 *   two-column  `title`, then `columns` side by side. REQUIRES `columns`.
 *   image       `title` (optional), one picture, `subtitle` as caption. REQUIRES `image`.
 *   chart       `title`, one chart, `body` as a one-line takeaway. REQUIRES `chart`.
 *   quote       `body` is the quotation (Markdown), `subtitle` the attribution.
 *   blank       Only `body`, centred. Use sparingly.
 * Text fields are always optional (a person may clear one while editing); only
 * the payload a layout cannot draw without (columns, image, chart) is required.
 *
 * Markdown (GitHub-flavoured): `- bullets`, `1. numbered`, `**bold**`, `*italic*`,
 * `[links](https://...)`, `` `code` ``, pipe tables. Keep a slide to ~6 bullets or
 * one table of <= 6 rows; long text does not shrink to fit, it overflows.
 *
 * image.src: an uploaded `/_asset/<id>` ref: for a picture from the web, call
 * `import_artifact_image` first and use the ref it returns (read_artifact's `assets` lists the
 * deck's). Never hotlink. The schema still accepts an `https://` URL so stored decks keep
 * validating, but the tool flags one and every view draws it as a placeholder (the workspace
 * until the reader clicks "Load images", a share link always; remote-images.ts). No `data:`,
 * `http:` or `javascript:` URLs.
 *
 * chart: the same spec as a Docs ```chart block, as an object (not a string):
 *   { "type": "bar" | "line" | "area", "title"?: string, "x": "<row key for the x axis>",
 *     "series": [{ "key": "<row key>", "label": "<legend label>" }],   // 1-8, unique, not x
 *     "data": [{ "<x>": "Week 1", "<series key>": 40 }, ...] }           // 1-500 rows
 *   Every row has the x key; series values are finite numbers. Exactly the
 *   rules of `parseChartSpec` in doc/DocChart.tsx (a test keeps them in step).
 *
 * Editing: rewrite one slide by id (`replaceSlide`), reorder with the full id
 * list (`reorderSlides`), add or remove one at a time (`slides-ops.ts`). Always
 * send the whole deck back through `parseDeck` before storing it. The agent's
 * full reference (with its patch ops) is `SLIDES_GUIDE` at the end of this file.
 * ===========================================================================
 *
 * The one source of truth for the deck body: the app (freebuff/web
 * components/workspace/slides re-exports it) and the server (packages/internal
 * freebuff-artifacts/kinds.ts) both validate with it. zod only: no React, no DOM.
 */

import { z } from 'zod/v4'
import { CHART_LIMITS, chartSpecSchema } from './chart'
import { FONT_IDS, FONT_STACKS, type FontId } from './design'
import { isSameOriginImagePath } from '../artifact-image-src'

export { chartSpecSchema }

export const SLIDE_LAYOUTS = [
  'title',
  'section',
  'title-body',
  'two-column',
  'image',
  'chart',
  'quote',
  'blank',
] as const
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number]

export const SLIDE_LAYOUT_LABEL: Record<SlideLayout, string> = {
  title: 'Title',
  section: 'Section',
  'title-body': 'Title and body',
  'two-column': 'Two columns',
  image: 'Image',
  chart: 'Chart',
  quote: 'Quote',
  blank: 'Blank',
}

export const DECK_ASPECTS = ['16:9', '4:3'] as const
export type DeckAspect = (typeof DECK_ASPECTS)[number]

export const DECK_THEMES = ['plain', 'tinted', 'bold'] as const
export type DeckTheme = (typeof DECK_THEMES)[number]

/** The deck's accent colour, each a Desktop colour token (never a raw value). */
export const DECK_ACCENTS = ['brand', 'blue', 'green', 'amber', 'red'] as const
export type DeckAccent = (typeof DECK_ACCENTS)[number]

/**
 * How present mode moves between slides. Reduced motion always cuts. `push` moves the old slide
 * out as the new one comes in; `magic` (a "magic move" / morph) glides every free element whose
 * id is on both slides from its old box to its new one and fades the rest in.
 */
export const DECK_TRANSITIONS = ['none', 'fade', 'slide', 'push', 'magic'] as const
export type DeckTransition = (typeof DECK_TRANSITIONS)[number]

export const IMAGE_FITS = ['contain', 'cover'] as const
export type ImageFit = (typeof IMAGE_FITS)[number]

/**
 * A slide's text elements a person (or the agent) may restyle: `body` also covers a two-column
 * slide's columns, a chart's takeaway and a quote's text; `subtitle` an image's caption and a
 * quote's attribution.
 */
export const TEXT_ELEMENTS = ['title', 'subtitle', 'body'] as const
export type TextElement = (typeof TEXT_ELEMENTS)[number]

/** Size steps relative to the layout's own size for that element (`md` = the layout's). */
export const TEXT_SIZES = ['sm', 'md', 'lg', 'xl'] as const
export type TextSize = (typeof TEXT_SIZES)[number]
export const TEXT_SIZE_SCALE: Record<TextSize, number> = { sm: 0.82, md: 1, lg: 1.22, xl: 1.5 }

export const TEXT_ALIGNS = ['start', 'center', 'end'] as const
export type TextAlign = (typeof TEXT_ALIGNS)[number]

/** Text colours, each a role of the deck's theme (never a raw value): ink, soft ink, accent. */
export const TEXT_COLORS = ['ink', 'soft', 'accent'] as const
export type TextColor = (typeof TEXT_COLORS)[number]

/**
 * Present-mode builds: `bullets` reveals a slide's top-level list items one per click; `all`
 * reveals every list item, nested ones too, in reading order. Free elements build by their own
 * `build` step, after the bullets.
 */
export const SLIDE_BUILDS = ['bullets', 'all'] as const
export type SlideBuild = (typeof SLIDE_BUILDS)[number]

/**
 * The deck's fonts, by id from the shared allowlist of system and web-safe stacks (design.ts
 * `FONT_STACKS`; nothing is downloaded).
 */
export { FONT_IDS, FONT_STACKS, type FontId }

/**
 * Web fonts a deck may use besides the system stacks: the faces the app already serves itself
 * (next/font, freebuff/web lib/fonts.ts), so nothing is fetched from a third party. Each maps to
 * the app's CSS variable with a system fallback; a .pptx names the face (PowerPoint substitutes
 * one it lacks).
 */
export const SLIDE_WEB_FONTS = ['google-sans', 'inter', 'jetbrains-mono'] as const
export type SlideWebFont = (typeof SLIDE_WEB_FONTS)[number]
export const SLIDE_WEB_FONT_STACKS: Record<SlideWebFont, { label: string; stack: string; face: string }> = {
  'google-sans': { label: 'Google Sans (web)', stack: 'var(--font-sans), system-ui, sans-serif', face: 'Google Sans' },
  inter: { label: 'Inter (web)', stack: 'var(--font-inter), system-ui, sans-serif', face: 'Inter' },
  'jetbrains-mono': { label: 'JetBrains Mono (web)', stack: 'var(--font-mono), ui-monospace, monospace', face: 'JetBrains Mono' },
}
/** Every font id a deck's `fonts` may name: the shared system stacks, then the web fonts. */
export const DECK_FONT_IDS = [...FONT_IDS, ...SLIDE_WEB_FONTS] as const
export type DeckFontId = (typeof DECK_FONT_IDS)[number]
const isWebFont = (id: string): id is SlideWebFont => (SLIDE_WEB_FONTS as readonly string[]).includes(id)
/** The CSS stack for a deck font id. */
export function deckFontStack(id: DeckFontId): string {
  return isWebFont(id) ? SLIDE_WEB_FONT_STACKS[id].stack : FONT_STACKS[id].stack
}
/** The name a person sees for a deck font id. */
export function deckFontLabel(id: DeckFontId): string {
  return isWebFont(id) ? SLIDE_WEB_FONT_STACKS[id].label : FONT_STACKS[id].label
}

/**
 * Icons a slide may place (`icon` elements): a curated set from the app's own icon library
 * (lucide, which Desktop's `Icon` draws). Names only here; the editor maps each to its glyph.
 */
export const SLIDE_ICONS = [
  'check', 'x', 'star', 'heart', 'lightbulb', 'rocket', 'target', 'flag', 'award', 'zap',
  'trending-up', 'trending-down', 'chart-bar', 'chart-pie', 'chart-line', 'dollar', 'percent',
  'users', 'user', 'building', 'briefcase', 'globe', 'map-pin', 'calendar', 'clock', 'mail',
  'phone', 'message', 'shield', 'lock', 'key', 'settings', 'search', 'database', 'cloud',
  'server', 'code', 'cpu', 'smartphone', 'laptop', 'book', 'graduation-cap', 'leaf', 'sun',
  'thumbs-up', 'thumbs-down', 'alert', 'info', 'help', 'arrow-right', 'arrow-up', 'arrow-down',
  'refresh', 'link', 'gift', 'shopping-cart', 'truck', 'puzzle', 'sparkles', 'layers',
] as const
export type SlideIcon = (typeof SLIDE_ICONS)[number]

/** How a free element arrives (at its build step, or with the slide). Reduced motion: none. */
export const ELEMENT_ANIMATIONS = ['fade', 'rise', 'zoom', 'wipe'] as const
export type ElementAnimation = (typeof ELEMENT_ANIMATIONS)[number]

/** Where a connector draws its arrowheads. */
export const CONNECTOR_HEADS = ['none', 'end', 'both'] as const
export type ConnectorHead = (typeof CONNECTOR_HEADS)[number]

/** The deck's breathing room: scales the canvas padding (and so the room its text has). */
export const DECK_SPACINGS = ['compact', 'normal', 'roomy'] as const
export type DeckSpacing = (typeof DECK_SPACINGS)[number]
export const DECK_SPACING_SCALE: Record<DeckSpacing, number> = { compact: 0.75, normal: 1, roomy: 1.25 }

/** Colour roles a design-system token set may set (hex), over the theme's own. */
export const TOKEN_COLOR_ROLES = ['ink', 'soft', 'accent', 'paper', 'tint'] as const
export type TokenColorRole = (typeof TOKEN_COLOR_ROLES)[number]

/** Caps. The editors enforce the text ones too, so every edit still parses. */
export const LIMITS = {
  slides: 200,
  title: 200,
  subtitle: 300,
  markdown: 4000,
  notes: 4000,
  alt: 300,
  section: 80,
  src: 2048,
  idLength: 64,
  footer: 120,
  chartSeries: CHART_LIMITS.series,
  chartRows: CHART_LIMITS.rows,
  sectionDescription: 300,
  elements: 40,
  elementText: 1000,
  linkTitle: 120,
  linkDescription: 300,
  tokenName: 80,
} as const

/**
 * Free-position elements: drawn above a slide's layout at design-size coordinates (the canvas
 * is 960x540 or 720x540). Bounds are fixed, not per aspect, so a deck switched to 4:3 still
 * parses (anything off the canvas is clipped).
 */
export const ELEMENT_TYPES = ['text', 'rect', 'ellipse', 'line', 'arrow', 'image', 'icon', 'link', 'connector'] as const
export type ElementType = (typeof ELEMENT_TYPES)[number]

/** Fill and stroke colours, each a role of the deck's theme (never a raw value). */
export const ELEMENT_COLORS = ['none', 'ink', 'soft', 'accent', 'tint', 'paper'] as const
export type ElementColor = (typeof ELEMENT_COLORS)[number]

export const ELEMENT_BOUNDS = {
  min: -1000,
  max: 2000,
  minSize: 1,
  maxSize: 2000,
  minFont: 8,
  maxFont: 160,
  maxStroke: 24,
} as const

/** The fixed design size each aspect is laid out at, before scaling to fit. */
export const DESIGN_SIZE: Record<DeckAspect, { width: number; height: number }> = {
  '16:9': { width: 960, height: 540 },
  '4:3': { width: 720, height: 540 },
}

const SLIDE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// https:// stays valid so stored decks keep parsing; the agent tool flags one (never hotlink:
// import_artifact_image first) and the views draw it as a placeholder (remote-images.ts).
const safeSrc = (src: string) => src.startsWith('https://') || isSameOriginImagePath(src)

const markdown = z.string().max(LIMITS.markdown)

/** One text element's look; every field optional (absent = the layout's own). */
export const textStyleSchema = z.strictObject({
  size: z.enum(TEXT_SIZES).optional(),
  align: z.enum(TEXT_ALIGNS).optional(),
  color: z.enum(TEXT_COLORS).optional(),
})
export type TextStyle = z.infer<typeof textStyleSchema>

const percent = z.number().finite().min(0).max(100)

const coordinate = z.number().finite().min(ELEMENT_BOUNDS.min).max(ELEMENT_BOUNDS.max)
const extent = z.number().finite().min(ELEMENT_BOUNDS.minSize).max(ELEMENT_BOUNDS.maxSize)
const elementColor = z.enum(ELEMENT_COLORS)

/** Every element: an id unique on its slide, a box, and a rotation in degrees about its centre. */
const elementBase = {
  id: z
    .string()
    .min(1)
    .max(LIMITS.idLength)
    .regex(SLIDE_ID, 'letters, digits, "-" or "_", starting with a letter or digit'),
  x: coordinate,
  y: coordinate,
  w: extent,
  h: extent,
  rotation: z.number().finite().min(-360).max(360).optional(),
  // Present mode: the click (after the slide's bullets) at which it appears; elements with the
  // same number appear together. Absent: it is there when the slide arrives.
  build: z.number().int().min(1).max(LIMITS.elements).optional(),
  // How it arrives, at its build step or with the slide.
  animate: z.enum(ELEMENT_ANIMATIONS).optional(),
  // Its place in the reading order screen readers and exports follow (1 first); unnumbered ones
  // read after the numbered ones, back to front.
  readOrder: z.number().int().min(1).max(LIMITS.elements).optional(),
}

const HEX = /^#[0-9a-fA-F]{6}$/
const hex = z.string().regex(HEX, 'a #rrggbb colour')
const httpsUrl = z
  .string()
  .min(1)
  .max(LIMITS.src)
  .refine((url) => /^https:\/\/[^\s/]+\.[^\s]+$/.test(url), 'an https:// URL')

/** Plain text (never Markdown, never a link) and its look. */
const elementText = {
  text: z.string().max(LIMITS.elementText).optional(),
  size: z.number().finite().min(ELEMENT_BOUNDS.minFont).max(ELEMENT_BOUNDS.maxFont).optional(),
  align: z.enum(TEXT_ALIGNS).optional(),
  color: z.enum(TEXT_COLORS).optional(),
  bold: z.boolean().optional(),
}

const strokeWidth = z.number().finite().min(0).max(ELEMENT_BOUNDS.maxStroke).optional()

export const slideElementSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...elementBase, type: z.literal('text'), ...elementText, fill: elementColor.optional() }),
  z.strictObject({
    ...elementBase,
    type: z.literal('rect'),
    ...elementText,
    fill: elementColor.optional(),
    stroke: elementColor.optional(),
    strokeWidth,
  }),
  z.strictObject({
    ...elementBase,
    type: z.literal('ellipse'),
    ...elementText,
    fill: elementColor.optional(),
    stroke: elementColor.optional(),
    strokeWidth,
  }),
  // A line (or arrow) runs across its box at mid-height, left to right; rotate it for any angle.
  z.strictObject({ ...elementBase, type: z.literal('line'), stroke: elementColor.optional(), strokeWidth }),
  z.strictObject({ ...elementBase, type: z.literal('arrow'), stroke: elementColor.optional(), strokeWidth }),
  z.strictObject({
    ...elementBase,
    type: z.literal('image'),
    src: z
      .string()
      .min(1)
      .max(LIMITS.src)
      .refine(safeSrc, 'an https:// URL or a same-origin path starting with /'),
    alt: z.string().max(LIMITS.alt),
    fit: z.enum(IMAGE_FITS).optional(),
  }),
  // An icon from SLIDE_ICONS drawn to fit its box in a theme colour (default accent); `label` is
  // what a screen reader says (absent: decorative).
  z.strictObject({
    ...elementBase,
    type: z.literal('icon'),
    icon: z.enum(SLIDE_ICONS),
    color: elementColor.optional(),
    label: z.string().max(LIMITS.alt).optional(),
  }),
  // A link card, what a deck offers instead of an embed (no third-party page ever runs inside a
  // slide): its title, an optional line and the site's host; it opens in a new tab.
  z.strictObject({
    ...elementBase,
    type: z.literal('link'),
    url: httpsUrl,
    title: z.string().min(1).max(LIMITS.linkTitle),
    description: z.string().max(LIMITS.linkDescription).optional(),
  }),
  // A connector bound to two elements of the slide by id, redrawn between them wherever they move.
  // Its box is where it was last drawn, used only while an end's element is missing.
  z.strictObject({
    ...elementBase,
    type: z.literal('connector'),
    from: z.string().min(1).max(LIMITS.idLength),
    to: z.string().min(1).max(LIMITS.idLength),
    stroke: elementColor.optional(),
    strokeWidth,
    head: z.enum(CONNECTOR_HEADS).optional(),
  }),
])
export type SlideElement = z.infer<typeof slideElementSchema>

export const slideSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(LIMITS.idLength)
      .regex(SLIDE_ID, 'letters, digits, "-" or "_", starting with a letter or digit'),
    layout: z.enum(SLIDE_LAYOUTS),
    title: z.string().max(LIMITS.title).optional(),
    subtitle: z.string().max(LIMITS.subtitle).optional(),
    body: markdown.optional(),
    columns: z.tuple([markdown, markdown]).optional(),
    image: z
      .strictObject({
        src: z
          .string()
          .min(1)
          .max(LIMITS.src)
          .refine(safeSrc, 'an https:// URL or a same-origin path starting with /'),
        alt: z.string().max(LIMITS.alt),
        fit: z.enum(IMAGE_FITS).optional(),
        // The point of the picture kept in view when `fit` is cover (percent; absent = centre).
        position: z.strictObject({ x: percent, y: percent }).optional(),
      })
      .optional(),
    chart: chartSpecSchema.optional(),
    notes: z.string().max(LIMITS.notes).optional(),
    section: z.string().min(1).max(LIMITS.section).optional(),
    // What the section this slide starts is about (the grid view shows it); needs `section`.
    sectionDescription: z.string().min(1).max(LIMITS.sectionDescription).optional(),
    // How present mode arrives at this slide; absent: the deck's transition.
    transition: z.enum(DECK_TRANSITIONS).optional(),
    // Free-position elements above the layout, back to front.
    elements: z.array(slideElementSchema).max(LIMITS.elements).optional(),
    style: z
      .strictObject({
        title: textStyleSchema.optional(),
        subtitle: textStyleSchema.optional(),
        body: textStyleSchema.optional(),
      })
      .optional(),
    build: z.enum(SLIDE_BUILDS).optional(),
  })
  .superRefine((slide, ctx) => {
    const need = (field: 'columns' | 'image' | 'chart') => {
      if (slide[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `layout "${slide.layout}" needs ${field}`,
        })
      }
    }
    if (slide.layout === 'two-column') need('columns')
    if (slide.layout === 'image') need('image')
    if (slide.layout === 'chart') need('chart')
    if (slide.sectionDescription !== undefined && slide.section === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sectionDescription'],
        message: 'a section description needs the section it describes ("section")',
      })
    }
    const seen = new Set<string>()
    slide.elements?.forEach((element, i) => {
      if (seen.has(element.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'id'],
          message: `duplicate element id "${element.id}" on this slide`,
        })
      }
      seen.add(element.id)
    })
  })

export const deckSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().min(1).max(LIMITS.title),
    aspect: z.enum(DECK_ASPECTS),
    theme: z.enum(DECK_THEMES).optional(),
    accent: z.enum(DECK_ACCENTS).optional(),
    transition: z.enum(DECK_TRANSITIONS).optional(),
    fonts: z
      .strictObject({ heading: z.enum(DECK_FONT_IDS).optional(), body: z.enum(DECK_FONT_IDS).optional() })
      .optional(),
    // A design-system token set over the theme: colours (hex) by role, a spacing scale and the
    // name of the system it came from. Fonts stay in `fonts`.
    tokens: z
      .strictObject({
        name: z.string().min(1).max(LIMITS.tokenName).optional(),
        colors: z
          .strictObject({ ink: hex.optional(), soft: hex.optional(), accent: hex.optional(), paper: hex.optional(), tint: hex.optional() })
          .optional(),
        spacing: z.enum(DECK_SPACINGS).optional(),
      })
      .optional(),
    // The footer's text on every content slide: absent shows the deck title, "" shows none.
    footer: z.string().max(LIMITS.footer).optional(),
    // Slide numbers in the footer; absent means shown.
    slideNumbers: z.boolean().optional(),
    slides: z.array(slideSchema).min(1).max(LIMITS.slides),
  })
  .superRefine((deck, ctx) => {
    const seen = new Set<string>()
    deck.slides.forEach((slide, i) => {
      if (seen.has(slide.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['slides', i, 'id'],
          message: `duplicate slide id "${slide.id}"`,
        })
      }
      seen.add(slide.id)
    })
  })

export type Slide = z.infer<typeof slideSchema>
export type Deck = z.infer<typeof deckSchema>

export type DeckParseResult =
  | { ok: true; deck: Deck }
  | { ok: false; issues: Array<{ path: string; message: string }> }

/** Validate an untrusted deck (from the agent or storage). Never throws. */
export function parseDeck(input: unknown): DeckParseResult {
  const result = deckSchema.safeParse(input)
  if (result.success) return { ok: true, deck: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  }
}

const SLIDE_TEMPLATE_NAMES = ['title', 'agenda', 'comparison', 'timeline', 'big-number', 'quote', 'team', 'closing']
  .map((name) => `"${name}"`)
  .join(' | ')

/**
 * The full authoring reference `artifact_guide {kind: "slides"}` returns: the
 * doc comment above, for the agent, plus how to edit a stored deck. Keep the
 * two in step (`artifact-kinds.test.ts` checks every layout and limit is named).
 */
export const SLIDES_GUIDE = `Slides (kind "slides"): a deck is ONE JSON object, declarative data, never HTML. Unknown keys are rejected.

{ "version": 1, "title": "Q4 launch plan" (1-${LIMITS.title} chars), "aspect": "16:9" | "4:3", "theme"?: "plain" | "tinted" | "bold",
  "accent"?: "brand" | "blue" | "green" | "amber" | "red", "transition"?: "none" | "fade" | "slide" | "push" | "magic" (present mode; absent means fade; "magic" glides every free element whose id is on both slides from its old box to its new one, like Keynote's Magic Move: keep the ids the same on consecutive slides and change x/y/w/h),
  "fonts"?: { "heading"?: font, "body"?: font } (font: ${DECK_FONT_IDS.map((id) => `"${id}"`).join(' | ')}; the first ${FONT_IDS.length} are system stacks, the last ${SLIDE_WEB_FONTS.length} the app's own web fonts; absent means the app font),
  "tokens"?: { "name"?: text <= ${LIMITS.tokenName}, "colors"?: { "ink"?, "soft"?, "accent"?, "paper"?, "tint"? } (each "#rrggbb": text, secondary text, accent, slide background, light fill), "spacing"?: "compact" | "normal" | "roomy" } (a design system over the theme; install one with installDesignSystem),
  "footer"?: text <= ${LIMITS.footer} on every content slide (absent: the deck title; "": no footer text), "slideNumbers"?: false hides the numbers,
  "slides": [Slide, ...] (1-${LIMITS.slides}, in presenting order) }

Slide: { "id": "cover" (unique; letters, digits, "-" or "_", starting with a letter or digit, <= ${LIMITS.idLength} chars; keep ids stable, edits address slides by id),
  "layout": see below, "title"?: plain text <= ${LIMITS.title}, "subtitle"?: plain text <= ${LIMITS.subtitle}, "body"?: Markdown <= ${LIMITS.markdown},
  "columns"?: [markdown, markdown] (exactly two), "image"?: { "src": "/_asset/<id>" (import_artifact_image first; never hotlink), "alt": "..." (<= ${LIMITS.alt}; describe the picture, never empty), "fit"?: "contain" | "cover",
    "position"?: { "x": 0-100, "y": 0-100 } (percent; the point kept in view when fit is cover; absent: the centre) },
  "chart"?: chart spec, "notes"?: speaker notes, plain text <= ${LIMITS.notes},
  "section"?: plain text <= ${LIMITS.section}: this slide starts a section of that name (the grid view groups by it),
  "style"?: { "title"?: TextStyle, "subtitle"?: TextStyle, "body"?: TextStyle } (body also styles columns, a chart takeaway and a quote; subtitle a caption or attribution),
  "build"?: "bullets" | "all" (present mode reveals the top-level bullets one per click; "all" every list item, nested ones too; reduced motion shows them without animation),
  "sectionDescription"?: plain text <= ${LIMITS.sectionDescription}, only with "section": what that section covers (the grid view shows it),
  "transition"?: "none" | "fade" | "slide" | "push" | "magic" (how present mode arrives at THIS slide; absent: the deck's "transition"),
  "elements"?: [Element, ...] (<= ${LIMITS.elements}; free-position boxes drawn above the layout, back to front) }
Element (positions in canvas pixels: 960x540, or 720x540 for 4:3; x/y may go off the canvas, which clips it):
  common: { "id": unique on the slide (same rules as slide ids), "type": see below, "x", "y", "w", "h" (w, h >= 1), "rotation"?: degrees clockwise about the centre,
    "build"?: 1-${LIMITS.elements} (present mode: it appears on that click, after the bullets; equal numbers appear together; absent: with the slide),
    "animate"?: ${ELEMENT_ANIMATIONS.map((name) => `"${name}"`).join(' | ')} (how it arrives), "readOrder"?: 1-${LIMITS.elements} (its place in what a screen reader reads; number every element on a busy slide) }
  "text": "text"?: plain text <= ${LIMITS.elementText} (newlines kept, never Markdown or links), "size"?: px ${ELEMENT_BOUNDS.minFont}-${ELEMENT_BOUNDS.maxFont} (default 24), "align"?: "start" | "center" | "end", "color"?: "ink" | "soft" | "accent", "bold"?: true, "fill"?: colour
  "rect" | "ellipse": "fill"?, "stroke"?: colour, "strokeWidth"?: 0-${ELEMENT_BOUNDS.maxStroke}, and an optional label with the text fields above
  "line" | "arrow": drawn across the box at mid-height, left to right (the arrowhead at the right); rotate it for other angles. "stroke"?, "strokeWidth"?
  "image": "src" (same rule as image.src), "alt", "fit"?: "contain" | "cover"
  "icon": "icon": one of ${SLIDE_ICONS.map((name) => `"${name}"`).join(', ')}; "color"?: colour (default accent), "label"?: what it means for a screen reader (absent: decorative)
  "link": "url": "https://…", "title": <= ${LIMITS.linkTitle}, "description"?: <= ${LIMITS.linkDescription} (a link card that opens the page in a new tab; there are NO embeds: no other site ever runs inside a slide)
  "connector": "from", "to": ids of two other elements on the slide, "head"?: "none" | "end" | "both" (default end), "stroke"?, "strokeWidth"? (redrawn between them wherever they move; prefer the connect op, which fills in its box)
  colour: "none" | "ink" | "soft" | "accent" | "tint" | "paper" (theme roles, never raw colours).
Prefer the layouts for ordinary slides; use elements for what they cannot draw (a timeline, callouts, a big number, a diagram of a few boxes and arrows). Keep text inside its box: long text overflows.
TextStyle: { "size"?: "sm" | "md" | "lg" | "xl" (relative to the layout's size), "align"?: "start" | "center" | "end", "color"?: "ink" | "soft" | "accent" (theme roles, never raw colours) }. Restyle sparingly: the layouts are designed to work unstyled.

Layouts (canvas 960x540 for 16:9, 720x540 for 4:3):
- title: cover; big title, subtitle under it; body ignored.
- section: divider between parts; title, optional subtitle.
- title-body: title on top, body below (bullets, numbered lists, bold, links, tables).
- two-column: title, then columns side by side. REQUIRES columns.
- image: optional title, one picture, subtitle as caption. REQUIRES image.
- chart: title, one chart, body as a one-line takeaway. REQUIRES chart.
- quote: body is the quotation (Markdown), subtitle the attribution.
- blank: only body, centred. Use sparingly.
Text fields are optional; only the payload a layout needs (columns, image, chart) is required.

Markdown is GitHub-flavoured: - bullets, 1. numbered, **bold**, *italic*, [links](https://...), \`code\`, pipe tables. Raw HTML shows as text. Keep a slide to about 6 bullets or one table of <= 6 rows; long text overflows, it does not shrink.
image.src (and an image element's src): an uploaded "/_asset/<id>" ref. For any picture from the web, call import_artifact_image first and use the ref it returns (read_artifact lists the deck's assets). Never hotlink an https:// URL: readers see a placeholder instead of it (a share link always). No data:, http: or javascript: URLs.
chart (an object, not a string): { "type": "bar" | "line" | "area", "title"?: string, "x": "<row key for the x axis>",
  "series": [{ "key": "<row key>", "label": "<legend>" }] (1-${LIMITS.chartSeries}, unique, not x),
  "data": [{ "<x>": "Week 1", "<series key>": 40 }] (1-${LIMITS.chartRows} rows) }. Every row has the x key; series values are finite numbers; no other keys.

Example: {"version":1,"title":"Q4 plan","aspect":"16:9","slides":[{"id":"cover","layout":"title","title":"Q4 plan","subtitle":"November review"},{"id":"goals","layout":"title-body","title":"Goals","body":"- Ship v2\\n- Halve churn"}]}

Editing a stored deck: edit_artifact with patch, a list of ops applied in order and then validated as a whole (any failure changes nothing):
- {"op":"addSlide","slide":{...},"after"?:"<slide id>"} (no after: at the end; "after":"" puts it first)
- {"op":"replaceSlide","slide":{...}} (rewrites the slide with that id)
- {"op":"removeSlide","id":"<slide id>"} (never the last one)
- {"op":"reorderSlides","ids":["cover","goals",...]} (every id exactly once)
- {"op":"styleElement","id":"<slide id>","element":"title" | "subtitle" | "body","style":TextStyle | null} (merges into that element's style; a null field or style clears it)
- {"op":"addElement","slide":"<slide id>","element":Element} (on top; without an "id" one is made, "<type>-N")
- {"op":"updateElement","slide":"<slide id>","id":"<element id>","set":{"x":120,"text":"…","fill":null}} (merges; null clears an optional field; never "id" or "type")
- {"op":"removeElement","slide":"<slide id>","ids":["<element id>", ...]}
- {"op":"reorderElement","slide":"<slide id>","id":"<element id>","to":"front" | "back" | "forward" | "backward"}
- {"op":"addSlideFromTemplate","template":${SLIDE_TEMPLATE_NAMES},"id"?:"<new id>","after"?:"<slide id>"} (a ready-made starting slide; then edit its text)
- {"op":"duplicateSlide","id":"<slide id>","newId"?:"<copy id>"} (the copy goes right after it)
- {"op":"setSection","id":"<slide id>","name":"Results" | null,"description"?:"…" | null} (this slide starts (or, null, stops starting) a section)
- {"op":"setTransition","id"?:"<slide id>","transition":"none" | "fade" | "slide" | "push" | "magic" | null} (no id: the deck's; null clears)
- {"op":"setDeckStyle","theme"?:…,"accent"?:…,"transition"?:…,"fonts"?:…,"footer"?:…,"slideNumbers"?:…,"tokens"?:…} (null clears a field)
- {"op":"setAspect","aspect":"16:9" | "4:3"} (reflows every slide's free elements to the new width)
- {"op":"installDesignSystem","tokens":{…} | null,"name"?:"Acme","fonts"?:false} (copy a design system into the deck: pass a Design artifact's "tokens" as you read them (named #hex colours text, muted, primary, background, surface; fonts; spacingUnit), or a tokens.json; null removes it; fonts:false keeps the deck's fonts)
- {"op":"connect","slide":"<slide id>","from":"<element id>","to":"<element id>","head"?:"none" | "end" | "both","stroke"?:colour,"id"?:"<new id>"} (a connector bound to both)
- {"op":"setBuild","slide":"<slide id>","bullets"?:"bullets" | "all" | null,"elements"?:["<id>", ["<id>","<id>"], …]} (the click order: each entry one click after the bullets, an inner list appears together; elements not listed arrive with the slide)
- {"op":"setReadingOrder","slide":"<slide id>","ids":["<element id>", …]} (what a screen reader reads first; unlisted ones after)
- {"op":"duplicateElement","slide":"<slide id>","ids":["<element id>", …],"offset"?:16} (copies on top, offset, under fresh ids)
- {"op":"replaceText","find":"Q3","replace":"Q4","matchCase"?:false,"wholeWord"?:false,"includeNotes"?:true} (every match in titles, bodies, columns, captions, alt text, notes and element text; ids and URLs untouched)
- {"op":"importOutline","text":"# Part\n## Slide\n- point","after"?:"<slide id>","replace"?:false} (slides from Markdown: --- or a heading per slide, # a section, > a quote, "Notes:" the speaker notes; or a plain outline, one slide per top-level line)
- generic {"op":"set"|"insert"|"remove","path":"/slides/1/title","value":...} on a JSON pointer (insert adds to an array; "-" appends). Deck-wide look: set "/fonts", "/footer", "/slideNumbers", "/theme".
Small changes (one title, one bullet) are a set; rewrite a whole slide with replaceSlide.
You cannot see the rendered slides (nothing renders them for you), but reads and edits list "overflow" (slide id, element, region): each slide whose text likely does not fit its box (an estimate from the layout's boxes, the text sizes and the table widths; it errs on the side of saying nothing). Fix every one before you say you are done, and keep text short for its box anyway (a title on one or two lines, about 6 bullets). The person sees the same warning on the slide, measured in their browser (they may ask you to fix one by slide id and region), and the editor's Checks list also flags overlapping or off-slide elements, low contrast, missing alt text and slides without a title: avoid those too (give every content slide a title, every image alt text, keep elements on the canvas and apart).

Making slides from a doc (or notes, a page, a transcript): read the source first (read_artifact for a stored doc), then outline before writing: one idea per slide, a cover, a section slide per major heading, a title-body slide per sub-point with at most about 6 short bullets (rewrite sentences into bullets; never paste paragraphs), tables as chart or two-column slides where they compare, and the detail you cut into that slide's notes. Create the deck with create_artifact, then refine slide by slide with replaceSlide.
A chart from a dataset (a data or sheet artifact): read it, then copy the rows you need into the slide's chart.data (a snapshot, at most ${LIMITS.chartRows} rows; aggregate first if there are more). Say on the slide or in its notes where the numbers came from and when; the slide does not update when the dataset changes.`
