import { z } from 'zod/v4'
import { isSameOriginImagePath } from '../artifact-image-src'

/**
 * FREEBUFF DESIGN — the body of a `design` artifact (version 1), written for the agent that
 * authors it.
 *
 * A design is a canvas of ARTBOARDS ("boards"): website and landing-page mockups, app screens,
 * wireframes, posters, social posts. Each board is a fixed-size frame placed on an infinite
 * canvas at (x, y), and its content is a TREE OF NODES that Freebuff draws with its own
 * renderer. There is no HTML, CSS or script anywhere in the body: only the node kinds below, so
 * a shared design is always safe to show. Unknown keys are refused (every object is strict).
 *
 * TOP LEVEL
 *   { version: 1, title, tokens?, styles?, pages?: Page[], boards: Board[], notes?: Note[], startBoard? }
 *   Round 4 (all optional): shared text/fill `styles` applied by `textStyle`/`fillStyle`; board
 *   `breakpoints` with node `responsive` overrides (design-resolve.ts); `constraints` on absolute
 *   children; vector shapes (arrow, polygon, star, path; design-vector.ts); board `guides` and
 *   `layoutGrid`; frame `rowGap`; text `fontSize`; the prototype's `startBoard`.
 *   tokens.colors   { name: "#rrggbb" }. Names are lowercase-kebab ("primary", "on-primary").
 *                   Any colour field elsewhere takes a token name or a hex ("#0f172a", "#fff",
 *                   "#0f172a80") or "transparent". Prefer tokens: editing a token restyles every
 *                   board at once. The renderer's defaults read these names when present:
 *                   background, surface, text, muted, border, primary, on-primary.
 *   tokens.fonts    { heading, body }, each one of FONT_IDS (system, humanist, geometric,
 *                   rounded, serif, didone, mono). Headings (display, h1-h3) use `heading`.
 *   tokens.radius   default corner radius for buttons and inputs (px, default 8).
 *   tokens.spacingUnit  the design's spacing grid (px, default 8). Use multiples of it.
 *   Board  { id, title, x, y, w, h, background?, root }   root is a frame that fills the board.
 *          Lay boards out left to right with ~120px between them; a row per flow or page.
 *          Common sizes: desktop 1440 wide, tablet 768x1024, phone 390x844, poster 1080x1350,
 *          social square 1080x1080. A long web page is one tall board (1440 x 3200 is fine).
 *   Note   { id, x, y, w?, text, kind: "title" | "note" }   canvas labels: a "title" above a
 *          row of boards, a "note" for a sticky comment. Notes are never part of a board.
 *   Page   { id, title }   each page is its own canvas. A board or note names its page with
 *          `page`; without one it sits on the first page, and a design without `pages` (every
 *          version-1 body written before pages existed) is one implicit page. design-pages.ts.
 *   Components: a frame with `component: true` is a MAIN; a frame with `instanceOf: <main id>`
 *          and no children is an INSTANCE that draws the main, with `overrides` for content
 *          (text, label, image) keyed by the main's node ids. design-components.ts.
 *
 * NODES (every node has a unique `id`; ids are unique across the whole design, boards and notes
 * included; optional `name` labels it in the layers panel; `hidden: true` skips it)
 *   frame   { layout: "stack-v" | "stack-h" | "grid" | "absolute", children: Node[],
 *             gap?, padding?, align?, justify?, wrap?, rowGap?, columns?, w?, h?, minW?, maxW?,
 *             minH?, maxH? (px bounds on a fill/hug size), grow?, fill?, gradient?, fillImage?,
 *             stroke?, strokeWidth?, strokeSides?, radius?, shadow?: none|sm|md|lg|xl|inner,
 *             blur?, aspect?, clip?, linkTo? }   (DESIGN_GUIDE has every field)
 *             stack-v / stack-h are flex columns / rows. grid has `columns` equal tracks.
 *             absolute places each child at its own x, y (px from the frame's top-left).
 *             align is the cross axis (start|center|end|stretch); justify the main axis
 *             (start|center|end|between|around|evenly). padding is a number, [vertical, horizontal] or
 *             [top, right, bottom, left].
 *   text    { text, style: display|h1|h2|h3|body|small|caption|mono, color?, weight?
 *             (400|500|600|700|800), align?: start|center|end, maxLines?, w? }
 *   image   { src | placeholder: photo|avatar|logo|chart|map, alt, w?, h?, radius?,
 *             fit?: cover|contain, aspect?, focus?, zoom? }  src is an uploaded "/_asset/<id>"
 *             (import_artifact_image for a web picture, or the editor's upload). Never hotlink:
 *             an https src still validates (stored bodies) but views draw it as a placeholder and
 *             Checks flags it. Prefer placeholders in mockups: they always render and export.
 *   icon    { icon (one of ICON_NAMES), size?, color? }
 *   button  { label, variant: primary|secondary|ghost, size?: sm|md|lg, icon?, w?, linkTo? }
 *             (an arrow-* or chevron-* icon sits after the label, any other before it)
 *   input   { kind: text|search|select|checkbox|toggle, label?, placeholder?, value?,
 *             checked?, w? }   drawn in the editor; a working control in Present (round 5).
 *   divider { color? }   a 1px rule across its parent.
 *   shape   { kind: rect|ellipse|line|arrow|polygon|star|path, w, h, fill?, stroke?,
 *             strokeWidth?, radius?, ... }   vectors (sides, innerRatio, vertices) in design-vector.ts.
 *   Sizes (w, h) are px numbers, "fill" (take the parent's remaining space on that axis) or
 *   "hug" (fit the content; the default). `grow: true` is "fill" along the parent's main axis.
 *   linkTo is a board id: in Present and shared views a click on that node opens the board,
 *   so an app flow is a click-through prototype. `transition` (with linkTo, on a frame or a
 *   button): instant (default) | dissolve | slide-left | slide-right | slide-up | slide-down.
 *
 * LAYOUT GUIDANCE
 *   - Build pages as a stack-v root of full-width sections (w: "fill"), each section a frame
 *     with generous padding (desktop [96, 120], phone [48, 24]) and a centred inner column.
 *   - Rows of cards: a grid with `columns` 3 on desktop, 1 on phone; never absolute for that.
 *   - Use absolute only for free compositions (posters, hero art, overlapping badges).
 *   - Keep text readable: body 16, small 14; cap long copy with `w` (e.g. 560) not line breaks.
 *   - Limits: depth 16, 600 nodes per board, 4000 nodes and 40 boards in all, 1 MB of JSON.
 *   - Edit one board at a time: replace that board's object, keep every other board as is.
 *
 * WORKED EXAMPLE (a phone sign-in screen)
 *   {
 *     "version": 1,
 *     "title": "Sign in",
 *     "tokens": {
 *       "colors": { "background": "#ffffff", "text": "#0f172a", "muted": "#64748b",
 *                   "border": "#e2e8f0", "primary": "#4f46e5", "on-primary": "#ffffff" },
 *       "fonts": { "heading": "geometric", "body": "system" }, "radius": 12
 *     },
 *     "boards": [{
 *       "id": "signin", "title": "Sign in", "x": 0, "y": 0, "w": 390, "h": 844,
 *       "background": "background",
 *       "root": { "type": "frame", "id": "signin-root", "layout": "stack-v",
 *         "padding": [72, 24], "gap": 24, "children": [
 *           { "type": "image", "id": "signin-logo", "placeholder": "logo", "alt": "Logo",
 *             "w": 48, "h": 48 },
 *           { "type": "text", "id": "signin-title", "text": "Welcome back", "style": "h1" },
 *           { "type": "input", "id": "signin-email", "kind": "text", "label": "Email",
 *             "placeholder": "you@company.com", "w": "fill" },
 *           { "type": "button", "id": "signin-go", "label": "Continue",
 *             "variant": "primary", "size": "lg", "w": "fill" }
 *         ] }
 *     }]
 *   }
 *
 * The one source of truth for the design body: the app (freebuff/web components/workspace/design
 * re-exports it) and the server (packages/internal freebuff-artifacts/kinds.ts, through
 * `validateDesign`) both validate with it. zod only: no React, no DOM. The agent's full reference
 * (design rules, a responsive worked example and the patch ops) is `DESIGN_GUIDE` at the end.
 */

export const DESIGN_LIMITS = {
  maxDepth: 16,
  maxNodesPerBoard: 600,
  maxNodes: 4000,
  maxBoards: 40,
  maxNotes: 200,
  maxChildren: 200,
  maxTokens: 48,
  maxBytes: 1_000_000,
  maxPages: 20,
  /** Nodes a board draws once every component instance is expanded. */
  maxExpandedNodesPerBoard: 3000,
  maxOverrides: 100,
  /** Breakpoints one board may declare (desktop base plus up to 5 more widths). */
  maxBreakpoints: 6,
  /** Shared named styles of each kind (text, fill). */
  maxStyles: 40,
  /** Ruler guides per axis on one board. */
  maxGuides: 40,
  /** Points in one vector path. */
  maxVertices: 64,
  /** Round 5: design variables (levers), inline data lists and their rows, interactions per node. */
  maxVariables: 32,
  maxDataLists: 8,
  maxDataRows: 50,
  maxDataFields: 12,
  maxInteractions: 8,
  /** Link cards on the canvas to artifacts made from the design. */
  maxLinks: 40,
  /** Design systems installed into one design. */
  maxInstalledSystems: 4,
  /** Guidelines text a design system carries. */
  maxGuidelines: 8000,
  /** Steps in a token spacing scale. */
  maxSpacingScale: 16,
} as const

export const FONT_IDS = [
  'system',
  'humanist',
  'geometric',
  'rounded',
  'serif',
  'didone',
  'mono',
] as const
export type FontId = (typeof FONT_IDS)[number]

