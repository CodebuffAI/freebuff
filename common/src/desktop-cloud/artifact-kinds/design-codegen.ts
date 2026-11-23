import {
  FONT_STACKS,
  HEX,
  collectMains,
  emptyDesign,
  type Design,
  type DesignBoard,
  type DesignNode,
  type DesignStyles,
  type DesignTokens,
  type FrameNode,
  type ResponsiveOverride,
  type ShapeNode,
  type IconName,
  type Padding,
  type Size,
  type TextStyle,
} from './design'
import { resolveInstance } from './design-components'
import { hasLogic, logicScope, materializeBoardLogic, themedTokens } from './design-logic'
import { breakpointOf, resolveNode } from './design-resolve'
import { isVectorShape, shapeGeometry, strokeDashArray } from './design-vector'
import { findNode, nodeChain } from './design-tree'

/**
 * Code export: one board's node tree as readable source a developer (or a coding agent) can
 * paste into a project. Two targets from one walk:
 *   - `boardToReact`: a React component styled with Tailwind utility classes (arbitrary values
 *     where the scale has no exact match), icons from lucide-react.
 *   - `boardToHtml`: a standalone HTML document with one CSS class per node and the design's
 *     colour tokens as CSS custom properties.
 * Instances are expanded (the main's content with the instance's overrides), hidden nodes are
 * left out, and the layout mirrors the renderer's: stacks are flexbox, grids CSS grid, absolute
 * frames positioned children. Pure and deterministic (no DOM), so it runs on the server too.
 */

// ---- the shared description: an element tree with CSS declarations

type Decl = [property: string, value: string]
type El = {
  tag: string
  /** A readable class name base (from the layer name or the node's id). */
  name: string
  attrs: Array<[string, string]>
  css: Decl[]
  children: Array<El | string>
  /** React only: a lucide icon component in place of the element. */
  icon?: { name: string; size: number }
  comment?: string
  /**
   * Below the `md` breakpoint (768 px) these declarations replace the same properties in `css`
   * (a grid falls to one column). HTML emits a media query, React mobile-first `md:` classes.
   */
  small?: Decl[]
}

/** The narrow-screen breakpoint of the exports: Tailwind's `md`. */
export const CODEGEN_BREAKPOINT = 768

const TEXT_SCALE: Record<TextStyle, { size: number; line: number; weight: number; tracking: string; font: 'heading' | 'body' | 'mono'; tag: string }> = {
  // display and h1 are the page's one h1: after the first, each is demoted to h2 (headingTag).
  display: { size: 64, line: 1.04, weight: 700, tracking: '-0.03em', font: 'heading', tag: 'h1' },
  h1: { size: 44, line: 1.1, weight: 700, tracking: '-0.02em', font: 'heading', tag: 'h1' },
  h2: { size: 32, line: 1.15, weight: 700, tracking: '-0.015em', font: 'heading', tag: 'h2' },
  h3: { size: 20, line: 1.3, weight: 600, tracking: '-0.01em', font: 'heading', tag: 'h3' },
  body: { size: 16, line: 1.55, weight: 400, tracking: 'normal', font: 'body', tag: 'p' },
  small: { size: 14, line: 1.5, weight: 400, tracking: 'normal', font: 'body', tag: 'p' },
  caption: { size: 12, line: 1.4, weight: 600, tracking: '0.06em', font: 'body', tag: 'p' },
  mono: { size: 14, line: 1.5, weight: 400, tracking: 'normal', font: 'mono', tag: 'code' },
}
const BUTTON_SIZE = {
  sm: { height: 32, pad: 12, font: 13, icon: 14 },
  md: { height: 40, pad: 16, font: 14, icon: 16 },
  lg: { height: 48, pad: 22, font: 16, icon: 18 },
} as const
const SHADOW: Record<string, string> = {
  sm: '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.08)',
  md: '0 4px 12px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.06)',
  lg: '0 24px 48px -12px rgba(15, 23, 42, 0.18), 0 8px 16px -8px rgba(15, 23, 42, 0.12)',
  xl: '0 40px 80px -20px rgba(15, 23, 42, 0.28), 0 16px 32px -16px rgba(15, 23, 42, 0.18)',
  inner: 'inset 0 2px 6px rgba(15, 23, 42, 0.12)',
}
const PLACEHOLDER_SIZE = {
  photo: { w: 320, h: 200, radius: 0 },
  avatar: { w: 48, h: 48, radius: 999 },
  logo: { w: 40, h: 40, radius: 10 },
  chart: { w: 360, h: 200, radius: 0 },
  map: { w: 360, h: 220, radius: 0 },
} as const
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }
const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' }

/** Our icon names → lucide-react component names (the same glyphs the renderer draws). */
const LUCIDE: Record<IconName, string> = {
  'arrow-right': 'ArrowRight', 'arrow-left': 'ArrowLeft', 'arrow-up-right': 'ArrowUpRight', check: 'Check',
  'check-circle': 'CircleCheck', x: 'X', plus: 'Plus', minus: 'Minus', 'chevron-right': 'ChevronRight',
  'chevron-left': 'ChevronLeft', 'chevron-down': 'ChevronDown', menu: 'Menu', search: 'Search', home: 'House',
  user: 'UserRound', users: 'Users', settings: 'Settings', bell: 'Bell', mail: 'Mail', message: 'MessageSquare',
  phone: 'Phone', calendar: 'Calendar', clock: 'Clock', 'map-pin': 'MapPin', globe: 'Globe', lock: 'LockKeyhole',
  shield: 'ShieldCheck', key: 'KeyRound', star: 'Star', heart: 'Heart', bookmark: 'Bookmark', share: 'Share2',
  download: 'Download', upload: 'Upload', link: 'Link', image: 'Image', camera: 'Camera', play: 'Play',
  pause: 'Pause', file: 'File', folder: 'Folder', cloud: 'Cloud', database: 'Database', code: 'Code',
  terminal: 'SquareTerminal', zap: 'Zap', sparkles: 'Sparkles', layers: 'Layers', layout: 'LayoutTemplate',
  chart: 'ChartNoAxesCombined', 'trending-up': 'TrendingUp', 'credit-card': 'CreditCard',
  'shopping-cart': 'ShoppingCart', tag: 'Tag', gift: 'Gift', filter: 'ListFilter', sliders: 'SlidersHorizontal',
  eye: 'Eye', sun: 'Sun', moon: 'Moon', leaf: 'Leaf', coffee: 'Coffee', flame: 'Flame', rocket: 'Rocket',
  droplet: 'Droplet', sprout: 'Sprout', thermometer: 'Thermometer', wifi: 'Wifi', battery: 'BatteryFull', more: 'Ellipsis',
}

const DEFAULT_COLORS = emptyDesign().tokens!.colors

