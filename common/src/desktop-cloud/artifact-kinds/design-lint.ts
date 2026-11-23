import { HEX, emptyDesign, type Design, type DesignBoard, type DesignNode, type DesignTokens, type TextStyle } from './design'
import { collectMains } from './design'
import { hasLogic, logicScope, materializeBoardLogic, themedTokens } from './design-logic'
import { materializeBoard } from './design-resolve'

/**
 * Design lint: checks a design the way a reviewer would, from the model alone (no DOM), so the
 * editor's Checks tab and the agent's read_artifact (packages/internal kind-checks.ts
 * `designLintIssues`) return the same list. Each board is checked at its base size and at every
 * breakpoint it declares (shared styles and overrides resolved), once per finding.
 *   - contrast   text (and button labels) against the solid colour behind it, by WCAG 2.x: 4.5:1
 *                for body text, 3:1 for large text (24 px, or 18.66 px at weight 700+).
 *   - tap-target a control on a touch board (under 600 wide, or drawn in a device frame) smaller
 *                than 40 px: a small button, a small linked frame.
 *   - alt-text   an uploaded or remote image with no alt text.
 * Only what the model can know for sure is flagged: contrast is skipped (never guessed) when a
 * gradient, a background image, a translucent colour or a layer opacity sits between the text
 * and the colour behind it, or when the text may overlap a sibling (a child of an absolute frame,
 * a pinned node). A main component is checked where it lives, not once per instance.
 * Pure and deterministic.
 */

/**
 * Round 5 adds, for a design that publishes or installs a design system (system adherence):
 *   - off-token  a colour written as a hex where the system has tokens (fill, stroke, text colour).
 *   - off-scale  a gap or padding off the spacing scale (tokens.spacingScale, else multiples of
 *                the spacing unit).
 *   - off-type   text that sets its own size instead of using one of the system's text styles.
 * and for every design:
 *   - external-image  an image hotlinked from another site (import it as an upload instead).
 */
export type LintRule = 'contrast' | 'tap-target' | 'alt-text' | 'off-token' | 'off-scale' | 'off-type' | 'external-image'

export type LintIssue = {
  /** Stable per finding: `${rule}:${nodeId}`. */
  id: string
  rule: LintRule
  boardId: string
  nodeId: string
  /** One sentence for the Checks list. */
  message: string
  /** What to change, worded as a request (what "Ask Buffy to fix" sends). */
  fix: string
  /** Contrast only: the measured ratio, rounded to two places. */
  ratio?: number
}

export const LINT_LIMITS = { maxIssues: 200, minTap: 40, touchBoardWidth: 600 } as const

const DEFAULT_COLORS = emptyDesign().tokens!.colors

/** The renderer's type scale: size and default weight per style (DesignRenderer TEXT_SCALE). */
const TEXT_SIZE: Record<TextStyle, { size: number; weight: number }> = {
  display: { size: 64, weight: 700 },
  h1: { size: 44, weight: 700 },
  h2: { size: 32, weight: 700 },
  h3: { size: 20, weight: 600 },
  body: { size: 16, weight: 400 },
  small: { size: 14, weight: 400 },
  caption: { size: 12, weight: 600 },
  mono: { size: 14, weight: 400 },
}
const BUTTON = { sm: { height: 32, font: 13 }, md: { height: 40, font: 14 }, lg: { height: 48, font: 16 } } as const

type Rgb = [number, number, number]