/** System and web-safe stacks only: nothing is downloaded. */
export const FONT_STACKS: Record<FontId, { label: string; stack: string }> = {
  system: {
    label: 'System sans',
    stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  humanist: {
    label: 'Humanist',
    stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
  },
  geometric: {
    label: 'Geometric',
    stack: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  },
  rounded: {
    label: 'Rounded',
    stack: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif",
  },
  serif: {
    label: 'Serif',
    stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
  },
  didone: {
    label: 'Didone',
    stack: "Didot, 'Bodoni MT', 'Noto Serif Display', 'URW Palladio L', P052, Sylfaen, serif",
  },
  mono: {
    label: 'Monospace',
    stack: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  },
}

/** Icons an icon node (or a button's leading icon) may name; the renderer maps each to lucide. */
export const ICON_NAMES = [
  'arrow-right',
  'arrow-left',
  'arrow-up-right',
  'check',
  'check-circle',
  'x',
  'plus',
  'minus',
  'chevron-right',
  'chevron-left',
  'chevron-down',
  'menu',
  'search',
  'home',
  'user',
  'users',
  'settings',
  'bell',
  'mail',
  'message',
  'phone',
  'calendar',
  'clock',
  'map-pin',
  'globe',
  'lock',
  'shield',
  'key',
  'star',
  'heart',
  'bookmark',
  'share',
  'download',
  'upload',
  'link',
  'image',
  'camera',
  'play',
  'pause',
  'file',
  'folder',
  'cloud',
  'database',
  'code',
  'terminal',
  'zap',
  'sparkles',
  'layers',
  'layout',
  'chart',
  'trending-up',
  'credit-card',
  'shopping-cart',
  'tag',
  'gift',
  'filter',
  'sliders',
  'eye',
  'sun',
  'moon',
  'leaf',
  'coffee',
  'flame',
  'rocket',
  'droplet',
  'sprout',
  'thermometer',
  'wifi',
  'battery',
  'more',
] as const
export type IconName = (typeof ICON_NAMES)[number]

export const TEXT_STYLES = ['display', 'h1', 'h2', 'h3', 'body', 'small', 'caption', 'mono'] as const
export type TextStyle = (typeof TEXT_STYLES)[number]

export const PLACEHOLDERS = ['photo', 'avatar', 'logo', 'chart', 'map'] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

export const LAYOUTS = ['stack-v', 'stack-h', 'grid', 'absolute'] as const
export type FrameLayout = (typeof LAYOUTS)[number]

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const TOKEN_NAME = /^[a-z][a-z0-9-]{0,31}$/
export const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

const id = z.string().regex(ID, 'Ids are 1-64 letters, digits, - or _')
const px = (max: number) => z.number().finite().min(0).max(max)
const coord = z.number().finite().min(-100_000).max(100_000)
/** A hex, "transparent", or a token name (checked against tokens.colors in `validateDesign`). */
const color = z
  .string()
  .max(32)
  .refine(
    (value) => HEX.test(value) || value === 'transparent' || TOKEN_NAME.test(value),
    'A colour is a token name, a hex like #1f2937, or "transparent"',
  )
const size = z.union([px(8192), z.literal('fill'), z.literal('hug')])
const padding = z.union([
  px(512),
  z.tuple([px(512), px(512)]),
  z.tuple([px(512), px(512), px(512), px(512)]),
])

/**
 * An https URL, or a same-origin path with exactly one leading slash. https stays valid so stored
 * designs keep parsing; the agent is told never to hotlink (import_artifact_image gives an
 * `/_asset/<id>` ref), the tool flags one, and the views draw it as a placeholder (remote-images.ts).
 */
export function isSafeImageSrc(src: string): boolean {
  if (src.length > 2048 || /[\s\\]/.test(src) || /[\u0000-\u001f]/.test(src)) return false
  if (src.startsWith('/')) return isSameOriginImagePath(src)
  try {
    const url = new URL(src)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

export type Size = number | 'fill' | 'hug'
export type Padding = number | [number, number] | [number, number, number, number]

export type StrokePattern = 'solid' | 'dashed' | 'dotted'
const strokePattern = z.enum(['solid', 'dashed', 'dotted'])
export type Align = 'start' | 'center' | 'end' | 'stretch'
export const JUSTIFIES = ['start', 'center', 'end', 'between', 'around', 'evenly'] as const
export type Justify = (typeof JUSTIFIES)[number]
/** How an absolute child follows its parent when the parent resizes (and across breakpoints). */
export const H_CONSTRAINTS = ['left', 'right', 'leftRight', 'center', 'scale'] as const
export const V_CONSTRAINTS = ['top', 'bottom', 'topBottom', 'center', 'scale'] as const
export type Constraints = { h?: (typeof H_CONSTRAINTS)[number]; v?: (typeof V_CONSTRAINTS)[number] }
export const SHAPE_KINDS = ['rect', 'ellipse', 'line', 'arrow', 'polygon', 'star', 'path'] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]
/**
 * What a node may change at one breakpoint (keyed by the board's breakpoint id). Keys that do not
 * apply to the node's type are ignored, as is a key naming a breakpoint the board does not declare.
 */
export type ResponsiveOverride = {
  hidden?: boolean
  x?: number
  y?: number
  w?: Size
  h?: Size
  /** frame */
  layout?: FrameLayout
  gap?: number
  padding?: Padding
  columns?: number
  align?: Align
  justify?: Justify
  wrap?: boolean
  /** text */
  style?: TextStyle
  fontSize?: number
  weight?: 400 | 500 | 600 | 700 | 800
  /** button */
  size?: 'sm' | 'md' | 'lg'
}
/** A width a board also designs for: the renderer draws the board at `w` with node overrides. */
export type Breakpoint = { id: string; title: string; w: number; h?: number }
/** A shared text style: nodes apply it with `textStyle`; editing it restyles every user. */
export type TextStyleDef = {
  id: string
  name: string
  style: TextStyle
  fontSize?: number
  weight?: 400 | 500 | 600 | 700 | 800
  lineHeight?: number
  letterSpacing?: number
  color?: string
}
/** A shared fill style: frames and shapes apply it with `fillStyle`. */
export type FillStyleDef = { id: string; name: string; fill: string; gradient?: Gradient }
export type DesignStyles = { text?: TextStyleDef[]; fills?: FillStyleDef[] }
export type Shadow = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'inner'
export const SHADOWS = ['none', 'sm', 'md', 'lg', 'xl', 'inner'] as const
/**
 * A gradient fill: `from` to `to` (colours), at `angle` degrees (CSS: 180 is top to bottom).
 * `kind: "radial"` (round 5) spreads from the centre outward instead; the angle is then unused.
 */
export type Gradient = { from: string; to: string; angle?: number; kind?: 'linear' | 'radial' }

// ---- round 5: logic, interactions, systems and link cards (all optional; no stored body changes meaning)

/** A design variable: a lever the Props panel shows, bound by nodes (`bind`, `showIf`, `{{id}}` holes). */
export const VARIABLE_TYPES = ['boolean', 'text', 'number', 'color', 'choice'] as const
export type VariableType = (typeof VARIABLE_TYPES)[number]
export type VariableValue = string | number | boolean
export type DesignVariable = {
  id: string
  name: string
  type: VariableType
  value: VariableValue
  /** `choice`: the values it may take. */
  options?: string[]
  /** A per-board lever: shown with that board (data-props); absent means design-wide. */
  board?: string
}
/** A small inline list of records a `repeat` frame draws its children once per row for. */
export type DesignDataList = {
  id: string
  name: string
  fields: string[]
  rows: Array<Record<string, VariableValue>>
}
/** Draw the frame's children once per row of a data list (`{{item.<field>}}` holes and `bind`). */
export type RepeatSpec = { data: string; limit?: number }
/** Show the node only when the variable equals `equals` (or is truthy without it); `not` inverts. */
export type ShowIf = { variable: string; equals?: VariableValue; not?: boolean }
/** Fields a node may take from a variable (its id) or, inside a repeat, a row field ("item.<field>"). */
export const BINDABLE_KEYS = ['text', 'label', 'src', 'alt', 'fill', 'color', 'checked', 'value', 'placeholder'] as const
export type BindableKey = (typeof BINDABLE_KEYS)[number]
/** What a click does in Present and on a shared prototype (never in the editor). */
export const INTERACTION_ACTIONS = [
  'navigate',
  'back',
  'overlay',
  'closeOverlay',
  'toggle',
  'show',
  'hide',
  'setVariant',
  'setVariable',
] as const
export type InteractionAction = (typeof INTERACTION_ACTIONS)[number]
export type Interaction = {
  action: InteractionAction
  /** navigate / overlay: a board id; toggle / show / hide: a node id; setVariant: an instance id; setVariable: a variable id. */
  target?: string
  /** setVariant: the main component id; setVariable: the new value (toggle a boolean when absent). */
  value?: VariableValue
  transition?: Transition
}
/** A design system this design publishes: its tokens, styles and main components, plus guidelines. */
export type DesignSystemDef = {
  name: string
  /** Bumped by the author when they publish a change worth updating to. */
  version?: number
  description?: string
  guidelines?: string
  /** The main component ids that make up the system (default: every main). */
  components?: string[]
}
/** A design system copied in from another design of the same user, with where it came from. */
export type InstalledSystem = {
  id: string
  /** The source design artifact. */
  artifactId: string
  name: string
  /** The source artifact's revision at install (or last update). */
  revision: number
  version?: number
  installedAt: string
  /** The page holding the copied components (one board per system). */
  pageId?: string
  boardId?: string
  tokens?: string[]
  textStyles?: string[]
  fillStyles?: string[]
  components?: string[]
}
/** A card on the canvas linking an artifact made from this design (a deck, a doc). Never exported. */
export const LINK_KINDS = ['doc', 'slides', 'sheet', 'data', 'whiteboard', 'design'] as const
export type DesignLinkCard = {
  id: string
  artifactId: string
  kind: (typeof LINK_KINDS)[number]
  title: string
  x: number
  y: number
  page?: string
  note?: string
}
/** A background image on a frame: an uploaded asset or https URL, drawn under the children. */
export type ImageFill = { src: string; fit?: 'cover' | 'contain' }
export type Side = 'top' | 'right' | 'bottom' | 'left'
/** How Present (and a shared view's prototype) moves to a `linkTo` board. Default: instant. */
export const TRANSITIONS = ['instant', 'dissolve', 'slide-left', 'slide-right', 'slide-up', 'slide-down'] as const
export type Transition = (typeof TRANSITIONS)[number]
export type Anchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

type NodeBase = {
  id: string
  name?: string
  hidden?: boolean
  /** Space outside the layer, in the same side order as padding. */
  margin?: Padding
  /** Position inside an `absolute` frame (or with `absolute: true`); ignored elsewhere. */
  x?: number
  y?: number
  /** 0-1; the node and everything in it. */
  opacity?: number
  /** Out of its stack or grid's flow: placed at x/y from the parent's `anchor` corner (a pinned badge). */
  absolute?: boolean
  anchor?: Anchor
  /** Inside an absolute frame: how x/y/w/h follow the parent when it resizes. */
  constraints?: Constraints
  /** Overrides per breakpoint id of the node's board. */
  responsive?: Record<string, ResponsiveOverride>
  /** Round 5: drawn only while the variable matches (design-logic.ts). */
  showIf?: ShowIf
  /** Round 5: fields taken from a variable id or, inside a repeat, "item.<field>". */
  bind?: Partial<Record<BindableKey, string>>
  /** Round 5: what a click does in Present (in order). */
  interactions?: Interaction[]
}

export type FrameNode = NodeBase & {
  type: 'frame'
  layout: FrameLayout
  gap?: number
  padding?: Padding
  align?: Align
  justify?: Justify
  wrap?: boolean
  columns?: number
  w?: Size
  h?: Size
  /** Px bounds on a fill or hug size (a column that grows to at most 720, a card at least 240). */
  minW?: number
  maxW?: number
  minH?: number
  maxH?: number
  grow?: boolean
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokePattern?: StrokePattern
  radius?: number
  shadow?: Shadow
  clip?: boolean
  linkTo?: string
  /** With linkTo: how Present moves to that board. */
  transition?: Transition
  /** Drawn over `fill`; `fillImage` over both. */
  gradient?: Gradient
  fillImage?: ImageFill
  /** Only these sides get the stroke (default: all four). */
  strokeSides?: Side[]
  /** Layer blur in px. */
  blur?: number
  /** Width / height; the free axis follows the other. */
  aspect?: number
  /** A main component: other frames can be instances of it (`instanceOf` its id). */
  component?: boolean
  /** An instance: draws the main component with this id; `children` stays []. */
  instanceOf?: string
  /** Per-instance content, keyed by the id of a node inside the main component. */
  overrides?: Record<string, InstanceOverride>
  /** Gap between wrapped rows (with `wrap`); `gap` stays the gap along the row. */
  rowGap?: number
  /** A shared fill style id (`styles.fills`): its fill and gradient replace the frame's own. */
  fillStyle?: string
  /** Round 5: the children are drawn once per row of this data list. */
  repeat?: RepeatSpec
  children: DesignNode[]
}
/** What an instance may change in its copy of the main: content only (text, labels, images). */
export type InstanceOverride = {
  text?: string
  label?: string
  src?: string
  placeholder?: Placeholder
  alt?: string
}
export type TextNode = NodeBase & {
  type: 'text'
  text: string
  style: TextStyle
  color?: string
  weight?: 400 | 500 | 600 | 700 | 800
  align?: 'start' | 'center' | 'end'
  maxLines?: number
  w?: Size
  decoration?: 'underline' | 'line-through'
  /** px, added to the style's tracking. */
  letterSpacing?: number
  /** A multiple of the font size, replacing the style's. */
  lineHeight?: number
  /** px, replacing the style's size (the style still sets the font role and tag). */
  fontSize?: number
  /** A shared text style id (`styles.text`): its fields replace the node's own. */
  textStyle?: string
}
export type ImageNode = NodeBase & {
  type: 'image'
  src?: string
  placeholder?: Placeholder
  alt: string
  w?: Size
  h?: Size
  radius?: number
  fit?: 'cover' | 'contain'
  aspect?: number
  /** Round 5: the point of the picture kept in view when cropped (0-1 shares; default centre). */
  focus?: [number, number]
  /** Round 5: crop by zooming the picture in its box (1-4, default 1). */
  zoom?: number
}
export type IconNode = NodeBase & {
  type: 'icon'
  icon: IconName
  size?: number
  color?: string
}
export type ButtonNode = NodeBase & {
  type: 'button'
  label: string
  variant: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
  w?: Size
  linkTo?: string
  transition?: Transition
}
export type InputNode = NodeBase & {
  type: 'input'
  kind: 'text' | 'search' | 'select' | 'checkbox' | 'toggle'
  label?: string
  placeholder?: string
  value?: string
  checked?: boolean
  w?: Size
}
export type DividerNode = NodeBase & { type: 'divider'; color?: string }
export type ShapeNode = NodeBase & {
  type: 'shape'
  /** arrow is a line with a head at its end; polygon, star and path are vector shapes. */
  kind: ShapeKind
  w: Size
  h: Size
  fill?: string
  stroke?: string
  radius?: number
  gradient?: Gradient
  blur?: number
  aspect?: number
  /** polygon: sides; star: points (3-24). */
  sides?: number
  /** star: inner radius as a share of the outer (0.1-0.95, default 0.5). */
  innerRatio?: number
  /** path: points as [x, y] shares (0-1) of the shape's box, in drawing order. */
  vertices?: Array<[number, number]>
  /** path: join the last point back to the first (default false: an open line). */
  closed?: boolean
  /**
   * Round 5, path: per segment (from point i to i + 1), cubic control points [x1, y1, x2, y2] as
   * shares of the box, or null for a straight segment. The pen tool writes these.
   */
  curves?: Array<[number, number, number, number] | null>
  /** Stroke width in px for vector shapes, lines and arrows. */
  strokeWidth?: number
  strokePattern?: StrokePattern
  fillStyle?: string
}

export type DesignNode =
  | FrameNode
  | TextNode
  | ImageNode
  | IconNode
  | ButtonNode
  | InputNode
  | DividerNode
  | ShapeNode
export type NodeType = DesignNode['type']

export type DesignBoard = {
  id: string
  title: string
  x: number
  y: number
  w: number
  h: number
  background?: string
  /** The page the board sits on (a `pages` id); absent means the first page. */
  page?: string
  /** Draw a device bezel around the board on the canvas and in Present (never in exports). */
  device?: 'phone' | 'tablet'
  /** More widths this board designs for; nodes override per breakpoint id with `responsive`. */
  breakpoints?: Breakpoint[]
  /** Ruler guides, px from the board's left (x) and top (y). Editor aids, never drawn in exports. */
  guides?: { x?: number[]; y?: number[] }
  /** A column layout grid drawn over the board in the editor (never exported). */
  layoutGrid?: { columns: number; gutter: number; margin: number }
  /** Round 5: draw the board with the tokens' dark theme (tokens.themes.dark). */
  theme?: 'light' | 'dark'
  /** Round 5: a fluid page: Present and shared views reflow it to the window's width. */
  fluid?: boolean
  /** Round 5: the order keyboard focus visits the board's interactive nodes (ids). */
  focusOrder?: string[]
  root: FrameNode
}
export type DesignNote = {
  id: string
  x: number
  y: number
  w?: number
  text: string
  kind: 'title' | 'note'
  page?: string
}
/** A page: its own canvas of boards and notes. A design without `pages` has one page. */
export type DesignPage = { id: string; title: string }
export type DesignTokens = {
  colors: Record<string, string>
  fonts?: { heading: FontId; body: FontId }
  radius?: number
  spacingUnit?: number
  /** Round 5: the spacing steps a system allows (px), e.g. [4, 8, 12, 16, 24, 32, 48]. */
  spacingScale?: number[]
  /** Round 5: per-theme colour values; a board with `theme: "dark"` draws with `dark`'s. */
  themes?: { dark?: Record<string, string> }
}
export type Design = {
  version: 1
  title: string
  tokens?: DesignTokens
  pages?: DesignPage[]
  boards: DesignBoard[]
  notes?: DesignNote[]
  /** Shared named text and fill styles. */
  styles?: DesignStyles
  /** The board the prototype starts on (Present and the flows panel). */
  startBoard?: string
  /** Round 5: levers (data-props) the Props panel shows and nodes bind. */
  variables?: DesignVariable[]
  /** Round 5: small inline lists `repeat` frames draw from. */
  data?: DesignDataList[]
  /** Round 5: the design system this design publishes. */
  system?: DesignSystemDef
  /** Round 5: design systems copied in from other designs. */
  installedSystems?: InstalledSystem[]
  /** Round 5: link cards to artifacts made from the design. */
  links?: DesignLinkCard[]
}

const constraintsSchema = z.strictObject({
  h: z.enum(H_CONSTRAINTS).optional(),
  v: z.enum(V_CONSTRAINTS).optional(),
})
const weightSchema = z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800)])
const responsiveOverrideSchema = z.strictObject({
  hidden: z.boolean().optional(),
  x: coord.optional(),
  y: coord.optional(),
  w: size.optional(),
  h: size.optional(),
  layout: z.enum(LAYOUTS).optional(),
  gap: px(512).optional(),
  padding: padding.optional(),
  columns: z.number().int().min(1).max(12).optional(),
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  justify: z.enum(JUSTIFIES).optional(),
  wrap: z.boolean().optional(),
  style: z.enum(TEXT_STYLES).optional(),
  fontSize: z.number().finite().min(6).max(320).optional(),
  weight: weightSchema.optional(),
  size: z.enum(['sm', 'md', 'lg']).optional(),
})
const responsiveSchema = z
  .record(id, responsiveOverrideSchema)
  .refine((value) => Object.keys(value).length <= DESIGN_LIMITS.maxBreakpoints, 'Too many breakpoint overrides')