type Ctx = {
  tokens: DesignTokens | undefined
  mains: ReadonlyMap<string, FrameNode>
  useVars: boolean
  /** Whether the page's h1 has been emitted (later display/h1 texts become h2). */
  h1?: boolean
  /** Board titles by id, for the accessible name of a link with no text. */
  boardTitles?: ReadonlyMap<string, string>
  /** Inside a landmark already: nested "Nav item" or "Footer links" frames stay divs. */
  inLandmark?: boolean
  /** Shared styles, resolved onto each node before it is written. */
  styles?: DesignStyles
  /** The board's narrowest breakpoint under 768 px: its overrides become the narrow-screen CSS. */
  narrow?: string | null
}

/** The landmark a frame's layer name asks for (nav, header, footer, aside), else null. */
export function landmarkTag(name: string | undefined): 'nav' | 'header' | 'footer' | 'aside' | null {
  if (!name) return null
  const value = name.toLowerCase()
  if (/\b(nav|navbar|navigation|menu bar|tab bar)\b/.test(value)) return 'nav'
  if (/\bfooter\b/.test(value)) return 'footer'
  if (/\bheader\b/.test(value)) return 'header'
  if (/\b(sidebar|aside)\b/.test(value)) return 'aside'
  return null
}

/** Whether a node (or anything drawn inside it) is itself interactive: a button, input or link. */
function hasInteractive(node: DesignNode, mains: ReadonlyMap<string, FrameNode>, depth = 0): boolean {
  if (depth > 40) return false
  if (node.type === 'button' || node.type === 'input') return true
  if (node.type !== 'frame') return false
  const shown = node.instanceOf !== undefined ? resolveInstance(node, mains) : node
  return shown.children.some((child) => !child.hidden && ((child.type === 'frame' && child.linkTo !== undefined) || hasInteractive(child, mains, depth + 1)))
}

/** Whether anything drawn inside a node is text a screen reader would read (text, a label). */
function hasText(node: DesignNode, mains: ReadonlyMap<string, FrameNode>, depth = 0): boolean {
  if (depth > 40) return false
  if (node.type === 'text') return node.text.trim().length > 0
  if (node.type === 'button') return true
  if (node.type === 'image') return node.alt.trim().length > 0
  if (node.type !== 'frame') return false
  const shown = node.instanceOf !== undefined ? resolveInstance(node, mains) : node
  return shown.children.some((child) => !child.hidden && hasText(child, mains, depth + 1))
}

/** A colour as CSS: a token becomes var(--color-name) (HTML) or its hex (Tailwind). */
function color(value: string | undefined, ctx: Ctx): string | undefined {
  if (value === undefined) return undefined
  if (value === 'transparent' || HEX.test(value)) return value
  const hex = ctx.tokens?.colors[value] ?? DEFAULT_COLORS[value]
  if (!hex) return undefined
  return ctx.useVars ? `var(--color-${value})` : hex
}

const fontStackOf = (tokens: DesignTokens | undefined, role: 'heading' | 'body' | 'mono') =>
  role === 'mono' ? FONT_STACKS.mono.stack : FONT_STACKS[tokens?.fonts?.[role] ?? 'system'].stack
/** A font role: var(--font-heading) etc. in HTML, the stack itself for Tailwind. */
const font = (ctx: Ctx, role: 'heading' | 'body' | 'mono') => (ctx.useVars ? `var(--font-${role})` : fontStackOf(ctx.tokens, role))

const pxv = (value: number) => `${Math.round(value * 100) / 100}px`

function spacingCss(spacing: Padding | undefined): string | undefined {
  if (spacing === undefined) return undefined
  if (typeof spacing === 'number') return pxv(spacing)
  return spacing.map(pxv).join(' ')
}

function fillInsideMargin(margin: Padding | undefined, axis: 'width' | 'height', base = '100%'): string {
  if (margin === undefined) return base
  const [top, right, bottom = top, left = right] = typeof margin === 'number' ? [margin, margin] : margin
  const total = axis === 'width' ? left + right : top + bottom
  return total === 0 ? base : `calc(${base} - ${pxv(total)})`
}

type Parent = 'root' | 'stack-v' | 'stack-h' | 'grid' | 'absolute'

type Sized = {
  w?: Size; h?: Size; grow?: boolean; x?: number; y?: number
  opacity?: number; absolute?: boolean; anchor?: string; aspect?: number; blur?: number
  margin?: Padding
}

/** How a node sizes and places itself in its parent: the renderer's rules, as CSS. */
function sizeCss(node: Sized, parent: Parent, defaults: { w?: Size; h?: Size } = {}): Decl[] {
  const out: Decl[] = []
  const w = node.w ?? defaults.w ?? 'hug'
  const h = node.h ?? defaults.h ?? 'hug'
  if (node.absolute && parent !== 'absolute' && parent !== 'root') {
    const anchor = node.anchor ?? 'top-left'
    out.push(['position', 'absolute'])
    out.push([anchor.startsWith('bottom') ? 'bottom' : 'top', pxv(node.y ?? 0)])
    out.push([anchor.endsWith('right') ? 'right' : 'left', pxv(node.x ?? 0)])
    if (typeof w === 'number') out.push(['width', pxv(w)])
    if (typeof h === 'number') out.push(['height', pxv(h)])
  } else if (parent === 'root') {
    out.push(['width', typeof w === 'number' ? pxv(w) : fillInsideMargin(node.margin, 'width')])
    if (typeof h === 'number') out.push(['height', pxv(h)])
    else out.push(['min-height', fillInsideMargin(node.margin, 'height')])
  } else if (parent === 'absolute') {
    out.push(['position', 'absolute'], ['left', pxv(node.x ?? 0)], ['top', pxv(node.y ?? 0)])
    if (typeof w === 'number') out.push(['width', pxv(w)])
    else if (w === 'fill') out.push(['right', '0'])
    if (typeof h === 'number') out.push(['height', pxv(h)])
    else if (h === 'fill') out.push(['bottom', '0'])
  } else if (parent === 'grid') {
    if (typeof w === 'number') out.push(['width', pxv(w)])
    if (typeof h === 'number') out.push(['height', pxv(h)])
    else if (h === 'fill') out.push(['height', fillInsideMargin(node.margin, 'height')])
  } else {
    const row = parent === 'stack-h'
    const main = row ? w : h
    const cross = row ? h : w
    if (main === 'fill' || node.grow) out.push(['flex', '1 1 0%'], [row ? 'min-width' : 'min-height', '0'])
    else if (typeof main === 'number') out.push([row ? 'width' : 'height', pxv(main)], ['flex-shrink', '0'])
    if (cross === 'fill') out.push(['align-self', 'stretch'])
    else if (typeof cross === 'number') out.push([row ? 'height' : 'width', pxv(cross)])
  }
  const margin = spacingCss(node.margin)
  if (margin !== undefined) out.push(['margin', margin])
  if (node.opacity !== undefined && node.opacity < 1) out.push(['opacity', String(node.opacity)])
  if (node.aspect) out.push(['aspect-ratio', String(Math.round(node.aspect * 10000) / 10000)])
  if (node.blur) out.push(['filter', `blur(${node.blur}px)`])
  return out
}

