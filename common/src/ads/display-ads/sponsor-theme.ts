/**
 * One sponsor colour pair → everything a display-ad placement paints with.
 *
 * A sponsor states a `fill` (its brand colour) and optionally an `ink` (text
 * and icons drawn ON the fill). Every placement, on Desktop, Cloud and the
 * CLI, derives its surfaces from these two values through this module, so a
 * sponsor's colours are set in exactly one place (`sponsors.ts`).
 *
 * When `ink` is omitted it is derived: near-black or white, whichever reads
 * better on the fill, tested against WCAG's 4.5:1 for normal text (every
 * sRGB fill gets an ink that clears it; the test walks the cube).
 *
 * Pure functions over `#rrggbb` strings, no DOM, no terminal: the Desktop
 * stylesheet does its own tints with `color-mix()` against the app's tokens,
 * and the CLI blends with `tint()` against its theme surface.
 */
import { isValidBrandHex } from '../inline-ad-layout'

export interface SponsorColors {
  /** The sponsor's brand colour, `#rrggbb`. */
  fill: string
  /** Text/icon colour on `fill`, `#rrggbb`. Derived from `fill` when omitted. */
  ink?: string
}

export interface SponsorTheme {
  fill: string
  ink: string
  /** WCAG contrast ratio of `ink` on `fill` (1–21). */
  contrast: number
  /** Whether `fill` is a light colour (so dark ink sits on it). */
  fillIsLight: boolean
  /** `pct`% of `fill` blended over `over` (`#rrggbb`), as `#rrggbb`. */
  tint(pct: number, over: string): string
}

/** WCAG AA for normal-size text. */
export const MIN_INK_CONTRAST = 4.5

/** The two derived inks. Near-black, not pure black, matching the sponsor fixtures. */
export const DARK_INK = '#0a0a0a'
export const LIGHT_INK = '#ffffff'

type Rgb = readonly [number, number, number]

function parseHex(hex: string): Rgb {
  if (!isValidBrandHex(hex)) {
    throw new Error(`sponsor colour must be #rrggbb, got ${JSON.stringify(hex)}`)
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

const toHex = (rgb: Rgb): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The derived ink for a fill: whichever of DARK_INK / LIGHT_INK contrasts
 * more. Near-black gives up a little range, so for the narrow band of
 * mid-luminance fills where neither reaches 4.5:1 it falls back to pure
 * black, which does.
 */
export function deriveInk(fill: string): string {
  const dark = contrastRatio(DARK_INK, fill)
  const light = contrastRatio(LIGHT_INK, fill)
  if (Math.max(dark, light) < MIN_INK_CONTRAST) return '#000000'
  return dark >= light ? DARK_INK : LIGHT_INK
}

/** `pct`% (0–100, clamped) of `fg` blended over `bg` in sRGB, as `#rrggbb`. */
export function mixHex(fg: string, bg: string, pct: number): string {
  const t = Math.min(100, Math.max(0, pct)) / 100
  const f = parseHex(fg)
  const b = parseHex(bg)
  const at = (i: 0 | 1 | 2) => f[i] * t + b[i] * (1 - t)
  return toHex([at(0), at(1), at(2)])
}

/**
 * Resolve a sponsor's colours. Throws on a malformed hex: the only input is
 * checked-in fixture data, so a typo should fail its test, not render grey.
 * A stated `ink` is kept as the sponsor's choice even below 4.5:1; check
 * `contrast` (the fixture test does) rather than overriding a brand.
 */
export function resolveSponsorTheme(colors: SponsorColors): SponsorTheme {
  const fill = colors.fill.toLowerCase()
  parseHex(fill)
  const ink = (colors.ink ?? deriveInk(fill)).toLowerCase()
  parseHex(ink)
  return {
    fill,
    ink,
    contrast: contrastRatio(fill, ink),
    fillIsLight: deriveInk(fill) !== LIGHT_INK,
    tint: (pct, over) => mixHex(fill, over, pct),
  }
}