// ---- round 5 schemas
const variableValue = z.union([z.string().max(300), z.number().finite(), z.boolean()])
/** A data-list field name: what `{{item.<field>}}` and `"item.<field>"` bindings name. */
export const FIELD_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/
const showIfSchema = z.strictObject({ variable: id, equals: variableValue.optional(), not: z.boolean().optional() })
const bindSchema = z
  .partialRecord(z.enum(BINDABLE_KEYS), z.string().max(80).regex(/^(?:item\.[a-z][a-zA-Z0-9_]{0,31}|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/, 'A binding names a variable id or "item.<field>"'))
  .optional()
const interactionSchema = z.strictObject({
  action: z.enum(INTERACTION_ACTIONS),
  target: id.optional(),
  value: variableValue.optional(),
  transition: z.enum(TRANSITIONS).optional(),
})
const roundFiveBase = {
  showIf: showIfSchema.optional(),
  bind: bindSchema,
  interactions: z.array(interactionSchema).max(DESIGN_LIMITS.maxInteractions).optional(),
}

const base = {
  ...roundFiveBase,
  id,
  name: z.string().max(80).optional(),
  margin: padding.optional(),
  hidden: z.boolean().optional(),
  x: coord.optional(),
  y: coord.optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  absolute: z.boolean().optional(),
  anchor: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  constraints: constraintsSchema.optional(),
  responsive: responsiveSchema.optional(),
}

const iconName = z.enum(ICON_NAMES)

const gradientSchema = z.strictObject({
  from: color,
  to: color,
  angle: z.number().finite().min(0).max(360).optional(),
  kind: z.enum(['linear', 'radial']).optional(),
})
const aspect = z.number().finite().min(0.1).max(10)
const blur = px(64)

const imageSrc = z
  .string()
  .refine(isSafeImageSrc, 'An image src is an https URL or a same-origin path like /_asset/…')

const overrideSchema = z
  .strictObject({
    text: z.string().max(2000).optional(),
    label: z.string().min(1).max(80).optional(),
    src: imageSrc.optional(),
    placeholder: z.enum(PLACEHOLDERS).optional(),
    alt: z.string().max(300).optional(),
  })
  .refine((value) => !(value.src !== undefined && value.placeholder !== undefined), 'An override sets src or placeholder, not both')

const frameObject = z.strictObject({
    ...base,
    type: z.literal('frame'),
    layout: z.enum(LAYOUTS),
    gap: px(512).optional(),
    padding: padding.optional(),
    align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
    justify: z.enum(JUSTIFIES).optional(),
    wrap: z.boolean().optional(),
    rowGap: px(512).optional(),
    fillStyle: id.optional(),
    columns: z.number().int().min(1).max(12).optional(),
    w: size.optional(),
    h: size.optional(),
    minW: px(8192).optional(),
    maxW: px(8192).optional(),
    minH: px(8192).optional(),
    maxH: px(8192).optional(),
    grow: z.boolean().optional(),
    fill: color.optional(),
    stroke: color.optional(),
    strokeWidth: px(16).optional(),
    strokePattern: strokePattern.optional(),
    radius: px(999).optional(),
    shadow: z.enum(SHADOWS).optional(),
    clip: z.boolean().optional(),
    linkTo: id.optional(),
    transition: z.enum(TRANSITIONS).optional(),
    gradient: gradientSchema.optional(),
    fillImage: z.strictObject({ src: imageSrc, fit: z.enum(['cover', 'contain']).optional() }).optional(),
    strokeSides: z.array(z.enum(['top', 'right', 'bottom', 'left'])).min(1).max(4).optional(),
    blur: blur.optional(),
    aspect: aspect.optional(),
    component: z.boolean().optional(),
    instanceOf: id.optional(),
    overrides: z
      .record(id, overrideSchema)
      .refine((value) => Object.keys(value).length <= DESIGN_LIMITS.maxOverrides, 'Too many overrides')
      .optional(),
    repeat: z.strictObject({ data: id, limit: z.number().int().min(1).max(DESIGN_LIMITS.maxDataRows).optional() }).optional(),
    children: z.array(z.lazy((): z.ZodType<DesignNode> => nodeSchema)).max(DESIGN_LIMITS.maxChildren),
})
export const frameSchema = frameObject as unknown as z.ZodType<FrameNode>

const textSchema = z.strictObject({
  ...base,
  type: z.literal('text'),
  text: z.string().max(2000),
  style: z.enum(TEXT_STYLES),
  color: color.optional(),
  weight: weightSchema.optional(),
  align: z.enum(['start', 'center', 'end']).optional(),
  maxLines: z.number().int().min(1).max(40).optional(),
  w: size.optional(),
  decoration: z.enum(['underline', 'line-through']).optional(),
  letterSpacing: z.number().finite().min(-10).max(40).optional(),
  lineHeight: z.number().finite().min(0.8).max(3).optional(),
  fontSize: z.number().finite().min(6).max(320).optional(),
  textStyle: id.optional(),
})

const imageSchema = z
  .strictObject({
    ...base,
    type: z.literal('image'),
    src: imageSrc.optional(),
    placeholder: z.enum(PLACEHOLDERS).optional(),
    alt: z.string().max(300),
    w: size.optional(),
    h: size.optional(),
    radius: px(999).optional(),
    fit: z.enum(['cover', 'contain']).optional(),
    aspect: aspect.optional(),
    focus: z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)]).optional(),
    zoom: z.number().finite().min(1).max(4).optional(),
  })
  .refine(
    (node) => (node.src === undefined) !== (node.placeholder === undefined),
    'An image has exactly one of src or placeholder',
  )