const gradientCss = (g: { from: string; to: string; angle?: number; kind?: 'linear' | 'radial' }, ctx: Ctx) =>
  g.kind === 'radial'
    ? `radial-gradient(circle at center, ${color(g.from, ctx)}, ${color(g.to, ctx)})`
    : `linear-gradient(${g.angle ?? 180}deg, ${color(g.from, ctx)}, ${color(g.to, ctx)})`

function nameOf(node: DesignNode): string {
  const base = (node.name ?? node.id.split('~').pop() ?? node.type)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base && /^[a-z]/.test(base) ? base : `${node.type}-${base || 'node'}`
}

function frameEl(raw: FrameNode, parent: Parent, ctx: Ctx, depth: number): El {
  const node = resolveNode(raw, { styles: ctx.styles })
  const shown = node.instanceOf !== undefined ? resolveNode(resolveInstance(node, ctx.mains), { styles: ctx.styles }) : node
  const css: Decl[] = [...sizeCss(shown, parent, parent === 'root' ? { w: 'fill', h: 'fill' } : {})]
  if (parent !== 'absolute' && !(shown.absolute && parent !== 'root')) {
    // Children that are positioned (absolute layout or pinned) need a containing block.
    if (shown.layout === 'absolute' || shown.children.some((child) => child.absolute)) css.push(['position', 'relative'])
  }
  if (shown.layout === 'stack-v' || shown.layout === 'stack-h') {
    css.push(['display', 'flex'], ['flex-direction', shown.layout === 'stack-h' ? 'row' : 'column'])
    const align = shown.align ?? (shown.layout === 'stack-h' ? 'center' : 'start')
    if (align !== 'stretch') css.push(['align-items', ALIGN[align]])
    if (shown.justify && shown.justify !== 'start') css.push(['justify-content', JUSTIFY[shown.justify]])
    if (shown.wrap) css.push(['flex-wrap', 'wrap'])
    if (shown.gap) css.push(['gap', pxv(shown.gap)])
    if (shown.wrap && shown.rowGap !== undefined) css.push(['row-gap', pxv(shown.rowGap)])
  } else if (shown.layout === 'grid') {
    css.push(['display', 'grid'], ['grid-template-columns', `repeat(${shown.columns ?? 2}, minmax(0, 1fr))`])
    if (shown.gap) css.push(['gap', pxv(shown.gap)])
    if (shown.align && shown.align !== 'stretch') css.push(['align-items', ALIGN[shown.align]])
  }
  // A multi-column grid stacks to one column on a narrow screen (the guide's phone rule).
  const small: Decl[] | undefined = mergeSmall(
    shown.layout === 'grid' && (shown.columns ?? 2) > 1 ? [['grid-template-columns', 'minmax(0, 1fr)']] : undefined,
    narrowDecls(raw, ctx),
  )
  if (shown.minW !== undefined) css.push(['min-width', pxv(shown.minW)])
  if (shown.maxW !== undefined) css.push(['max-width', pxv(shown.maxW)])
  if (shown.minH !== undefined) css.push(['min-height', pxv(shown.minH)])
  if (shown.maxH !== undefined) css.push(['max-height', pxv(shown.maxH)])
  const padding = spacingCss(shown.padding)
  if (padding) css.push(['padding', padding])
  const fill = color(shown.fill, ctx)
  if (fill) css.push(['background-color', fill])
  const layers: string[] = []
  if (shown.fillImage) layers.push(`url("${cssString(shown.fillImage.src)}")`)
  if (shown.gradient) layers.push(gradientCss(shown.gradient, ctx))
  if (layers.length) css.push(['background-image', layers.join(', ')])
  if (shown.fillImage) css.push(['background-size', shown.fillImage.fit ?? 'cover'], ['background-position', 'center'])
  if (shown.stroke) {
    const border = `${pxv(shown.strokeWidth ?? 1)} ${shown.strokePattern ?? 'solid'} ${color(shown.stroke, ctx)}`
    if (!shown.strokeSides) css.push(['border', border])
    else for (const side of shown.strokeSides) css.push([`border-${side}`, border])
  }
  if (shown.radius) css.push(['border-radius', pxv(shown.radius)])
  if (shown.shadow && shown.shadow !== 'none') css.push(['box-shadow', SHADOW[shown.shadow]])
  if (shown.clip) css.push(['overflow', 'hidden'])
  // A link cannot hold another control (a button inside an <a> is invalid HTML), so a linked
  // frame with buttons or inputs inside stays a div and says where it would go.
  const link = shown.linkTo !== undefined && !hasInteractive(shown, ctx.mains) ? shown.linkTo : undefined
  const landmark = ctx.inLandmark ? null : landmarkTag(shown.name)
  const tag = link ? 'a' : landmark ?? (depth === 1 && parent === 'stack-v' ? 'section' : 'div')
  const attrs: Array<[string, string]> = []
  if (link) {
    attrs.push(['href', `#${link}`])
    // A link drawn with icons or shapes only still needs a name.
    if (!hasText(shown, ctx.mains)) attrs.push(['aria-label', shown.name ?? `Go to ${ctx.boardTitles?.get(link) ?? link}`])
  } else if (tag === 'section' && shown.name) attrs.push(['aria-label', shown.name])
  const notes = [
    node.instanceOf !== undefined ? `instance of ${shown.name ?? node.instanceOf}` : null,
    shown.linkTo !== undefined && !link ? `links to #${shown.linkTo} (holds controls, so not an <a>)` : null,
  ].filter(Boolean)
  return {
    tag,
    name: nameOf(node),
    attrs,
    css,
    small,
    children: (() => {
      const outer = ctx.inLandmark
      if (landmark) ctx.inLandmark = true
      const out = shown.children.filter((child) => !child.hidden).map((child) => nodeEl(child, shown.layout, ctx, depth + 1))
      ctx.inLandmark = outer
      return out
    })(),
    comment: notes.length ? notes.join('; ') : undefined,
  }
}

function nodeEl(raw: DesignNode, parent: Parent, ctx: Ctx, depth: number): El {
  const el = nodeElInner(resolveNode(raw, { styles: ctx.styles }), parent, ctx, depth)
  if (raw.type === 'frame') return el
  const small = mergeSmall(el.small, narrowDecls(raw, ctx))
  return small ? { ...el, small } : el
}

