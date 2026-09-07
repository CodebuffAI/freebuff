/**
 * Peak-price copy for the pickers.
 *
 * Lives in `util/` rather than beside the price table in
 * `constants/freebuff-freebucks.ts` for one reason: that module is
 * export-excluded (scripts/public-export-manifest.txt) because it carries the
 * price table, and the CLI IS published. A public file importing an excluded
 * one fails the export leak check, which is how this landed here.
 *
 * Everything below reads the wire block a client already has, so nothing
 * private crosses the line.
 */
import {
  formatDeepSeekExpensiveWindowLocal,
  resolveWindowTimeZone,
} from '../constants/freebuff-peak-hours'

import type { FreebuffFreebucksPeak } from '../types/freebuff-session'

/** The user-facing name of the currency. Duplicated from the excluded
 *  constants module on purpose — see the note above; `cli/src/utils/freebucks.ts`
 *  carries its own copy for the same reason. */
const LABEL = 'Freebucks'

/** Whether `modelId` is peak-priced in this session block. */
export function isFreebucksPeakModel(
  freebucks: { peak?: FreebuffFreebucksPeak } | null | undefined,
  modelId: string,
): boolean {
  return freebucks?.peak?.modelIds.includes(modelId) ?? false
}

/**
 * What a picker says about a peak-priced row: a short BADGE and a tooltip
 * that explains it in the reader's own time zone.
 *
 * The server's prose notice says "until 3 AM PT", which is arithmetic for
 * everyone outside Pacific and unreadable on a machine whose clock the reader
 * cannot see. This names the window and its end in the zone the client is
 * running in (`timeZone` overrides it for a remote CLI rendering for someone
 * elsewhere), and `basePrice` lets the tooltip say what the price returns to
 * rather than leaving the reader to subtract.
 */
export function freebucksPeakCopy(params: {
  peak: FreebuffFreebucksPeak
  basePrice: number
  now?: number
  timeZone?: string
}): { badge: string; tooltip: string } {
  const now = params.now ?? Date.now()
  const zone = resolveWindowTimeZone(params.timeZone)
  const endsLocal = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  }).format(new Date(params.peak.endsAt))
  return {
    badge: 'Peak pricing',
    tooltip:
      `Peak pricing: +${params.peak.surcharge} ${LABEL} a session while DeepSeek charges double, ` +
      `${formatDeepSeekExpensiveWindowLocal(new Date(now), zone)} on weekdays. ` +
      `Back to ${params.basePrice} ${LABEL} at ${endsLocal}.`,
  }
}