const iconSchema = z.strictObject({
  ...base,
  type: z.literal('icon'),
  icon: iconName,
  size: z.number().finite().min(8).max(256).optional(),
  color: color.optional(),
})

const buttonSchema = z.strictObject({
  ...base,
  type: z.literal('button'),
  label: z.string().min(1).max(80),
  variant: z.enum(['primary', 'secondary', 'ghost']),
  size: z.enum(['sm', 'md', 'lg']).optional(),
  icon: iconName.optional(),
  w: size.optional(),
  linkTo: id.optional(),
  transition: z.enum(TRANSITIONS).optional(),
})

const inputSchema = z.strictObject({
  ...base,
  type: z.literal('input'),
  kind: z.enum(['text', 'search', 'select', 'checkbox', 'toggle']),
  label: z.string().max(120).optional(),
  placeholder: z.string().max(120).optional(),
  value: z.string().max(200).optional(),
  checked: z.boolean().optional(),
  w: size.optional(),
})

const dividerSchema = z.strictObject({
  ...base,
  type: z.literal('divider'),
  color: color.optional(),
})

const shapeSchema = z.strictObject({
  ...base,
  type: z.literal('shape'),
  kind: z.enum(SHAPE_KINDS),
  w: size,
  h: size,
  fill: color.optional(),
  stroke: color.optional(),
  radius: px(999).optional(),
  gradient: gradientSchema.optional(),
  blur: blur.optional(),
  aspect: aspect.optional(),
  sides: z.number().int().min(3).max(24).optional(),
  innerRatio: z.number().finite().min(0.1).max(0.95).optional(),
  vertices: z
    .array(z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)]))
    .min(2)
    .max(DESIGN_LIMITS.maxVertices)
    .optional(),
  closed: z.boolean().optional(),
  curves: z
    .array(
      z
        .tuple([z.number().finite().min(-1).max(2), z.number().finite().min(-1).max(2), z.number().finite().min(-1).max(2), z.number().finite().min(-1).max(2)])
        .nullable(),
    )
    .max(DESIGN_LIMITS.maxVertices)
    .optional(),
  strokeWidth: px(32).optional(),
  strokePattern: strokePattern.optional(),
  fillStyle: id.optional(),
})

export const nodeSchema: z.ZodType<DesignNode> = z.discriminatedUnion('type', [
    frameObject,
    textSchema,
    imageSchema,
    iconSchema,
    buttonSchema,
    inputSchema,
    dividerSchema,
    shapeSchema,
  ]) as unknown as z.ZodType<DesignNode>

export const boardSchema: z.ZodType<DesignBoard> = z.strictObject({
  id,
  title: z.string().min(1).max(120),
  x: coord,
  y: coord,
  w: z.number().finite().min(64).max(4096),
  h: z.number().finite().min(64).max(8192),
  background: color.optional(),
  page: id.optional(),
  device: z.enum(['phone', 'tablet']).optional(),
  breakpoints: z
    .array(
      z.strictObject({
        id,
        title: z.string().min(1).max(40),
        w: z.number().finite().min(64).max(4096),
        h: z.number().finite().min(64).max(8192).optional(),
      }),
    )
    .min(1)
    .max(DESIGN_LIMITS.maxBreakpoints)
    .optional(),
  guides: z
    .strictObject({
      x: z.array(coord).max(DESIGN_LIMITS.maxGuides).optional(),
      y: z.array(coord).max(DESIGN_LIMITS.maxGuides).optional(),
    })
    .optional(),
  layoutGrid: z
    .strictObject({ columns: z.number().int().min(1).max(24), gutter: px(256), margin: px(512) })
    .optional(),
  theme: z.enum(['light', 'dark']).optional(),
  fluid: z.boolean().optional(),
  focusOrder: z.array(id).max(DESIGN_LIMITS.maxNodesPerBoard).optional(),
  root: frameSchema,
})

const noteSchema = z.strictObject({
  id,
  x: coord,
  y: coord,
  w: z.number().finite().min(80).max(2000).optional(),
  text: z.string().min(1).max(2000),
  kind: z.enum(['title', 'note']),
  page: id.optional(),
})

export const pageSchema: z.ZodType<DesignPage> = z.strictObject({
  id,
  title: z.string().min(1).max(80),
})

export const designTokensSchema = z.strictObject({
  colors: z
    .record(z.string().regex(TOKEN_NAME, 'Token names are lowercase-kebab'), z.string().regex(HEX, 'A token is a hex colour'))
    .refine((colors) => Object.keys(colors).length <= DESIGN_LIMITS.maxTokens, 'Too many colour tokens'),
  fonts: z.strictObject({ heading: z.enum(FONT_IDS), body: z.enum(FONT_IDS) }).optional(),
  radius: px(64).optional(),
  spacingUnit: z.number().finite().min(2).max(32).optional(),
  spacingScale: z.array(px(512)).min(1).max(DESIGN_LIMITS.maxSpacingScale).optional(),
  themes: z
    .strictObject({
      dark: z
        .record(z.string().regex(TOKEN_NAME, 'Token names are lowercase-kebab'), z.string().regex(HEX, 'A token is a hex colour'))
        .optional(),
    })
    .optional(),
})

export const textStyleDefSchema: z.ZodType<TextStyleDef> = z.strictObject({
  id,
  name: z.string().min(1).max(60),
  style: z.enum(TEXT_STYLES),
  fontSize: z.number().finite().min(6).max(320).optional(),
  weight: weightSchema.optional(),
  lineHeight: z.number().finite().min(0.8).max(3).optional(),
  letterSpacing: z.number().finite().min(-10).max(40).optional(),
  color: color.optional(),
})
export const fillStyleDefSchema: z.ZodType<FillStyleDef> = z.strictObject({
  id,
  name: z.string().min(1).max(60),
  fill: color,
  gradient: gradientSchema.optional(),
})

export const variableSchema: z.ZodType<DesignVariable> = z.strictObject({
  id,
  name: z.string().min(1).max(60),
  type: z.enum(VARIABLE_TYPES),
  value: variableValue,
  options: z.array(z.string().min(1).max(60)).min(1).max(12).optional(),
  board: id.optional(),
})
export const dataListSchema: z.ZodType<DesignDataList> = z.strictObject({
  id,
  name: z.string().min(1).max(60),
  fields: z.array(z.string().regex(FIELD_NAME, 'A field is a camelCase name')).min(1).max(DESIGN_LIMITS.maxDataFields),
  rows: z.array(z.record(z.string().regex(FIELD_NAME), variableValue)).max(DESIGN_LIMITS.maxDataRows),
})
export const systemSchema: z.ZodType<DesignSystemDef> = z.strictObject({
  name: z.string().min(1).max(80),
  version: z.number().int().min(1).max(100_000).optional(),
  description: z.string().max(300).optional(),
  guidelines: z.string().max(DESIGN_LIMITS.maxGuidelines).optional(),
  components: z.array(id).max(200).optional(),
})
const idList = z.array(id).max(400).optional()
export const installedSystemSchema: z.ZodType<InstalledSystem> = z.strictObject({
  id,
  artifactId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  revision: z.number().int().min(0),
  version: z.number().int().min(1).max(100_000).optional(),
  installedAt: z.string().max(40),
  pageId: id.optional(),
  boardId: id.optional(),
  tokens: z.array(z.string().regex(TOKEN_NAME)).max(DESIGN_LIMITS.maxTokens).optional(),
  textStyles: idList,
  fillStyles: idList,
  components: idList,
})
export const linkCardSchema: z.ZodType<DesignLinkCard> = z.strictObject({
  id,
  artifactId: z.string().min(1).max(64),
  kind: z.enum(LINK_KINDS),
  title: z.string().min(1).max(200),
  x: coord,
  y: coord,
  page: id.optional(),
  note: z.string().max(300).optional(),
})

export const designSchema: z.ZodType<Design> = z.strictObject({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  tokens: designTokensSchema.optional(),
  pages: z.array(pageSchema).min(1).max(DESIGN_LIMITS.maxPages).optional(),
  boards: z.array(boardSchema).max(DESIGN_LIMITS.maxBoards),
  notes: z.array(noteSchema).max(DESIGN_LIMITS.maxNotes).optional(),
  styles: z
    .strictObject({
      text: z.array(textStyleDefSchema).max(DESIGN_LIMITS.maxStyles).optional(),
      fills: z.array(fillStyleDefSchema).max(DESIGN_LIMITS.maxStyles).optional(),
    })
    .optional(),
  startBoard: id.optional(),
  variables: z.array(variableSchema).max(DESIGN_LIMITS.maxVariables).optional(),
  data: z.array(dataListSchema).max(DESIGN_LIMITS.maxDataLists).optional(),
  system: systemSchema.optional(),
  installedSystems: z.array(installedSystemSchema).max(DESIGN_LIMITS.maxInstalledSystems).optional(),
  links: z.array(linkCardSchema).max(DESIGN_LIMITS.maxLinks).optional(),
})

export type DesignValidation = { ok: true; design: Design } | { ok: false; errors: string[] }

/** Depth of raw JSON, stopping early: a pathological body must not reach the recursive parse. */
function rawDepthExceeds(value: unknown, limit: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const item = stack.pop()!
    if (item.depth > limit) return true
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value as Record<string, unknown>)) {
        if (child && typeof child === 'object') stack.push({ value: child, depth: item.depth + 1 })
      }
    }
  }
  return false
}

const COLOR_KEYS = ['fill', 'stroke', 'color', 'background'] as const

/** Every main component (a frame with `component: true`) on any board, by id. */
export function collectMains(boards: DesignBoard[]): Map<string, FrameNode> {
  const mains = new Map<string, FrameNode>()
  for (const board of boards) {
    const stack: DesignNode[] = [board.root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.type !== 'frame') continue
      if (node.component && !mains.has(node.id)) mains.set(node.id, node)
      stack.push(...node.children)
    }
  }
  return mains
}