/** A node's override at the board's narrow breakpoint, as the CSS that replaces its own there. */
function narrowDecls(node: DesignNode, ctx: Ctx): Decl[] | undefined {
  const override: ResponsiveOverride | undefined = ctx.narrow ? node.responsive?.[ctx.narrow] : undefined
  if (!override) return undefined
  const out: Decl[] = []
  if (override.hidden === true) out.push(['display', 'none'])
  if (node.type === 'frame') {
    if (override.layout === 'stack-v' || override.layout === 'stack-h') out.push(['flex-direction', override.layout === 'stack-h' ? 'row' : 'column'])
    if (override.gap !== undefined) out.push(['gap', pxv(override.gap)])
    const padding = spacingCss(override.padding)
    if (padding) out.push(['padding', padding])
    if (override.columns !== undefined) out.push(['grid-template-columns', override.columns === 1 ? 'minmax(0, 1fr)' : `repeat(${override.columns}, minmax(0, 1fr))`])
  }
  if (node.type === 'text' && (override.fontSize !== undefined || override.style !== undefined)) {
    out.push(['font-size', pxv(override.fontSize ?? TEXT_SCALE[override.style ?? node.style].size)])
  }
  if (node.type === 'text' && override.weight !== undefined) out.push(['font-weight', String(override.weight)])
  if (override.w !== undefined) out.push(['width', typeof override.w === 'number' ? pxv(override.w) : override.w === 'fill' ? fillInsideMargin(node.margin, 'width') : 'auto'])
  return out.length ? out : undefined
}

function mergeSmall(a: Decl[] | undefined, b: Decl[] | undefined): Decl[] | undefined {
  if (!a?.length) return b
  if (!b?.length) return a
  const props = new Set(b.map(([prop]) => prop))
  return [...a.filter(([prop]) => !props.has(prop)), ...b]
}

function nodeElInner(node: DesignNode, parent: Parent, ctx: Ctx, depth: number): El {
  switch (node.type) {
    case 'frame':
      return frameEl(node, parent, ctx, depth)
    case 'text': {
      const scale = TEXT_SCALE[node.style]
      // A fixed width in a column is a measure (a cap on line length): never wider than its
      // parent, so it shrinks on a narrow screen and is exactly the design at full width.
      const sized = sizeCss(node, parent).flatMap((decl): Decl[] =>
        decl[0] === 'width' && parent === 'stack-v' && typeof node.w === 'number' ? [decl, ['max-width', '100%']] : [decl],
      )
      if (node.margin === undefined) sized.push(['margin', '0'])
      const css: Decl[] = [...sized, ['font-family', font(ctx, scale.font)], ['font-size', pxv(node.fontSize ?? scale.size)]]
      css.push(['line-height', String(node.lineHeight ?? scale.line)], ['font-weight', String(node.weight ?? scale.weight)])
      const tracking = node.letterSpacing === undefined ? scale.tracking : scale.tracking === 'normal' ? pxv(node.letterSpacing) : `calc(${scale.tracking} + ${pxv(node.letterSpacing)})`
      if (tracking !== 'normal') css.push(['letter-spacing', tracking])
      const c = color(node.color, ctx)
      if (c) css.push(['color', c])
      if (node.align && node.align !== 'start') css.push(['text-align', node.align === 'end' ? 'right' : 'center'])
      if (node.decoration) css.push(['text-decoration', node.decoration])
      if (node.text.includes('\n')) css.push(['white-space', 'pre-wrap'])
      if (node.maxLines) css.push(['display', '-webkit-box'], ['-webkit-line-clamp', String(node.maxLines)], ['-webkit-box-orient', 'vertical'], ['overflow', 'hidden'])
      let tag = scale.tag
      if (tag === 'h1') {
        if (ctx.h1) tag = 'h2'
        else ctx.h1 = true
      }
      return { tag, name: nameOf(node), attrs: [], css, children: [node.text] }
    }
    case 'button': {
      const size = BUTTON_SIZE[node.size ?? 'md']
      const palette =
        node.variant === 'primary'
          ? { bg: color('primary', ctx), fg: color('on-primary', ctx), border: 'transparent' }
          : node.variant === 'secondary'
            ? { bg: color('background', ctx), fg: color('text', ctx), border: color('border', ctx) }
            : { bg: 'transparent', fg: color('text', ctx), border: 'transparent' }
      const css: Decl[] = [
        ...sizeCss(node, parent),
        ['display', 'inline-flex'], ['align-items', 'center'], ['justify-content', 'center'], ['gap', '8px'],
        ['height', pxv(size.height)], ['padding', `0 ${pxv(size.pad)}`], ['border-radius', pxv(ctx.tokens?.radius ?? 8)],
        ['border', `1px solid ${palette.border}`], ['background-color', palette.bg ?? 'transparent'], ['color', palette.fg ?? 'inherit'],
        ['font-family', font(ctx, 'body')], ['font-size', pxv(size.font)], ['font-weight', '600'], ['white-space', 'nowrap'],
      ]
      const icon: El | null = node.icon ? iconEl(node.icon, size.icon, undefined, ctx) : null
      const trailing = node.icon ? /^(arrow|chevron)-/.test(node.icon) : false
      const children: Array<El | string> = [node.label]
      if (icon) trailing ? children.push(icon) : children.unshift(icon)
      return {
        tag: node.linkTo ? 'a' : 'button',
        name: nameOf(node),
        attrs: node.linkTo ? [['href', `#${node.linkTo}`]] : [['type', 'button']],
        css,
        children,
      }
    }
    case 'image': {
      const defaults = node.placeholder ? PLACEHOLDER_SIZE[node.placeholder] : { w: 320, h: 200, radius: 0 }
      const css: Decl[] = [...sizeCss(node, parent, { w: defaults.w, h: defaults.h }), ['display', 'block'], ['flex-shrink', '0']]
      const radius = node.radius ?? defaults.radius
      if (radius) css.push(['border-radius', pxv(radius)])
      if (node.src) {
        css.push(['object-fit', node.fit ?? 'cover'])
        if (node.focus) css.push(['object-position', `${Math.round(node.focus[0] * 100)}% ${Math.round(node.focus[1] * 100)}%`])
        return { tag: 'img', name: nameOf(node), attrs: [['src', node.src], ['alt', node.alt]], css, children: [] }
      }
      css.push(['background-color', color('surface', ctx) ?? '#f1f5f9'])
      const alt = node.alt.trim()
      return {
        tag: 'div',
        name: nameOf(node),
        // No alt means decorative: hidden from screen readers rather than an image with no name.
        attrs: alt ? [['role', 'img'], ['aria-label', alt]] : [['aria-hidden', 'true']],
        css,
        children: [],
        comment: `${node.placeholder} placeholder: replace with a real image`,
      }
    }
    case 'icon':
      return iconEl(node.icon, node.size ?? 20, node, ctx, parent)
    case 'input':
      return inputEl(node, parent, ctx)
    case 'divider': {
      const vertical = parent === 'stack-h'
      const css: Decl[] = [
        ...sizeCss(node, parent),
        ['flex-shrink', '0'],
        ...(vertical ? ([['width', '1px'], ['align-self', 'stretch']] as Decl[]) : ([['height', '1px'], ['width', fillInsideMargin(node.margin, 'width')]] as Decl[])),
        ['background-color', color(node.color ?? 'border', ctx) ?? '#e2e8f0'],
      ]
      if (!vertical) {
        css.push(['border', '0'])
        if (node.margin === undefined) css.push(['margin', '0'])
      }
      return { tag: vertical ? 'div' : 'hr', name: nameOf(node), attrs: [], css, children: [] }
    }
    case 'shape': {
      if (isVectorShape(node)) return vectorEl(node, parent, ctx)
      const css: Decl[] = [...sizeCss(node, parent)]
      if (node.kind === 'line') {
        const height = typeof node.h === 'number' ? Math.max(node.h, 1) : 2
        const stroke = color(node.stroke ?? node.fill ?? 'border', ctx) ?? '#e2e8f0'
        const patterned = node.strokePattern !== undefined && node.strokePattern !== 'solid'
        css.push(['height', pxv(height)])
        if (node.strokeWidth !== undefined || patterned) css.push(['border-top', `${pxv(node.strokeWidth ?? height)} ${node.strokePattern ?? 'solid'} ${stroke}`])
        else css.push(['background-color', stroke])
      } else {
        const fill = color(node.fill, ctx)
        if (fill) css.push(['background-color', fill])
        if (node.gradient) css.push(['background-image', gradientCss(node.gradient, ctx)])
        if (node.stroke) css.push(['border', `${pxv(node.strokeWidth ?? 1.5)} ${node.strokePattern ?? 'solid'} ${color(node.stroke, ctx)}`])
        if (node.kind === 'ellipse') css.push(['border-radius', '50%'])
        else if (node.radius) css.push(['border-radius', pxv(node.radius)])
      }
      return { tag: 'div', name: nameOf(node), attrs: [['aria-hidden', 'true']], css, children: [] }
    }
  }
}

