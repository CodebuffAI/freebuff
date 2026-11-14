/**
 * CLI side of the mock display-ad placements (`cliSplash`, `cliStatusline` and
 * its `/deals` list): the local flag, and a sponsor's colours as OpenTUI
 * colours.
 *
 * FLAGS. Every placement is off. To turn some on, add to the CLI's
 * `settings.json` (`~/.config/manicode/settings.json`, `manicode-dev` on a dev
 * stack, or `$FREEBUFF_CONFIG_DIR/settings.json`):
 *   "displayAds": "all"                          or
 *   "displayAds": ["cliSplash", "cliStatusline"]
 * Read once per process; restart the CLI after editing.
 *
 * COLOURS. A sponsor's `fill`/`ink` come from common's `sponsors.ts` only.
 * With truecolor they draw as-is and the tinted body is the fill blended over
 * `theme.surface`; without it (Apple Terminal) the fill snaps to the nearest
 * xterm-256 cube colour, the ink to indexed black or white, and the tint to
 * our own surface — a 12% wash cannot be shown in 256 colours.
 */
import {
  displayAdEnabled,
  displayAdPlacementId,
  type DisplayAdPlacement,
} from '@codebuff/common/ads/display-ads/placements'
import { isValidBrandHex } from '@codebuff/common/ads/inline-ad-layout'
import { RGBA, type ColorInput } from '@opentui/core'

import { loadSettings } from '../utils/settings'
import { supportsTruecolor } from '../utils/theme-system'

import type { ChatTheme } from '../types/theme-system'
import type { SponsorTheme } from '@codebuff/common/ads/display-ads/sponsor-theme'

let override: string | string[] | null | undefined

/** Whether a CLI display-ad placement draws (settings `displayAds`, read once). */
export function cliDisplayAdEnabled(
  placement: Extract<DisplayAdPlacement, 'cliSplash' | 'cliStatusline'>,
  settingsOverride: string | readonly string[] | null = (override ??=
    loadSettings().displayAds ?? null),
): boolean {
  return displayAdEnabled(placement, settingsOverride)
}

/** The ids CLI units pass through props so logging can attach later. */
export const CLI_DISPLAY_AD_PLACEMENT_IDS = {
  cliSplash: displayAdPlacementId('cliSplash', 'cli'),
  cliStatusline: displayAdPlacementId('cliStatusline', 'cli'),
  deals: displayAdPlacementId('deals', 'cli'),
} as const

export type CliDisplayAdPlacementId =
  (typeof CLI_DISPLAY_AD_PLACEMENT_IDS)[keyof typeof CLI_DISPLAY_AD_PLACEMENT_IDS]

export interface CliSponsorColors {
  /** Sponsor brand colour: header bands, the statusline row, filled CTA chips. */
  fill: ColorInput
  /** Text/icons on `fill`; also the background of an inverse chip. */
  ink: ColorInput
  /** The tinted body: `tintPct`% of fill over `theme.surface`. */
  tint: ColorInput
  /** Text on `tint`: our foreground, since the wash is ours plus a little fill. */
  tintText: ColorInput
  /** Secondary text on `tint`. */
  tintMuted: ColorInput
  /** 1px sponsor-colour border. */
  border: ColorInput
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]
const nearestLevel = (c: number): number =>
  CUBE_LEVELS.reduce(
    (best, level, i) =>
      Math.abs(level - c) < Math.abs(CUBE_LEVELS[best] - c) ? i : best,
    0,
  )

/** The xterm-256 colour-cube index nearest a `#rrggbb`. */
export function nearestXterm256(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 16 + 36 * nearestLevel(r) + 6 * nearestLevel(g) + nearestLevel(b)
}

/** Indexed black and white (cube corners, unaffected by the user's palette). */
const INDEXED_BLACK = 16
const INDEXED_WHITE = 231

export function cliSponsorColors(
  sponsor: SponsorTheme,
  theme: Pick<ChatTheme, 'surface' | 'foreground' | 'muted'>,
  {
    truecolor = supportsTruecolor(),
    tintPct = 12,
  }: { truecolor?: boolean; tintPct?: number } = {},
): CliSponsorColors {
  if (!truecolor) {
    const fill = RGBA.fromIndex(nearestXterm256(sponsor.fill))
    return {
      fill,
      ink: RGBA.fromIndex(sponsor.fillIsLight ? INDEXED_BLACK : INDEXED_WHITE),
      tint: theme.surface,
      tintText: theme.foreground,
      tintMuted: theme.muted,
      border: fill,
    }
  }
  return {
    fill: sponsor.fill,
    ink: sponsor.ink,
    tint: isValidBrandHex(theme.surface)
      ? sponsor.tint(tintPct, theme.surface)
      : theme.surface,
    tintText: theme.foreground,
    tintMuted: theme.muted,
    border: sponsor.fill,
  }
}