/** The main components an instance inside `main` (at any depth) points at. */
function referencedMains(main: FrameNode): string[] {
  const out: string[] = []
  const stack: DesignNode[] = [...main.children]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type !== 'frame') continue
    if (node.instanceOf !== undefined) out.push(node.instanceOf)
    stack.push(...node.children)
  }
  return out
}

/** A main component that (through instances) contains itself, or null. */
export function componentCycle(mains: Map<string, FrameNode>): string | null {
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): string | null => {
    const seen = state.get(id)
    if (seen === 2) return null
    if (seen === 1) return id
    const main = mains.get(id)
    if (!main) return null
    state.set(id, 1)
    for (const next of referencedMains(main)) {
      const found = visit(next)
      if (found) return found
    }
    state.set(id, 2)
    return null
  }
  for (const id of mains.keys()) {
    const found = visit(id)
    if (found) return found
  }
  return null
}

/** A value's fit with its variable's type, or why not. */
export function variableValueProblem(variable: DesignVariable, value: VariableValue, tokens: Record<string, string>): string | null {
  switch (variable.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'a boolean variable takes true or false'
    case 'number':
      return typeof value === 'number' ? null : 'a number variable takes a number'
    case 'text':
      return typeof value === 'string' ? null : 'a text variable takes a string'
    case 'color':
      return typeof value === 'string' && (HEX.test(value) || value === 'transparent' || Object.hasOwn(tokens, value))
        ? null
        : 'a colour variable takes a hex or a colour token name'
    case 'choice':
      if (!variable.options?.length) return 'a choice variable lists its "options"'
      return typeof value === 'string' && variable.options.includes(value) ? null : `the value is one of ${variable.options.join(', ')}`
  }
}

function findInBoards(boards: DesignBoard[], nodeId: string): DesignNode | null {
  for (const board of boards) {
    const stack: DesignNode[] = [board.root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.id === nodeId) return node
      if (node.type === 'frame') stack.push(...node.children)
    }
  }
  return null
}

/**
 * Nodes drawn for `node` once instances expand (and, given the data lists, repeats: a repeat
 * frame draws its children once per row). Callers rule out cycles first.
 */
export function expandedCount(
  node: DesignNode,
  mains: Map<string, FrameNode>,
  memo = new Map<string, number>(),
  data?: ReadonlyMap<string, DesignDataList>,
): number {
  if (node.type !== 'frame') return 1
  if (node.repeat && node.instanceOf === undefined) {
    const list = data?.get(node.repeat.data)
    const rows = list ? Math.min(list.rows.length, node.repeat.limit ?? DESIGN_LIMITS.maxDataRows) : 1
    let inner = 0
    for (const child of node.children) inner += expandedCount(child, mains, memo, data)
    return 1 + inner * rows
  }
  if (node.instanceOf !== undefined) {
    const main = mains.get(node.instanceOf)
    if (!main) return 1
    const cached = memo.get(main.id)
    if (cached !== undefined) return cached
    const count = expandedCount({ ...main, instanceOf: undefined }, mains, memo, data)
    memo.set(main.id, count)
    return count
  }
  let count = 1
  for (const child of node.children) count += expandedCount(child, mains, memo, data)
  return count
}

/**
 * The one check a design body passes before it is stored or shown: the structural schema, then
 * the rules across the tree (unique ids, depth and node caps, colours naming declared tokens,
 * links naming boards, the 1 MB cap).
 */
export function validateDesign(value: unknown): DesignValidation {
  // Each node level is about four JSON levels (node, children array, the next node, tuples).
  if (rawDepthExceeds(value, DESIGN_LIMITS.maxDepth * 3 + 8)) {
    return { ok: false, errors: [`The design nests deeper than ${DESIGN_LIMITS.maxDepth} levels`] }
  }
  const parsed = designSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || 'design'}: ${issue.message}`),
    }
  }
  const design = parsed.data
  const errors: string[] = []
  const ids = new Set<string>()
  const tokens = design.tokens?.colors ?? {}
  const boardIds = new Set(design.boards.map((board) => board.id))
  const claim = (value: string, where: string) => {
    if (ids.has(value)) errors.push(`${where}: duplicate id "${value}"`)
    ids.add(value)
  }
  const checkColor = (value: string | undefined, where: string) => {
    if (value === undefined || HEX.test(value) || value === 'transparent') return
    if (!Object.hasOwn(tokens, value)) errors.push(`${where}: "${value}" is not a colour token`)
  }
  // Pages: ids join the one id space; a board or note names a declared page or none.
  const pageIds = new Set<string>()
  for (const page of design.pages ?? []) {
    claim(page.id, `page ${page.id}`)
    pageIds.add(page.id)
  }
  const checkPage = (value: string | undefined, where: string) => {
    if (value === undefined) return
    if (!design.pages) errors.push(`${where}.page: "${value}" names a page but the design declares no pages`)
    else if (!pageIds.has(value)) errors.push(`${where}.page: no page "${value}"`)
  }
  // Shared styles: ids unique within their kind, colours naming declared tokens.
  const textStyles = new Set<string>()
  const fillStyles = new Set<string>()
  for (const style of design.styles?.text ?? []) {
    if (textStyles.has(style.id)) errors.push(`styles.text: duplicate id "${style.id}"`)
    textStyles.add(style.id)
    checkColor(style.color, `text style ${style.id}.color`)
  }
  for (const style of design.styles?.fills ?? []) {
    if (fillStyles.has(style.id)) errors.push(`styles.fills: duplicate id "${style.id}"`)
    fillStyles.add(style.id)
    checkColor(style.fill, `fill style ${style.id}.fill`)
    if (style.gradient) {
      checkColor(style.gradient.from, `fill style ${style.id}.gradient.from`)
      checkColor(style.gradient.to, `fill style ${style.id}.gradient.to`)
    }
  }
  if (design.startBoard !== undefined && !boardIds.has(design.startBoard)) {
    errors.push(`startBoard: no board "${design.startBoard}"`)
  }
  // Round 5: variables, data lists, theme values (each its own id space).
  const variables = new Map<string, DesignVariable>()
  for (const variable of design.variables ?? []) {
    if (variables.has(variable.id)) errors.push(`variables: duplicate id "${variable.id}"`)
    variables.set(variable.id, variable)
    const problem = variableValueProblem(variable, variable.value, tokens)
    if (problem) errors.push(`variable ${variable.id}: ${problem}`)
    if (variable.board !== undefined && !boardIds.has(variable.board)) errors.push(`variable ${variable.id}.board: no board "${variable.board}"`)
  }
  const dataLists = new Map<string, DesignDataList>()
  for (const list of design.data ?? []) {
    if (dataLists.has(list.id)) errors.push(`data: duplicate id "${list.id}"`)
    dataLists.set(list.id, list)
    const fields = new Set(list.fields)
    if (fields.size !== list.fields.length) errors.push(`data ${list.id}.fields: a field is listed twice`)
    list.rows.forEach((row, index) => {
      for (const key of Object.keys(row)) if (!fields.has(key)) errors.push(`data ${list.id}.rows.${index}: "${key}" is not one of its fields`)
    })
  }
  for (const name of Object.keys(design.tokens?.themes?.dark ?? {})) {
    if (!Object.hasOwn(tokens, name)) errors.push(`tokens.themes.dark: "${name}" is not a colour token`)
  }
  /** Node ids an interaction names, checked once every node is known. */
  const nodeTargets: Array<{ id: string; where: string; instance?: { main: unknown } }> = []
  const mains = collectMains(design.boards)
  let total = 0
  for (const board of design.boards) {
    claim(board.id, `board ${board.id}`)
    checkColor(board.background, `board ${board.id}.background`)
    checkPage(board.page, `board ${board.id}`)
    const breakpointIds = new Set<string>()
    for (const breakpoint of board.breakpoints ?? []) {
      if (breakpointIds.has(breakpoint.id)) errors.push(`board ${board.id}.breakpoints: duplicate id "${breakpoint.id}"`)
      breakpointIds.add(breakpoint.id)
    }
    let inBoard = 0
    const boardNodeIds = new Set<string>()
    /** The data lists of the repeats around the node, innermost last. */
    const repeats: DesignDataList[] = []
    let inMain = 0
    const walk = (node: DesignNode, depth: number) => {
      inBoard += 1
      boardNodeIds.add(node.id)
      if (depth > DESIGN_LIMITS.maxDepth) {
        errors.push(`board ${board.id}: node "${node.id}" is deeper than ${DESIGN_LIMITS.maxDepth} levels`)
        return
      }
      claim(node.id, `board ${board.id}`)
      const record = node as Record<string, unknown>
      for (const key of COLOR_KEYS) {
        const colorValue = record[key]
        if (typeof colorValue === 'string') checkColor(colorValue, `node ${node.id}.${key}`)
      }
      if ((node.type === 'frame' || node.type === 'shape') && node.gradient) {
        checkColor(node.gradient.from, `node ${node.id}.gradient.from`)
        checkColor(node.gradient.to, `node ${node.id}.gradient.to`)
      }
      if ((node.type === 'frame' || node.type === 'button') && node.linkTo !== undefined) {
        if (!boardIds.has(node.linkTo)) errors.push(`node ${node.id}.linkTo: no board "${node.linkTo}"`)
      }
      if (node.type === 'text' && node.textStyle !== undefined && !textStyles.has(node.textStyle)) {
        errors.push(`node ${node.id}.textStyle: no text style "${node.textStyle}"`)
      }
      if ((node.type === 'frame' || node.type === 'shape') && node.fillStyle !== undefined && !fillStyles.has(node.fillStyle)) {
        errors.push(`node ${node.id}.fillStyle: no fill style "${node.fillStyle}"`)
      }
      if (node.type === 'shape' && node.kind === 'path' && (node.vertices?.length ?? 0) < 2) {
        errors.push(`node ${node.id}: a path shape needs "vertices" (at least 2 points)`)
      }
      if (node.showIf && !variables.has(node.showIf.variable)) errors.push(`node ${node.id}.showIf: no variable "${node.showIf.variable}"`)
      for (const [key, ref] of Object.entries(node.bind ?? {})) {
        if (ref === undefined) continue
        if (ref.startsWith('item.')) {
          const field = ref.slice(5)
          const list = repeats.at(-1)
          // Inside a main component the row comes from wherever its instances repeat.
          if (!list && inMain > 0) continue
          if (!list) errors.push(`node ${node.id}.bind.${key}: "${ref}" is only meaningful inside a repeat`)
          else if (!list.fields.includes(field)) errors.push(`node ${node.id}.bind.${key}: data list "${list.id}" has no field "${field}"`)
        } else if (!variables.has(ref)) errors.push(`node ${node.id}.bind.${key}: no variable "${ref}"`)
      }
      for (const [index, interaction] of (node.interactions ?? []).entries()) {
        const where = `node ${node.id}.interactions.${index}`
        const { action, target } = interaction
        if (action === 'back' || action === 'closeOverlay') continue
        if (target === undefined) {
          errors.push(`${where}: "${action}" needs a target`)
          continue
        }
        if (action === 'navigate' || action === 'overlay') {
          if (!boardIds.has(target)) errors.push(`${where}.target: no board "${target}"`)
        } else if (action === 'setVariable') {
          const variable = variables.get(target)
          if (!variable) errors.push(`${where}.target: no variable "${target}"`)
          else if (interaction.value !== undefined) {
            const problem = variableValueProblem(variable, interaction.value, tokens)
            if (problem) errors.push(`${where}.value: ${problem}`)
          } else if (variable.type !== 'boolean') errors.push(`${where}: setVariable without a value only toggles a boolean variable`)
        } else if (action === 'setVariant') {
          if (typeof interaction.value !== 'string' || !mains.has(interaction.value)) errors.push(`${where}.value: setVariant names a main component id`)
          nodeTargets.push({ id: target, where: `${where}.target`, instance: { main: interaction.value } })
        } else nodeTargets.push({ id: target, where: `${where}.target` })
      }
      let repeated: DesignDataList | undefined
      if (node.type === 'frame' && node.repeat) {
        repeated = dataLists.get(node.repeat.data)
        if (!repeated) errors.push(`node ${node.id}.repeat: no data list "${node.repeat.data}"`)
        if (node.instanceOf !== undefined) errors.push(`node ${node.id}: an instance cannot repeat (repeat a frame holding it)`)
      }
      if (node.type === 'frame') {
        if (node.minW !== undefined && node.maxW !== undefined && node.minW > node.maxW) errors.push(`node ${node.id}: minW ${node.minW} is more than maxW ${node.maxW}`)
        if (node.minH !== undefined && node.maxH !== undefined && node.minH > node.maxH) errors.push(`node ${node.id}: minH ${node.minH} is more than maxH ${node.maxH}`)
        if (node.component && node.instanceOf !== undefined) {
          errors.push(`node ${node.id}: a frame is a main component or an instance, not both`)
        }
        if (node.instanceOf !== undefined) {
          if (node.children.length > 0) errors.push(`node ${node.id}: an instance has no children of its own (its main's are drawn)`)
          if (!mains.has(node.instanceOf)) {
            errors.push(`node ${node.id}.instanceOf: no main component "${node.instanceOf}" (mark a frame with "component": true)`)
          }
        } else if (node.overrides !== undefined) {
          errors.push(`node ${node.id}.overrides: only an instance has overrides`)
        }
        if (repeated) repeats.push(repeated)
        if (node.component) inMain += 1
        for (const child of node.children) walk(child, depth + 1)
        if (node.component) inMain -= 1
        if (repeated) repeats.pop()
      }
    }
    walk(board.root, 1)
    for (const focusId of board.focusOrder ?? []) {
      if (!boardNodeIds.has(focusId)) errors.push(`board ${board.id}.focusOrder: no node "${focusId}" on the board`)
    }
    total += inBoard
    if (inBoard > DESIGN_LIMITS.maxNodesPerBoard) {
      errors.push(`board ${board.id}: ${inBoard} nodes (limit ${DESIGN_LIMITS.maxNodesPerBoard})`)
    }
  }
  if (total > DESIGN_LIMITS.maxNodes) errors.push(`${total} nodes (limit ${DESIGN_LIMITS.maxNodes})`)
  const cycle = componentCycle(mains)
  if (cycle) errors.push(`component "${cycle}" contains an instance of itself (directly or through another component)`)
  else if (errors.length === 0) {
    for (const board of design.boards) {
      const drawn = expandedCount(board.root, mains, new Map(), dataLists)
      if (drawn > DESIGN_LIMITS.maxExpandedNodesPerBoard) {
        errors.push(`board ${board.id}: draws ${drawn} nodes once instances expand (limit ${DESIGN_LIMITS.maxExpandedNodesPerBoard})`)
      }
    }
  }
  for (const note of design.notes ?? []) {
    claim(note.id, `note ${note.id}`)
    checkPage(note.page, `note ${note.id}`)
  }
  for (const link of design.links ?? []) {
    claim(link.id, `link ${link.id}`)
    checkPage(link.page, `link ${link.id}`)
  }
  for (const target of nodeTargets) {
    if (!ids.has(target.id) || boardIds.has(target.id) || pageIds.has(target.id)) {
      errors.push(`${target.where}: no node "${target.id}"`)
      continue
    }
    if (target.instance) {
      const hit = findInBoards(design.boards, target.id)
      if (!hit || hit.type !== 'frame' || hit.instanceOf === undefined) errors.push(`${target.where}: "${target.id}" is not a component instance`)
    }
  }
  for (const mainId of design.system?.components ?? []) {
    if (!mains.has(mainId)) errors.push(`system.components: "${mainId}" is not a main component`)
  }
  const installedIds = new Set<string>()
  for (const entry of design.installedSystems ?? []) {
    if (installedIds.has(entry.id)) errors.push(`installedSystems: duplicate id "${entry.id}"`)
    installedIds.add(entry.id)
    if (entry.pageId !== undefined && !pageIds.has(entry.pageId)) errors.push(`installedSystems ${entry.id}.pageId: no page "${entry.pageId}"`)
    if (entry.boardId !== undefined && !boardIds.has(entry.boardId)) errors.push(`installedSystems ${entry.id}.boardId: no board "${entry.boardId}"`)
  }
  const bytes = new TextEncoder().encode(JSON.stringify(design)).length
  if (bytes > DESIGN_LIMITS.maxBytes) errors.push(`The design is ${bytes} bytes (limit 1 MB)`)
  return errors.length > 0 ? { ok: false, errors: errors.slice(0, 12) } : { ok: true, design }
}