/** An opaque colour's channels; null for transparent, a translucent hex, or an unknown name. */
export function opaqueRgb(value: string | undefined, tokens: DesignTokens | undefined): Rgb | null {
  if (value === undefined || value === 'transparent') return null
  const hex = HEX.test(value) ? value : tokens?.colors[value] ?? DEFAULT_COLORS[value]
  if (!hex || !HEX.test(hex)) return null
  let h = hex.slice(1).toLowerCase()
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  if (h.length === 8) {
    if (h.slice(6) !== 'ff') return null
    h = h.slice(0, 6)
  }
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** The WCAG contrast ratio of two opaque colours (1 to 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The ratio text of this size and weight needs (AA). */
export function requiredRatio(size: number, weight: number): number {
  return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
}

const round2 = (value: number) => Math.round(value * 100) / 100
const isTouchBoard = (board: DesignBoard) => board.w < LINT_LIMITS.touchBoardWidth || board.device !== undefined

/** What sits behind a node: a solid colour, or unknown (a gradient, an image, a translucent layer). */
type Backdrop = Rgb | 'unknown'

function label(node: DesignNode): string {
  if (node.name) return `“${node.name}”`
  if (node.type === 'text') return `“${node.text.length > 32 ? `${node.text.slice(0, 31)}…` : node.text}”`
  if (node.type === 'button') return `button “${node.label}”`
  return node.type
}

/** Every finding on the design, boards in order, at most `LINT_LIMITS.maxIssues`. */
export function lintDesign(design: Design): LintIssue[] {
  const issues: LintIssue[] = []
  /** The board being checked draws with these (its theme's colours). */
  let tokens = design.tokens
  const systemic = Boolean(design.system || design.installedSystems?.length)
  const scale = design.tokens?.spacingScale
  const unit = design.tokens?.spacingUnit ?? 8
  const onScale = (value: number) => value === 0 || (scale ? scale.includes(value) : value % (unit / 2) === 0)
  const tokenNames = new Set(Object.keys(design.tokens?.colors ?? {}))
  const push = (issue: LintIssue) => {
    if (seen.has(issue.id)) return
    seen.add(issue.id)
    if (issues.length < LINT_LIMITS.maxIssues) issues.push(issue)
  }

  const checkContrast = (board: DesignBoard, node: DesignNode, fg: string | undefined, bg: Backdrop, size: number, weight: number, what: string) => {
    if (bg === 'unknown') return
    const color = opaqueRgb(fg, tokens)
    if (!color) return
    const ratio = contrastRatio(color, bg)
    const need = requiredRatio(size, weight)
    if (ratio >= need) return
    push({
      id: `contrast:${node.id}`,
      rule: 'contrast',
      boardId: board.id,
      nodeId: node.id,
      ratio: round2(ratio),
      message: `${what} has contrast ${round2(ratio)}:1; it needs ${need}:1.`,
      fix: `Raise the contrast of ${what} (now ${round2(ratio)}:1, needs ${need}:1): darken or lighten its colour or its background, preferably by editing the colour tokens.`,
    })
  }

  const seen = new Set<string>()
  const scope = hasLogic(design) ? logicScope(design, undefined, collectMains(design.boards)) : null
  const drawn = design.boards.flatMap((board) =>
    [null, ...(board.breakpoints ?? []).map((entry) => entry.id)].map((breakpoint) => {
      const at = materializeBoard(board, design.styles, breakpoint)
      return scope ? materializeBoardLogic(at, scope) : at
    }),
  )
  const raw = new Map<string, DesignNode>()
  for (const board of design.boards) {
    const stack: DesignNode[] = [board.root]
    while (stack.length) {
      const node = stack.pop()!
      raw.set(node.id, node)
      if (node.type === 'frame') stack.push(...node.children)
    }
  }
  /** System adherence, once per stored node (not per breakpoint or repeat copy). */
  const adherence = (board: DesignBoard, node: DesignNode) => {
    const stored = raw.get(node.id)
    if (!stored) return
    if (systemic && tokenNames.size > 0) {
      for (const key of ['fill', 'stroke', 'color'] as const) {
        const value = (stored as Record<string, unknown>)[key]
        if (typeof value === 'string' && HEX.test(value) && !(stored.type === 'frame' && stored.fillStyle)) {
          push({
            id: `off-token:${stored.id}:${key}`,
            rule: 'off-token',
            boardId: board.id,
            nodeId: stored.id,
            message: `${label(stored)} uses ${value} for its ${key === 'color' ? 'colour' : key}, not a colour token.`,
            fix: `Set the ${key} of ${label(stored)} to one of the system's colour tokens (${[...tokenNames].slice(0, 6).join(', ')}) instead of ${value}.`,
          })
        }
      }
      if (stored.type === 'frame') {
        const pads = stored.padding === undefined ? [] : typeof stored.padding === 'number' ? [stored.padding] : stored.padding
        const off = [stored.gap, stored.rowGap, ...pads].filter((value): value is number => value !== undefined && !onScale(value))
        if (off.length) {
          push({
            id: `off-scale:${stored.id}`,
            rule: 'off-scale',
            boardId: board.id,
            nodeId: stored.id,
            message: `${label(stored)} has spacing ${[...new Set(off)].join(', ')} px, off the system's spacing scale.`,
            fix: `Change the gap and padding of ${label(stored)} to steps of the spacing scale (${scale ? scale.join(', ') : `multiples of ${unit}`} px).`,
          })
        }
      }
      if (stored.type === 'text' && (design.styles?.text?.length ?? 0) > 0 && !stored.textStyle && stored.fontSize !== undefined) {
        push({
          id: `off-type:${stored.id}`,
          rule: 'off-type',
          boardId: board.id,
          nodeId: stored.id,
          message: `${label(stored)} sets its own size (${stored.fontSize} px) instead of a text style.`,
          fix: `Apply one of the system's text styles to ${label(stored)} (textStyle) instead of a custom font size.`,
        })
      }
    }
    if (stored.type === 'image' && stored.src && /^https:/i.test(stored.src)) {
      push({
        id: `external-image:${stored.id}`,
        rule: 'external-image',
        boardId: board.id,
        nodeId: stored.id,
        message: `${label(stored)} is hotlinked from another site; it will not show on shared links and may change or vanish.`,
        fix: `Import the picture of ${label(stored)} with import_artifact_image and use its /_asset/ ref as the src.`,
      })
    }
  }
  for (const board of drawn) {
    tokens = themedTokens(design.tokens, board.theme)
    const touch = isTouchBoard(board)
    const boardBg = opaqueRgb(board.background ?? 'background', tokens) ?? 'unknown'
    const visit = (node: DesignNode, behind: Backdrop) => {
      if (node.hidden) return
      adherence(board, node)
      // A layer opacity blends with whatever is under it: no reliable colour from here down.
      const translucent = node.opacity !== undefined && node.opacity < 1
      if (node.type === 'frame') {
        // An opaque fill decides what is behind the children, whatever was under the frame.
        let here: Backdrop = behind
        if (translucent || node.fillImage || node.gradient) here = 'unknown'
        else if (node.fill !== undefined && node.fill !== 'transparent') here = opaqueRgb(node.fill, tokens) ?? 'unknown'
        if (node.linkTo !== undefined && touch) {
          const w = typeof node.w === 'number' ? node.w : null
          const h = typeof node.h === 'number' ? node.h : null
          const small = (w !== null && w < LINT_LIMITS.minTap) || (h !== null && h < LINT_LIMITS.minTap)
          if (small) {
            push({
              id: `tap-target:${node.id}`,
              rule: 'tap-target',
              boardId: board.id,
              nodeId: node.id,
              message: `${label(node)} is a link only ${Math.min(w ?? Infinity, h ?? Infinity)} px across; touch targets need ${LINT_LIMITS.minTap} px.`,
              fix: `Make the tap area of ${label(node)} at least ${LINT_LIMITS.minTap}×${LINT_LIMITS.minTap} px (padding or a larger w/h), keeping the visible size if it should look small.`,
            })
          }
        }
        // An instance's content is the main's: checked where the main lives.
        if (node.instanceOf !== undefined) return
        // In an absolute frame, or pinned over a stack, a child may sit on a sibling (a shape,
        // an image): what is behind it is unknown unless it brings its own fill.
        for (const child of node.children) visit(child, node.layout === 'absolute' || child.absolute ? 'unknown' : here)
        return
      }
      const bg: Backdrop = translucent ? 'unknown' : behind
      if (node.type === 'text') {
        const scale = TEXT_SIZE[node.style]
        checkContrast(board, node, node.color ?? 'text', bg, node.fontSize ?? scale.size, node.weight ?? scale.weight, `Text ${label(node)}`)
      } else if (node.type === 'button') {
        const size = BUTTON[node.size ?? 'md']
        if (node.variant === 'primary') {
          const own = opaqueRgb('primary', tokens)
          checkContrast(board, node, 'on-primary', translucent || !own ? 'unknown' : own, size.font, 600, `The label of ${label(node)}`)
        } else if (node.variant === 'secondary') {
          const own = opaqueRgb('background', tokens)
          checkContrast(board, node, 'text', translucent || !own ? 'unknown' : own, size.font, 600, `The label of ${label(node)}`)
        } else {
          checkContrast(board, node, 'text', bg, size.font, 600, `The label of ${label(node)}`)
        }
        if (touch && size.height < LINT_LIMITS.minTap) {
          push({
            id: `tap-target:${node.id}`,
            rule: 'tap-target',
            boardId: board.id,
            nodeId: node.id,
            message: `${label(node)} is ${size.height} px tall; touch targets need ${LINT_LIMITS.minTap} px.`,
            fix: `Give ${label(node)} size "md" or "lg" so it is at least ${LINT_LIMITS.minTap} px tall on this touch screen.`,
          })
        }
      } else if (node.type === 'image' && node.src !== undefined && node.alt.trim() === '') {
        push({
          id: `alt-text:${node.id}`,
          rule: 'alt-text',
          boardId: board.id,
          nodeId: node.id,
          message: `${label(node)} has no alt text.`,
          fix: `Write alt text for the image ${node.name ? `“${node.name}”` : node.id} that says what it shows (or what it is for, if it is a link).`,
        })
      }
    }
    visit(board.root, boardBg)
  }
  return issues
}