/** A vector shape as an inline SVG: one path, filled when closed, stroked otherwise. */
function vectorEl(node: ShapeNode, parent: Parent, ctx: Ctx): El {
  const w = typeof node.w === 'number' ? node.w : 100
  const h = typeof node.h === 'number' ? node.h : 100
  const geometry = shapeGeometry(node, w, h)
  const stroke = color(node.stroke, ctx) ?? (geometry.closed ? undefined : color('text', ctx))
  const fill = geometry.closed ? color(node.fill, ctx) ?? (stroke ? undefined : color('primary', ctx)) : undefined
  const path: Decl[] = [['fill', fill ?? 'none']]
  if (stroke) {
    const width = node.strokeWidth ?? 2
    path.push(['stroke', stroke], ['stroke-width', pxv(width)], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'])
    const dashes = strokeDashArray(node.strokePattern, width)
    if (dashes) path.push(['stroke-dasharray', dashes], ['vector-effect', 'non-scaling-stroke'])
  }
  return {
    tag: 'svg',
    name: nameOf(node),
    attrs: [['viewBox', `0 0 ${w} ${h}`], ['preserveAspectRatio', 'none'], ['aria-hidden', 'true']],
    css: [...sizeCss(node, parent), ['display', 'block'], ['overflow', 'visible']],
    children: [{ tag: 'path', name: `${nameOf(node)}-path`, attrs: [['d', geometry.d]], css: path, children: [] }],
  }
}

function iconEl(icon: IconName, size: number, node: DesignNode | undefined, ctx: Ctx, parent: Parent = 'stack-h'): El {
  const css: Decl[] = node ? sizeCss(node, parent) : []
  css.push(['width', pxv(size)], ['height', pxv(size)], ['flex-shrink', '0'])
  const c = node?.type === 'icon' ? color(node.color, ctx) : undefined
  if (c) css.push(['color', c])
  return { tag: 'span', name: node ? nameOf(node) : `icon-${icon}`, attrs: [['aria-hidden', 'true']], css, children: [], icon: { name: LUCIDE[icon], size } }
}

function inputEl(node: Extract<DesignNode, { type: 'input' }>, parent: Parent, ctx: Ctx): El {
  const text = color('text', ctx) ?? '#0f172a'
  const border = color('border', ctx) ?? '#e2e8f0'
  const base: Decl[] = [...sizeCss(node, parent), ['font-family', font(ctx, 'body')], ['font-size', '14px'], ['color', text]]
  const field: Decl[] = [
    ['height', '40px'], ['padding', '0 12px'], ['border', `1px solid ${border}`], ['border-radius', pxv(ctx.tokens?.radius ?? 8)],
    ['background-color', color('background', ctx) ?? '#ffffff'], ['font', 'inherit'], ['color', 'inherit'],
  ]
  const label = (children: Array<El | string>, css: Decl[]): El => ({ tag: 'label', name: nameOf(node), attrs: [], css: [...base, ...css], children })
  // With no visible label the control still needs an accessible name.
  const named: Array<[string, string]> = node.label?.trim()
    ? []
    : [['aria-label', node.placeholder?.trim() || node.name || (node.kind === 'search' ? 'Search' : node.kind === 'toggle' ? 'Toggle' : node.kind === 'checkbox' ? 'Checkbox' : 'Text field')]]
  if (node.kind === 'checkbox') {
    return label(
      [{ tag: 'input', name: `${nameOf(node)}-box`, attrs: [['type', 'checkbox'], ...named, ...(node.checked ? ([['defaultChecked', '']] as Array<[string, string]>) : [])], css: [['width', '16px'], ['height', '16px']], children: [] }, ...(node.label ? [node.label] : [])],
      [['display', 'inline-flex'], ['align-items', 'center'], ['gap', '10px']],
    )
  }
  if (node.kind === 'toggle') {
    return label(
      [
        ...(node.label ? [node.label] : []),
        { tag: 'input', name: `${nameOf(node)}-switch`, attrs: [['type', 'checkbox'], ['role', 'switch'], ...named, ...(node.checked ? ([['defaultChecked', '']] as Array<[string, string]>) : [])], css: [['width', '36px'], ['height', '20px']], children: [] },
      ],
      [['display', 'flex'], ['align-items', 'center'], ['justify-content', 'space-between'], ['gap', '12px']],
    )
  }
  const control: El =
    node.kind === 'select'
      ? { tag: 'select', name: `${nameOf(node)}-control`, attrs: [...named], css: field, children: [{ tag: 'option', name: '', attrs: [], css: [], children: [node.value ?? node.placeholder ?? 'Choose…'] }] }
      : {
          tag: 'input',
          name: `${nameOf(node)}-control`,
          attrs: [
            ['type', node.kind === 'search' ? 'search' : 'text'],
            ...named,
            ...(node.placeholder ? ([['placeholder', node.placeholder]] as Array<[string, string]>) : []),
            ...(node.value ? ([['defaultValue', node.value]] as Array<[string, string]>) : []),
          ],
          css: field,
          children: [],
        }
  return label(
    [...(node.label ? [{ tag: 'span', name: `${nameOf(node)}-label`, attrs: [], css: [['font-weight', '500']] as Decl[], children: [node.label] } as El] : []), control],
    [['display', 'flex'], ['flex-direction', 'column'], ['gap', '6px']],
  )
}

function boardEl(design: Design, stored: DesignBoard, useVars: boolean, inspectRoot = false): El {
  const mains = collectMains(design.boards)
  // Round 5: repeats, bindings and showIf drawn as the variables stand; a dark board's theme colours.
  const board = hasLogic(design) ? materializeBoardLogic(stored, logicScope(design, undefined, mains)) : stored
  const narrow = [...(board.breakpoints ?? [])].filter((entry) => entry.w < CODEGEN_BREAKPOINT).sort((a, b) => a.w - b.w)[0]
  const ctx: Ctx = {
    tokens: themedTokens(design.tokens, board.theme),
    mains,
    useVars,
    boardTitles: new Map(design.boards.map((entry) => [entry.id, entry.title])),
    styles: design.styles,
    narrow: breakpointOf(board, narrow?.id)?.id ?? null,
  }
  const root = frameEl(board.root, 'root', ctx, 0)
  // The board's width is the page's widest, not a fixed size: it narrows with the screen.
  const css: Decl[] = [
    ['width', '100%'],
    ['max-width', pxv(board.w)],
    ['margin', '0 auto'],
    ['min-height', pxv(board.h)],
    ['background-color', color(board.background ?? 'background', ctx) ?? '#ffffff'],
    ['color', color('text', ctx) ?? '#0f172a'],
    ['font-family', font(ctx, 'body')],
    ['font-size', '16px'],
    ['line-height', '1.5'],
  ]
  const name = nameOf({ ...board.root, name: board.title })
  const margin = board.root.margin ?? (board.root.instanceOf ? mains.get(board.root.instanceOf)?.margin : undefined)
  if (margin !== undefined) {
    // Keep the frame inside the artboard when it has outer spacing. The board's own background,
    // centring and min-height should not move with that frame.
    const content: El = {
      ...root,
      css: root.css.map(([prop, value]): Decl => prop === 'min-height'
        ? [prop, fillInsideMargin(margin, 'height', pxv(board.h))]
        : [prop, value]),
    }
    return inspectRoot ? content : { tag: 'main', name, attrs: [], css: [...css, ['display', 'flow-root']], children: [content] }
  }
  return {
    tag: 'main',
    name,
    attrs: [],
    css: [...css, ...root.css.filter(([p]) => !['width', 'min-height', 'height'].includes(p))],
    small: root.small,
    children: root.children,
  }
}

// ---- helpers shared by both targets

const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (value: string) => escapeText(value).replace(/"/g, '&quot;')
/**
 * A value inside a double-quoted CSS string (`url("…")`): every character that could end the
 * string, the url() or the `<style>` element (quotes, backslash, parens, `<`, `>`, line breaks)
 * as a CSS hex escape, so a stored src can never break out of the stylesheet.
 */
function cssString(value: string): string {
  return value.replace(/[\\"'()<>\u0000-\u001f\u007f\u2028\u2029]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `)
}
/** Text inside a `/* … *\/` comment: it cannot close the comment or break the line. */
const commentText = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\*\//g, '* /')

function boardOf(design: Design, boardId: string): DesignBoard {
  const board = design.boards.find((entry) => entry.id === boardId)
  if (!board) throw new Error(`No board "${boardId}"`)
  return board
}

export function componentName(title: string): string {
  const words = title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('')
  return /^[A-Z]/.test(name) ? name : `Board${name}`
}

// ---- HTML + CSS

/** A standalone HTML document for one board: tokens as CSS variables, one class per node. */
export function boardToHtml(design: Design, boardId: string): string {
  const board = boardOf(design, boardId)
  const tree = boardEl(design, board, true)
  const used = new Map<string, number>()
  const rules: string[] = []
  const narrow: string[] = []
  const className = (el: El) => {
    const count = (used.get(el.name) ?? 0) + 1
    used.set(el.name, count)
    return count === 1 ? el.name : `${el.name}-${count}`
  }
  const render = (el: El, depth: number, inheritFont: string | null = null): string => {
    const pad = '  '.repeat(depth)
    const css = el.css.filter(([prop, value]) => !(prop === 'font-family' && value === inheritFont))
    const cls = el.name && css.length ? className(el) : ''
    const font = el.css.find(([prop]) => prop === 'font-family')?.[1] ?? inheritFont
    if (cls && css.length) rules.push(`.${cls} {\n${css.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}`)
    if (cls && el.small?.length) narrow.push(`  .${cls} {\n${el.small.map(([p, v]) => `    ${p}: ${v};`).join('\n')}\n  }`)
    const attrs = [...(cls ? [`class="${cls}"`] : []), ...el.attrs.map(([k, v]) => (k === 'defaultChecked' ? 'checked' : `${k === 'defaultValue' ? 'value' : k}="${escapeAttr(v)}"`))].join(' ')
    const open = `<${el.tag}${attrs ? ` ${attrs}` : ''}>`
    const comment = el.comment ? `${pad}<!-- ${escapeText(el.comment)} -->\n` : ''
    if (el.icon) return `${comment}${pad}<span${attrs ? ` ${attrs}` : ''} data-lucide="${el.icon.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}"></span>`
    if (['img', 'input', 'hr'].includes(el.tag)) return `${comment}${pad}${open}`
    if (el.children.length === 0) return `${comment}${pad}${open}</${el.tag}>`
    if (el.children.every((child) => typeof child === 'string')) {
      return `${comment}${pad}${open}${el.children.map((child) => escapeText(child as string)).join('')}</${el.tag}>`
    }
    const inner = el.children.map((child) => (typeof child === 'string' ? `${pad}  ${escapeText(child)}` : render(child, depth + 1, font))).join('\n')
    return `${comment}${pad}${open}\n${inner}\n${pad}</${el.tag}>`
  }
  const body = render(tree, 2)
  const colors = Object.entries({ ...DEFAULT_COLORS, ...(design.tokens?.colors ?? {}) })
  const fonts = (['heading', 'body', 'mono'] as const).map((role) => `  --font-${role}: ${fontStackOf(design.tokens, role)};`)
  const root = `:root {\n${[...colors.map(([name, hex]) => `  --color-${name}: ${hex};`), ...fonts].join('\n')}\n}`
  const reset = `*, *::before, *::after {\n  box-sizing: border-box;\n}\nbody {\n  margin: 0;\n}`
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${escapeText(board.title)}</title>`,
    '    <style>',
    // No `</style` can appear (values are escaped); kept closed in depth anyway.
    [root, reset, ...rules, ...(narrow.length ? [`@media (max-width: ${CODEGEN_BREAKPOINT - 1}px) {\n${narrow.join('\n')}\n}`] : [])]
      .join('\n\n')
      .replace(/<\/(?=style)/gi, '<\\/')
      .replace(/^(?=.)/gm, '      '),
    '    </style>',
    '  </head>',
    '  <body>',
    body,
    '    <!-- Icons: lucide (https://lucide.dev); e.g. load its script and call lucide.createIcons(). -->',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

// ---- React + Tailwind

/** Tailwind's spacing scale: px values with a named step. */
const SPACING: Record<number, string> = { 0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3', 14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10', 44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24', 112: '28', 128: '32', 144: '36', 160: '40', 176: '44', 192: '48', 208: '52', 224: '56', 240: '60', 256: '64', 288: '72', 320: '80', 384: '96' }
const RADIUS: Record<string, string> = { '2px': 'rounded-sm', '4px': 'rounded', '6px': 'rounded-md', '8px': 'rounded-lg', '12px': 'rounded-xl', '16px': 'rounded-2xl', '24px': 'rounded-3xl', '999px': 'rounded-full', '50%': 'rounded-full' }
const FONT_SIZE: Record<string, string> = { '12px': 'text-xs', '14px': 'text-sm', '16px': 'text-base', '18px': 'text-lg', '20px': 'text-xl', '24px': 'text-2xl', '30px': 'text-3xl', '36px': 'text-4xl', '48px': 'text-5xl', '60px': 'text-6xl' }
const WEIGHT: Record<string, string> = { '400': 'font-normal', '500': 'font-medium', '600': 'font-semibold', '700': 'font-bold', '800': 'font-extrabold' }

const arbitrary = (value: string) => value.replace(/\s+/g, '_')

/** `p-6`, `gap-[18px]`: a px length on the spacing scale, or an arbitrary value. */
function space(prefix: string, value: string): string {
  if (value === '0') return `${prefix}-0`
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value)
  if (match) {
    const n = Number(match[1])
    if (n === 0) return `${prefix}-0`
    const step = SPACING[Math.abs(n)]
    if (step) return `${n < 0 ? '-' : ''}${prefix}-${step}`
  }
  if (value === '100%') return `${prefix}-full`
  return `${prefix}-[${arbitrary(value)}]`
}

function paddingClasses(value: string): string[] {
  const parts = value.split(' ')
  const [t, r, b, l] = parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]] : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : parts
  if (t === r && r === b && b === l) return [space('p', t)]
  if (t === b && r === l) return [space('py', t), space('px', r)]
  return [space('pt', t), space('pr', r), space('pb', b), space('pl', l)]
}

/** CSS declarations as Tailwind classes; anything without a utility becomes `[prop:value]`. */
export function tailwindClasses(css: Decl[]): string[] {
  const out: string[] = []
  for (const [prop, value] of css) {
    switch (prop) {
      case 'display':
        out.push(value === 'flex' ? 'flex' : value === 'grid' ? 'grid' : value === 'inline-flex' ? 'inline-flex' : value === 'block' ? 'block' : `[display:${value}]`)
        break
      case 'flex-direction':
        out.push(value === 'column' ? 'flex-col' : 'flex-row')
        break
      case 'align-items':
        out.push({ 'flex-start': 'items-start', center: 'items-center', 'flex-end': 'items-end', stretch: 'items-stretch' }[value] ?? `items-[${value}]`)
        break
      case 'justify-content':
        out.push({ 'flex-start': 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' }[value] ?? `justify-[${value}]`)
        break
      case 'align-self':
        out.push(value === 'stretch' ? 'self-stretch' : `self-[${value}]`)
        break
      case 'flex-wrap':
        out.push('flex-wrap')
        break
      case 'flex':
        out.push(value === '1 1 0%' ? 'flex-1' : `flex-[${arbitrary(value)}]`)
        break
      case 'flex-shrink':
        out.push(value === '0' ? 'shrink-0' : 'shrink')
        break
      case 'gap':
        out.push(space('gap', value))
        break
      case 'padding':
        out.push(...paddingClasses(value))
        break
      case 'margin':
        out.push(value === '0' ? 'm-0' : value === '0 auto' ? 'mx-auto' : `m-[${arbitrary(value)}]`)
        break
      case 'max-width':
        out.push(value === '100%' ? 'max-w-full' : `max-w-[${arbitrary(value)}]`)
        break
      case 'max-height':
        out.push(`max-h-[${arbitrary(value)}]`)
        break
      case 'width':
        out.push(space('w', value))
        break
      case 'height':
        out.push(space('h', value))
        break
      case 'min-height':
        out.push(value === '100%' ? 'min-h-full' : value === '0' ? 'min-h-0' : `min-h-[${arbitrary(value)}]`)
        break
      case 'min-width':
        out.push(value === '0' ? 'min-w-0' : `min-w-[${arbitrary(value)}]`)
        break
      case 'position':
        out.push(value)
        break
      case 'top':
      case 'right':
      case 'bottom':
      case 'left':
        out.push(space(prop, value))
        break
      case 'grid-template-columns': {
        const match = /^repeat\((\d+), minmax\(0, 1fr\)\)$/.exec(value)
        out.push(match ? `grid-cols-${match[1]}` : value === 'minmax(0, 1fr)' ? 'grid-cols-1' : `grid-cols-[${arbitrary(value)}]`)
        break
      }
      case 'background-color':
        out.push(value === 'transparent' ? 'bg-transparent' : `bg-[${arbitrary(value)}]`)
        break
      case 'background-image':
        out.push(`bg-[${arbitrary(value.replace(/"/g, "'"))}]`)
        break
      case 'background-size':
        out.push(value === 'cover' ? 'bg-cover' : value === 'contain' ? 'bg-contain' : `[background-size:${arbitrary(value)}]`)
        break
      case 'background-position':
        out.push(value === 'center' ? 'bg-center' : `[background-position:${arbitrary(value)}]`)
        break
      case 'color':
        out.push(value === 'inherit' ? 'text-inherit' : `text-[${arbitrary(value)}]`)
        break
      case 'border-radius':
        out.push(RADIUS[value] ?? `rounded-[${arbitrary(value)}]`)
        break
      case 'box-shadow':
        out.push(`shadow-[${arbitrary(value)}]`)
        break
      case 'overflow':
        out.push(`overflow-${value}`)
        break
      case 'opacity':
        out.push(`opacity-[${value}]`)
        break
      case 'font-size':
        out.push(FONT_SIZE[value] ?? `text-[${value}]`)
        break
      case 'font-weight':
        out.push(WEIGHT[value] ?? `font-[${value}]`)
        break
      case 'line-height':
        out.push(`leading-[${value}]`)
        break
      case 'letter-spacing':
        out.push(`tracking-[${arbitrary(value)}]`)
        break
      case 'text-align':
        out.push(`text-${value}`)
        break
      case 'text-decoration':
        out.push(value === 'underline' ? 'underline' : 'line-through')
        break
      case 'white-space':
        out.push(value === 'nowrap' ? 'whitespace-nowrap' : 'whitespace-pre-wrap')
        break
      case 'object-fit':
        out.push(`object-${value}`)
        break
      case 'aspect-ratio':
        out.push(value === '1' ? 'aspect-square' : `aspect-[${value}]`)
        break
      case 'filter': {
        const match = /^blur\((\d+)px\)$/.exec(value)
        out.push(match ? `blur-[${match[1]}px]` : `[filter:${arbitrary(value)}]`)
        break
      }
      case 'font-family':
        // The body font is set once on the board; others are arbitrary families.
        out.push(`font-[${arbitrary(value.replace(/'/g, ''))}]`)
        break
      default:
        out.push(`[${prop}:${arbitrary(value)}]`)
    }
  }
  return [...new Set(out)]
}

/**
 * Mobile-first classes: a property `small` overrides gets the small value as its base class and
 * the design's value behind `md:` (`grid-cols-1 md:grid-cols-3`); the rest as `tailwindClasses`.
 */
export function responsiveClasses(css: Decl[], small: Decl[] | undefined): string[] {
  if (!small?.length) return tailwindClasses(css)
  const narrow = new Map(small)
  const out: string[] = []
  for (const decl of css) {
    const value = narrow.get(decl[0])
    if (value === undefined) out.push(...tailwindClasses([decl]))
    else out.push(...tailwindClasses([[decl[0], value]]), ...tailwindClasses([decl]).map((cls) => `md:${cls}`))
  }
  // A narrow-only property (a node hidden on phones) applies below md only.
  const own = new Set(css.map(([prop]) => prop))
  for (const decl of small) if (!own.has(decl[0])) out.push(...tailwindClasses([decl]).map((cls) => `max-md:${cls}`))
  return [...new Set(out)]
}

/** One board as a React component (TSX) styled with Tailwind; icons from lucide-react. */
export function boardToReact(design: Design, boardId: string): string {
  const board = boardOf(design, boardId)
  const tree = boardEl(design, board, false)
  const bodyFont = font({ tokens: design.tokens, mains: new Map(), useVars: false }, 'body')
  const icons = new Set<string>()
  const jsxText = (value: string) => (value.includes('\n') || /[{}]/.test(value) ? `{${JSON.stringify(value)}}` : escapeText(value))
  const render = (el: El, depth: number, inheritFont: string | null): string => {
    const pad = '  '.repeat(depth)
    // Drop the font family where it equals the inherited one: keeps the classes readable.
    const css = el.css.filter(([prop, value]) => !(prop === 'font-family' && value === inheritFont))
    const classes = responsiveClasses(css, el.small).join(' ')
    const comment = el.comment ? `${pad}{/* ${commentText(el.comment)} */}\n` : ''
    if (el.icon) {
      icons.add(el.icon.name)
      return `${comment}${pad}<${el.icon.name} className="${escapeAttr(classes)}" size={${el.icon.size}} aria-hidden />`
    }
    const attrs = [
      ...(classes ? [`className="${escapeAttr(classes)}"`] : []),
      ...el.attrs.map(([k, v]) => (k === 'defaultChecked' ? 'defaultChecked' : `${k}="${escapeAttr(v)}"`)),
    ].join(' ')
    const open = `<${el.tag}${attrs ? ` ${attrs}` : ''}`
    const font = el.css.find(([prop]) => prop === 'font-family')?.[1] ?? inheritFont
    if (el.children.length === 0) return `${comment}${pad}${open} />`
    if (el.children.every((child) => typeof child === 'string')) {
      return `${comment}${pad}${open}>${el.children.map((child) => jsxText(child as string)).join('')}</${el.tag}>`
    }
    const inner = el.children.map((child) => (typeof child === 'string' ? `${pad}  ${jsxText(child)}` : render(child, depth + 1, font))).join('\n')
    return `${comment}${pad}${open}>\n${inner}\n${pad}</${el.tag}>`
  }
  const body = render(tree, 2, bodyFont)
  const name = componentName(board.title)
  const imports = icons.size ? `import { ${[...icons].sort().join(', ')} } from 'lucide-react'\n\n` : ''
  return [
    `${imports}/**`,
    ` * ${commentText(board.title)} (${board.w}×${board.h}), exported from the Freebuff design "${commentText(design.title)}".`,
    ' * Tailwind classes with exact values; colours are the design tokens as hex.',
    ' */',
    `export default function ${name}() {`,
    '  return (',
    body,
    '  )',
    '}',
    '',
  ].join('\n')
}

// ---- Inspect: the CSS for one selected node

export type NodeCode = {
  /** The class the HTML export would give it (before de-duplication). */
  className: string
  /** The node's own declarations, colour tokens as `var(--color-…)`. */
  css: string
  /** The same as Tailwind classes, colours as hex. */
  tailwind: string
}

/**
 * The CSS one node gets in the code exports, for the inspector's Code section: the board (its
 * root) or a node, sized and placed by its parent's layout. Null when the node is not on it.
 */
export function nodeCode(design: Design, boardId: string, nodeId: string): NodeCode | null {
  const board = design.boards.find((entry) => entry.id === boardId)
  if (!board) return null
  const build = (useVars: boolean): El | null => {
    if (board.root.id === nodeId) return boardEl(design, board, useVars, true)
    const hit = findNode(board.root, nodeId)
    if (!hit?.parent) return null
    const ctx: Ctx = { tokens: design.tokens, mains: collectMains(design.boards), useVars, styles: design.styles }
    return nodeEl(hit.node, hit.parent.layout, ctx, nodeChain(board.root, nodeId).length - 1)
  }
  const html = build(true)
  const tw = build(false)
  if (!html || !tw) return null
  const lines = html.css.map(([prop, value]) => `  ${prop}: ${value};`)
  const narrow = html.small?.length
    ? [`\n@media (max-width: ${CODEGEN_BREAKPOINT - 1}px) {`, `  .${html.name} {`, ...html.small.map(([p, v]) => `    ${p}: ${v};`), '  }', '}']
    : []
  return {
    className: html.name,
    css: [`.${html.name} {`, ...lines, '}', ...narrow].join('\n'),
    tailwind: responsiveClasses(tw.css, tw.small).join(' '),
  }
}

// ---- per component

/** A design with one main component standing as a board of its own (for its code export). */
function componentDesign(design: Design, mainId: string): { design: Design; boardId: string } | null {
  const main = collectMains(design.boards).get(mainId)
  if (!main) return null
  const boardId = `component-${mainId}`.slice(0, 64)
  const { component: _main, absolute: _a, anchor: _b, x: _x, y: _y, ...root } = main
  const board: DesignBoard = {
    id: boardId,
    title: main.name ?? mainId,
    x: 0,
    y: 0,
    w: typeof main.w === 'number' ? main.w : 480,
    h: typeof main.h === 'number' ? main.h : 320,
    root,
  }
  return { design: { ...design, boards: [...design.boards, board] }, boardId }
}

/** One main component as a React + Tailwind component; null when `mainId` is not a main. */
export function componentToReact(design: Design, mainId: string): string | null {
  const made = componentDesign(design, mainId)
  return made ? boardToReact(made.design, made.boardId) : null
}

/** One main component as a standalone HTML + CSS document; null when `mainId` is not a main. */
export function componentToHtml(design: Design, mainId: string): string | null {
  const made = componentDesign(design, mainId)
  return made ? boardToHtml(made.design, made.boardId) : null
}