/** The `ArtifactKindSpec.validate` shape: null when the body is a valid design, else why not. */
export function validateDesignBody(body: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return 'The body is not valid JSON'
  }
  const result = validateDesign(value)
  return result.ok ? null : `Invalid design: ${result.errors.join('; ')}`
}

export function emptyDesign(title = 'Untitled design'): Design {
  return {
    version: 1,
    title,
    tokens: {
      colors: {
        background: '#ffffff',
        surface: '#f8fafc',
        text: '#0f172a',
        muted: '#64748b',
        border: '#e2e8f0',
        primary: '#2563eb',
        'on-primary': '#ffffff',
      },
      fonts: { heading: 'system', body: 'system' },
      radius: 8,
      spacingUnit: 8,
    },
    boards: [],
  }
}

/** One line for lists and tool results. */
export function summariseDesign(design: Design): string {
  const boards = design.boards.length
  const names = design.boards
    .slice(0, 3)
    .map((board) => board.title)
    .join(', ')
  return `${boards} board${boards === 1 ? '' : 's'}${names ? `: ${names}${boards > 3 ? ', …' : ''}` : ''}`
}

// ---- the agent's reference

/**
 * The guide's worked example: one landing-page hero as a desktop and a phone board, built the way
 * the guide advises (tokens for every colour, stacks for layout, real copy, a placeholder for the
 * product shot). A test keeps it valid.
 */
export const DESIGN_EXAMPLE: Design = {
  version: 1,
  title: 'Ledgerly landing',
  tokens: {
    colors: {
      background: '#ffffff',
      surface: '#f6f7f9',
      text: '#111827',
      muted: '#6b7280',
      border: '#e5e7eb',
      primary: '#0f766e',
      'on-primary': '#ffffff',
    },
    fonts: { heading: 'geometric', body: 'system' },
    radius: 10,
    spacingUnit: 8,
  },
  boards: [
    {
      id: 'desktop',
      title: 'Landing — Desktop',
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
      background: 'background',
      root: {
        type: 'frame',
        id: 'd-root',
        layout: 'stack-v',
        w: 'fill',
        children: [
          {
            type: 'frame', id: 'd-nav', name: 'Nav', layout: 'stack-h', w: 'fill', padding: [24, 120],
            justify: 'between', align: 'center',
            children: [
              { type: 'text', id: 'd-logo', text: 'Ledgerly', style: 'h3' },
              {
                type: 'frame', id: 'd-links', layout: 'stack-h', gap: 32, align: 'center',
                children: [
                  { type: 'text', id: 'd-link-product', text: 'Product', style: 'small', color: 'muted' },
                  { type: 'text', id: 'd-link-pricing', text: 'Pricing', style: 'small', color: 'muted' },
                  { type: 'button', id: 'd-signin', label: 'Sign in', variant: 'secondary', size: 'sm' },
                ],
              },
            ],
          },
          {
            type: 'frame', id: 'd-hero', name: 'Hero', layout: 'stack-h', w: 'fill', padding: [96, 120],
            gap: 64, align: 'center',
            children: [
              {
                type: 'frame', id: 'd-copy', layout: 'stack-v', gap: 24, w: 560,
                children: [
                  { type: 'text', id: 'd-eyebrow', text: 'FOR SMALL STUDIOS', style: 'caption', color: 'primary' },
                  { type: 'text', id: 'd-headline', text: 'Get paid on time, without the follow-up emails', style: 'display' },
                  {
                    type: 'text', id: 'd-lede', style: 'body', color: 'muted', w: 480,
                    text: 'Ledgerly sends polite reminders, takes card payments and matches every payment to your books.',
                  },
                  {
                    type: 'frame', id: 'd-ctas', layout: 'stack-h', gap: 12,
                    children: [
                      { type: 'button', id: 'd-cta', label: 'Start free trial', variant: 'primary', size: 'lg', icon: 'arrow-right' },
                      { type: 'button', id: 'd-tour', label: 'See how it works', variant: 'ghost', size: 'lg' },
                    ],
                  },
                ],
              },
              { type: 'image', id: 'd-shot', placeholder: 'chart', alt: 'Paid and overdue invoices this month', w: 'fill', h: 480, radius: 16 },
            ],
          },
        ],
      },
    },
    {
      id: 'phone',
      title: 'Landing — Phone',
      x: 1560,
      y: 0,
      w: 390,
      h: 844,
      background: 'background',
      root: {
        type: 'frame',
        id: 'p-root',
        layout: 'stack-v',
        w: 'fill',
        children: [
          {
            type: 'frame', id: 'p-nav', name: 'Nav', layout: 'stack-h', w: 'fill', padding: [16, 24],
            justify: 'between', align: 'center',
            children: [
              { type: 'text', id: 'p-logo', text: 'Ledgerly', style: 'h3' },
              { type: 'icon', id: 'p-menu', icon: 'menu', size: 24, color: 'text' },
            ],
          },
          {
            type: 'frame', id: 'p-hero', name: 'Hero', layout: 'stack-v', w: 'fill', padding: [48, 24], gap: 20,
            children: [
              { type: 'text', id: 'p-eyebrow', text: 'FOR SMALL STUDIOS', style: 'caption', color: 'primary' },
              { type: 'text', id: 'p-headline', text: 'Get paid on time, without the follow-up emails', style: 'h1' },
              {
                type: 'text', id: 'p-lede', style: 'body', color: 'muted',
                text: 'Polite reminders, card payments and books that match, on autopilot.',
              },
              { type: 'button', id: 'p-cta', label: 'Start free trial', variant: 'primary', size: 'lg', w: 'fill' },
              { type: 'image', id: 'p-shot', placeholder: 'chart', alt: 'Paid and overdue invoices this month', w: 'fill', h: 240, radius: 12 },
            ],
          },
        ],
      },
    },
  ],
  notes: [{ id: 'n-title', x: 0, y: -120, text: 'Landing page — hero, desktop and phone', kind: 'title' }],
}

/**
 * The full authoring reference `artifact_guide {kind: "design"}` returns: the model in the doc
 * comment at the top of this file, the rules that make a design look designed, and the edit ops.
 */
/** The built-in library's ids, for the guide (design-library.ts owns the entries; a test keeps these equal). */
export const DESIGN_LIBRARY_IDS = [
  'navbar', 'tab-bar', 'footer', 'hero-centered', 'hero-split', 'feature-cards', 'pricing', 'signup-form',
  'dashboard-shell', 'auth-signin', 'settings-page', 'data-table', 'empty-state', 'modal', 'toast',
] as const
const LIBRARY_IDS_FOR_GUIDE = DESIGN_LIBRARY_IDS.join(', ')

export const DESIGN_GUIDE = `Design (kind "design"): mockups, landing pages, app screens, wireframes, posters and social posts as ONE JSON object of artboards ("boards"). Declarative data drawn by Freebuff's renderer: no HTML, CSS or script. Every object is strict (an unknown key is refused).

{ "version": 1, "title": "..." (1-200), "tokens"?: Tokens, "styles"?: Styles, "pages"?: [Page, ...] (1-${DESIGN_LIMITS.maxPages}), "boards": [Board, ...] (<= ${DESIGN_LIMITS.maxBoards}), "notes"?: [Note, ...] (<= ${DESIGN_LIMITS.maxNotes}), "startBoard"?: board id (where Present and the prototype start; default the first board), "variables"?, "data"?, "system"?, "installedSystems"?, "links"? (round 5, below) }
Tokens: { "colors": { "<name>": "#rrggbb" } (<= ${DESIGN_LIMITS.maxTokens}; names lowercase-kebab), "fonts"?: { "heading": FontId, "body": FontId }, "radius"?: px (buttons and inputs, default 8), "spacingUnit"?: px (default 8) }
  FontId: ${FONT_IDS.join(', ')}. The renderer's defaults read these colour names: background, surface, text, muted, border, primary, on-primary.
Styles (shared, applied by reference; editing one restyles every user): { "text"?: [{ "id", "name", "style": TextStyle, "fontSize"?, "weight"?, "lineHeight"?, "letterSpacing"?, "color"? }], "fills"?: [{ "id", "name", "fill": colour, "gradient"?: Gradient }] } (<= ${DESIGN_LIMITS.maxStyles} each). A text node applies one with "textStyle": "<id>", a frame or shape with "fillStyle": "<id>"; the style's fields win over the node's own.
Board: { "id", "title" (1-120), "x", "y", "w" (64-4096), "h" (64-8192), "background"?: colour, "page"?: page id, "device"?: "phone" | "tablet" (a bezel around the board on the canvas and in Present; never exported), "breakpoints"?: [{ "id", "title", "w", "h"? }] (<= ${DESIGN_LIMITS.maxBreakpoints}; more widths this board designs for, e.g. {"id":"mobile","title":"Mobile","w":390,"h":844}), "guides"?: { "x"?: [px], "y"?: [px] } (ruler guides, editor only), "layoutGrid"?: { "columns", "gutter", "margin" } (a column grid drawn in the editor only), "root": a frame that fills the board }
  Responsive: with "breakpoints", any node may carry "responsive": { "<breakpoint id>": { "hidden"?, "x"?, "y"?, "w"?, "h"?, "layout"?, "gap"?, "padding"?, "columns"?, "align"?, "justify"?, "wrap"?, "style"?, "fontSize"?, "weight"?, "size"? } }: at that width the board is drawn at the breakpoint's size with those values (keys a node type lacks are ignored). Breakpoints are drawn in the editor (its width switcher), checked by Checks and used by code export; a share link, its Present and the thumbnails draw every board at its base size only. So a phone layout the user will see or share is its own phone board (below); add a breakpoint when they ask for one responsive board or for code.
  Constraints: a child of an absolute frame may carry "constraints": { "h"?: left|right|leftRight|center|scale, "v"?: top|bottom|topBottom|center|scale } (default left/top): how it follows when the frame or board resizes, and across breakpoints (a badge pinned "right"/"bottom", a header bar "leftRight").
Note: { "id", "x", "y", "w"?, "text", "kind": "title" | "note", "page"?: page id } — canvas labels outside boards (a "title" above a row of boards).
Page: { "id", "title" (1-80) } — each page is its own canvas (e.g. "Marketing site", "App flows", "Components"). No "pages" means one page; a board or note without "page" sits on the first page. Only name a page that "pages" declares. Board x/y are per page: each page's boards start near (0, 0).
A colour field takes a token name (preferred), a hex ("#0f172a", "#fff", "#0f172a80") or "transparent". A token name must be declared in tokens.colors.
Ids are unique across the whole design (boards, nodes and notes): 1-64 letters, digits, - or _, starting with a letter or digit. Prefix them per board ("d-hero", "p-hero").

Nodes (every node: "id", "name"? (layers label), "hidden"?, "opacity"? (0-1), and "x"/"y" only inside an absolute frame or when pinned):
  Pinned: "absolute": true takes a node out of its stack or grid's flow and places it "x"/"y" px from the parent's "anchor" corner (top-left | top-right | bottom-left | bottom-right; default top-left): a badge on a card, a close button on a modal. The parent keeps its layout.
- frame: { "layout": "stack-v" | "stack-h" | "grid" | "absolute", "children": [...] (<= ${DESIGN_LIMITS.maxChildren}), "gap"?, "padding"?: n | [vertical, horizontal] | [top, right, bottom, left], "align"?: start|center|end|stretch (cross axis), "justify"?: start|center|end|between|around|evenly (main axis), "wrap"?, "rowGap"? (the gap between wrapped rows), "columns"? (grid, 1-12 equal tracks), "w"?, "h"?, "minW"?/"maxW"?/"minH"?/"maxH"?: px bounds on a fill or hug size (a "fill" column capped at maxW 720 stays readable on a wide board), "grow"?, "fill"?, "stroke"?, "strokeWidth"?, "radius"?, "shadow"?: none|sm|md|lg|xl|inner, "clip"?, "linkTo"?: board id, "gradient"?: Gradient, "fillImage"?: { "src", "fit"?: cover|contain }, "strokeSides"?: ["top"|"right"|"bottom"|"left", ...] (default all), "blur"?: px (layer blur, 0-64), "aspect"?: width/height (0.1-10, e.g. 1.7778 for 16:9; the free axis follows), "component"?: true, "instanceOf"?: main id, "overrides"?: {...}, "fillStyle"? }
  Gradient: { "from": colour, "to": colour, "angle"?: degrees (180 = top to bottom, the default) }, drawn over "fill". fillImage is drawn over both; its src is an "/_asset/<id>" like an image's (an https one never loads on a share link), and keep a fill colour under it.
- text: { "text" (<= 2000), "style": ${TEXT_STYLES.join('|')}, "color"?, "weight"?: 400|500|600|700|800, "align"?: start|center|end, "maxLines"?, "w"?, "decoration"?: underline|line-through, "letterSpacing"?: px added to the style's (-10-40), "lineHeight"?: multiple of the size (0.8-3), "fontSize"?: px replacing the style's size, "textStyle"?: shared text style id }
  Sizes: display 64, h1 44, h2 32, h3 20, body 16, small 14, caption 12 (semibold, spaced; write it in capitals), mono 14. Headings use tokens.fonts.heading.
- image: { "src": "/_asset/<id>" | "placeholder": ${PLACEHOLDERS.join('|')} (exactly one), "alt", "w"?, "h"?, "radius"?, "fit"?: cover|contain, "aspect"?, "focus"?: [x, y] (0-1, the point kept in view when cropped), "zoom"?: 1-4 (crop by zooming in) }. Prefer placeholders: they always render and export. For a real picture from the web, call import_artifact_image first and use the "/_asset/<id>" ref it returns (read_artifact lists the design's assets); never hotlink an https:// URL: readers see a placeholder instead of it, and Checks flags it.
- icon: { "icon": one of ${ICON_NAMES.join(', ')}; "size"?, "color"? }
- button: { "label" (1-80), "variant": primary|secondary|ghost, "size"?: sm|md|lg, "icon"?, "w"?, "linkTo"? } (an arrow-* or chevron-* icon sits after the label, others before it)
- input: { "kind": text|search|select|checkbox|toggle, "label"?, "placeholder"?, "value"?, "checked"?, "w"? } (drawn in the editor; in Present it works: fields take typing, toggles toggle, a select offers the options of the choice variable its "bind.value" names)
- divider: { "color"? } (a 1px rule)
- shape: { "kind": rect|ellipse|line|arrow|polygon|star|path, "w", "h", "fill"?, "stroke"?, "strokeWidth"?, "radius"?, "gradient"?, "blur"?, "aspect"?, "fillStyle"? }. Vectors: polygon "sides" (3-24, default 6); star "sides" (points, default 5) and "innerRatio" (0.1-0.95); path "vertices": [[x, y], ...] (2-${DESIGN_LIMITS.maxVertices} points as 0-1 shares of the w×h box) and "closed"? (filled when closed, else a stroked line); arrow points left to right across its box.
w/h are px, "fill" (take the parent's remaining space) or "hug" (fit content, the default). linkTo makes a click-through prototype in Present; with it, "transition"?: ${TRANSITIONS.join('|')} (default instant) on a frame or button sets how Present moves there (slide-left for forward in a flow, slide-right for back, slide-up for a sheet or modal, dissolve for a tab switch).

Components (reuse one design across boards):
- A MAIN component is a frame with "component": true (its "name" is the component's name), on any board or page; a "Components" page is a good home for them.
- An INSTANCE is a frame with "instanceOf": "<main id>" and "children": [] (layout is ignored; give the main's): it draws the main, so editing the main updates every instance. The instance keeps its own x/y/w/h/grow/hidden/name/linkTo.
- "overrides": { "<node id inside the main>": { "text"?, "label"?, "src"?, "placeholder"?, "alt"? } } changes content only: a text's text, a button's label, an image's src/placeholder/alt. Styling comes from the main. An override for a node the main no longer has is ignored.
- A main cannot contain an instance of itself (directly or through another component). Removing a main detaches its instances (they become plain frames with the overrides baked in).
- Variants: name mains "<Group> / <Variant>" ("Button / Primary", "Button / Secondary", "Card / Compact") and keep their inner layer names alike; swapInstance moves an instance between them and its overrides follow by node id, then layer name, then position.
- Built-in library (insert with insertComponent "library"; plain nodes with fresh ids, phone variant on boards under 600 wide): ${LIBRARY_IDS_FOR_GUIDE}.
Limits: depth ${DESIGN_LIMITS.maxDepth}, ${DESIGN_LIMITS.maxNodesPerBoard} nodes per board, ${DESIGN_LIMITS.maxNodes} in all, ${DESIGN_LIMITS.maxExpandedNodesPerBoard} drawn per board once instances expand, 1 MB of JSON.

Make it look designed:
- Spacing: only multiples of the spacing unit, from the scale 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Small gaps inside a group (8-16), larger between groups (24-48), largest between sections (64-128). Desktop sections pad [96, 120], phone [48, 24]. Generous white space beats borders.
- Type: one display or h1 per screen, then h2 for sections, h3 for card titles, body for copy, small/caption for meta. At most three sizes in one block. Cap line length with w (480-640 for body copy on desktop); never break lines by hand. Use muted for secondary text, not a smaller size alone.
- Colour: a restrained palette in tokens — neutrals (background, surface, text, muted, border), ONE brand primary with on-primary, at most one accent. Every colour field names a token. Surfaces (cards) are surface or background with a border token or a sm shadow, not both heavy. Check contrast: text on primary uses on-primary.
- Layout: a page is a stack-v root of full-width sections (w "fill"), each with a centred inner column. Card rows are a grid (columns 3 on desktop, 1 on phone; gap 24). absolute only for free compositions (posters, overlapping badges).
- Hierarchy: one primary button per view; secondary or ghost for the rest. Align edges: siblings share a left edge or a centre line.
- Accessibility (the editor's Checks tab flags these, and the user can ask you to fix them): text contrast at least 4.5:1 against its fill (3:1 at 24px+ or bold 18.66px+), so muted text on surface must still pass; buttons on phone boards size md or lg (40px+ tall); real images get alt text.
- Copy: real, specific copy for the product the user described: a concrete headline, a one-sentence lede, real feature names, plausible numbers and names. Never lorem ipsum, "Feature 1" or "Title here".
- Responsive: for a website or landing page make ONE desktop board (1440 wide) with a "mobile" breakpoint (390x844) and "responsive" overrides (see Board above); use a separate phone board only when the phone screen's content really differs. On phone, stack-h rows become stack-v, grids go to 1 column, display becomes h1, buttons go w "fill". Mark a web page "fluid": true so Present reflows it to the viewer's width. Other sizes: tablet 768x1024, poster 1080x1350, social square 1080x1080; a long page is one tall board (1440 x 3200 is fine). An app flow is a row of phone boards linked with linkTo.

Example (one hero, desktop and phone, as two boards for brevity; prefer a breakpoint as above): ${JSON.stringify(DESIGN_EXAMPLE)}

Round 5 (all optional; declarative, validated and capped — no code anywhere):
- Variables (levers, the design's "data-props"): "variables": [{ "id", "name", "type": ${VARIABLE_TYPES.join('|')}, "value", "options"? (choice), "board"? (a per-board lever) }] (<= ${DESIGN_LIMITS.maxVariables}). The user moves them in the Props tab.
- Holes: "{{<variable id>}}" in any text, label, placeholder, value or alt is filled with the variable's value; "{{item.<field>}}" with the current repeat row's field. An unknown name stays as written.
- showIf on any node: { "variable", "equals"?, "not"? } — drawn only while it matches (truthy without equals).
- bind on any node: { "text"|"label"|"src"|"alt"|"fill"|"color"|"checked"|"value"|"placeholder": "<variable id>" | "item.<field>" } — the field takes that value. A toggle with "bind": {"checked": "<boolean var>"} drives every showIf on it in Present.
- Data lists: "data": [{ "id", "name", "fields": ["name", "role"], "rows": [{ "name": "Ada", "role": "Eng" }, ...] (<= ${DESIGN_LIMITS.maxDataRows}) }] (<= ${DESIGN_LIMITS.maxDataLists}). A frame with "repeat": { "data": "<list id>", "limit"? } draws its children once per row (cards, table rows, feeds); write the children once, with item holes or bindings.
- Interactions on any node: "interactions": [{ "action": ${INTERACTION_ACTIONS.join('|')}, "target"?, "value"?, "transition"? }] (<= ${DESIGN_LIMITS.maxInteractions}), run in order on click in Present: navigate (target board), back, overlay (target board shown over the current one: modals, sheets), closeOverlay, toggle/show/hide (target node), setVariant (target instance, value a main id), setVariable (target variable, value; a boolean flips without one). They win over linkTo on the same node.
- Hover and pressed: an instance of "<Group> / <Variant>" shows "<Group> / <Variant> Hover" (and "… Pressed") while hovered (pressed) in Present when those mains exist; plain buttons darken on their own.
- Themes: "tokens": { "themes": { "dark": { "<token>": "#hex" } } } and a board's "theme": "dark" draws it with the dark values. Board "focusOrder": [node ids] sets the keyboard order in Present.
- Vectors: a path shape's "curves": [[c1x, c1y, c2x, c2y] | null per segment] (box shares) makes curved segments; gradients take "kind": "radial".
- Design systems: "system": { "name", "version"?, "description"?, "guidelines"?, "components"?: [main ids] } publishes this design's tokens (light and dark), spacing ("tokens.spacingScale": [px...]), text and fill styles and main components. Another design installs it by reference (installSystem below): copies with "ds-<name>-" ids on their own page, recorded in "installedSystems" with the source artifact and revision; with a system installed or declared, Checks also flags colours, spacing and type off the system.
- Link cards: "links": [{ "id", "artifactId", "kind": ${LINK_KINDS.join('|')}, "title", "x", "y", "page"?, "note"? }] — cards on the canvas linking artifacts made from this design (a deck, a doc); never exported.

Editing a stored design: edit_artifact with patch, a list of ops applied in order and then validated as a whole (any failure changes nothing):
- {"op":"addBoard","board":{...},"after"?:"<board id>"} (x and y may be left out: it goes 120 to the right of the rightmost board on its page)
- {"op":"replaceBoard","board":{...}} (rewrites the board with that id; the usual way to redo one screen)
- {"op":"removeBoard","id":"<board id>"} (links to it are removed too; instances of its main components are detached)
- {"op":"replaceNode","boardId":"...","nodeId":"...","node":{...}} (a board's root can only become another frame)
- {"op":"updateNode","boardId":"...","nodeId":"...","props":{"text":"...","color":"primary"}} (merges; null removes an optional field; id and type never change)
- {"op":"insertNode","boardId":"...","parentId":"<frame id>","index"?:0,"node":{...}} (no index: at the end)
- {"op":"removeNode","boardId":"...","nodeId":"..."} (never the root; instances of a main inside it are detached)
- {"op":"moveNode","boardId":"...","nodeId":"...","toBoardId"?:"...","parentId":"<frame id>","index"?:0,"x"?,"y"?} (reorder or move into another frame or board; index counts the target's children before the move; x/y for an absolute target)
- {"op":"addPage","page":{"id":"...","title":"..."},"after"?:"<page id>"} (the first call turns the one implicit page into "Page 1" holding every existing board)
- {"op":"renamePage","id":"<page id>","title":"..."}   - {"op":"removePage","id":"<page id>"} (removes its boards and notes; never the last page)
- {"op":"moveBoardToPage","boardId":"...","pageId":"..."} (placed in free space on that page)
- {"op":"insertComponent","boardId":"...","parentId":"<frame id>","index"?:0, "library":"<library id>" | "instanceOf":"<main id>", "overrides"?:{...}, "id"?:"...", "compact"?:bool} (exactly one of library or instanceOf)
- {"op":"swapInstance","boardId":"...","nodeId":"<instance id>","instanceOf":"<main id>"} (point an instance at another main, e.g. a variant; overrides carried across)
- {"op":"setTokens","tokens":{...}} (replaces all tokens; to change one colour use set on "/tokens/colors/primary")
- {"op":"applyStarterKit","kit":"clean"|"editorial"|"playful"} (a tasteful token set and type scale: its colours join the tokens, its fonts/radius/spacing replace them, its text styles "display", "heading", "title", "body", "meta" are added or replaced)
- {"op":"setStyle","kind":"text"|"fill","style":{...}} (adds a shared style or replaces the one with that id)   - {"op":"removeStyle","kind":"text"|"fill","id":"..."} (users keep its look, baked in)
- {"op":"applyStyle","boardId":"...","nodeId":"...","kind":"text"|"fill","styleId":"..."|null} (null detaches: the values stay on the node)
- {"op":"setResponsive","boardId":"...","nodeId":"...","breakpoint":"<id>","props":{...}} (merges the node's override at a breakpoint the board declares; null removes a key)
- {"op":"updateBoard","id":"<board id>","props":{...}} (merges board fields: title, background, device, breakpoints, guides, layoutGrid, w/h (absolute children follow their constraints); never id, root or page; null removes)
- {"op":"moveBoard","id":"<board id>","x":...,"y":...}   - {"op":"setStartBoard","boardId":"..."|null}
- {"op":"detachInstance","boardId":"...","nodeId":"<instance id>"} (the instance becomes a plain frame with its overrides baked in)
- {"op":"addNote","note":{...}}   - {"op":"updateNote","id":"...","props":{...}} (null removes a field)   - {"op":"removeNote","id":"..."}
- Round 5: {"op":"setVariable","variable":{...}} (adds or replaces by id)   - {"op":"setVariableValue","id":"...","value":...}   - {"op":"removeVariable","id":"..."} (showIf, bindings and interactions naming it go too)
- {"op":"setDataList","list":{...}}   - {"op":"removeDataList","id":"..."} (repeats of it stop repeating)
- {"op":"setInteractions","boardId":"...","nodeId":"...","interactions":[...]} ([] clears). showIf, bind, repeat, focus, zoom, curves, theme, fluid and focusOrder are ordinary fields for updateNode / updateBoard.
- {"op":"setThemeColors","theme":"dark","colors":{"background":"#0b0b0f","text":null}} (null removes a dark value)
- {"op":"setSystem","system":{...}|null} (publish this design as a design system, or stop)
- {"op":"installSystem","artifactId":"<source design id>","revision":<its revision>,"sourceDesign":<its body JSON, as read_artifact returned it>} (the source must declare "system"; list_artifacts kind design finds it; or pass just "fromArtifact":"<source design id>" instead of those three and it is read for you at its current revision; updateSystem takes it too)   - {"op":"updateSystem","id":"<installed id>","artifactId":"...","revision":...,"sourceDesign":...} (re-copies over the same ids: instances follow)   - {"op":"removeSystem","id":"..."}
- {"op":"addLinkCard","link":{...}}   - {"op":"removeLinkCard","id":"..."}
- {"op":"addPath","boardId":"...","parentId"?:"<frame id>","points":[[x,y],...] (board px, 2-${DESIGN_LIMITS.maxVertices}),"curves"?:[[c1x,c1y,c2x,c2y]|null,...],"closed"?,"fill"?,"stroke"?,"strokeWidth"?,"name"?,"id"?} (a pen path; pinned over a stack, placed in an absolute frame)
- {"op":"pruneReferences"} (drops showIf, bindings, interactions and focus entries that name something removed; run it after removeNode or removeBoard when a node had interactions pointing at it)
- generic {"op":"set"|"insert"|"remove","path":"/boards/0/title","value":...} on a JSON pointer.
read_artifact's summary lists each page, each board with its size and page, and an outline of its nodes by id (main components and instances marked).
The user can export a board as PNG (1x/2x), SVG, PNG/SVG zips of a page's boards, a PDF of the current page or all pages (vector, by printing), the tokens as CSS/JSON/Tailwind, a design system as a package (tokens + React components with variants as a prop), and copy a board or a main component as React + Tailwind or HTML + CSS generated from this tree: name layers ("name") and use stacks and grids rather than absolute placement so that code reads well.`
