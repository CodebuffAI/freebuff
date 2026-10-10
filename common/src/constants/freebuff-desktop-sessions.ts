import {
  type FreebuffAccessTier,
  type FreebuffDesktopConcurrency,
} from './freebuff-model-entitlements'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_GPT_61_SOL_MODEL_ID,
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
  freebuffModelIdMatches,
} from './freebuff-models'

/** Models that always use constrained Desktop concurrency. */
const FREEBUFF_DESKTOP_SLOT_BOUND_MODEL_IDS = [
  // Every quota-metered Desktop model must stay slot-bound until admit stamps
  // identify the tab; same-millisecond parallel admits otherwise pair
  // ambiguously when usage is finalized.
  // GPT-6 Luna, 2026-09-22, in 5.6's slot: quota-metered, so slot-bound.
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  // GPT-6.1 Sol, the dearest row of all (2026-09-29).
  FREEBUFF_GPT_61_SOL_MODEL_ID,
  // MiMo 2.6 Pro, the dearest row after Gemini and paid-only.
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
  // DeepSeek Flash fast mode (2026-09-26): premium and metered like the rows
  // above, and a fan-out besides — one tab of it is already several requests.
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  // Muse Spark sat here from 2026-09-04 to 2026-10-10, held to one tab because
  // Meta rate-limited the Contributor tier per team. That limit is gone, so it
  // runs multi-tab like DeepSeek V4 Flash, each tab buying its own session.
] as const

const FREEBUFF_DESKTOP_CONCURRENCY_LIMITS = {
  free: { 'slot-bound': 1, 'multi-tab': 3 },
  subscriber: { 'slot-bound': 3, 'multi-tab': 8 },
} as const

/**
 * Tabs in each bucket for an account the server exempts from the tab cap
 * (Freebuff admins, whose quota is already exempt), so a Projects coordinator
 * can fan out as many threads as it needs. Finite only because slot-bound
 * sessions are numbered slots; it is a runaway guard, not a product limit.
 */
export const FREEBUFF_DESKTOP_UNCAPPED_TAB_LIMIT = 64

export function freebuffDesktopConcurrencyLimits(
  accessTier: FreebuffAccessTier | null | undefined,
  hasPaidPlan: boolean,
  uncapped = false,
): Record<FreebuffDesktopConcurrency, number> {
  if (uncapped) {
    return {
      'slot-bound': FREEBUFF_DESKTOP_UNCAPPED_TAB_LIMIT,
      'multi-tab': FREEBUFF_DESKTOP_UNCAPPED_TAB_LIMIT,
    }
  }
  if (accessTier === 'limited' && !hasPaidPlan) {
    return { 'slot-bound': 1, 'multi-tab': 0 }
  }
  return hasPaidPlan
    ? FREEBUFF_DESKTOP_CONCURRENCY_LIMITS.subscriber
    : FREEBUFF_DESKTOP_CONCURRENCY_LIMITS.free
}

/**
 * Tabs one account may run at once on one model, given its Freebucks price at
 * session start: a free model buys parallel agents at no cost, so one tab.
 * Takes the price because the CLI imports this module and cannot import
 * freebuff-freebucks (cut from the public export).
 */
export function freebuffDesktopModelTabLimit(
  sessionPrice: number | undefined,
  uncapped = false,
): number {
  return sessionPrice === 0 && !uncapped ? 1 : Infinity
}

export function getFreebuffDesktopConcurrency(
  model: string,
  accessTier: FreebuffAccessTier | null | undefined,
  hasPaidPlan = false,
): FreebuffDesktopConcurrency {
  if (
    FREEBUFF_DESKTOP_SLOT_BOUND_MODEL_IDS.some((modelId) =>
      freebuffModelIdMatches(model, modelId),
    )
  ) {
    return 'slot-bound'
  }
  return accessTier === 'limited' && !hasPaidPlan ? 'slot-bound' : 'multi-tab'
}

export function occupiesFreebuffDesktopSlot(
  model: string,
  accessTier: FreebuffAccessTier | null | undefined,
  hasPaidPlan = false,
): boolean {
  return (
    getFreebuffDesktopConcurrency(model, accessTier, hasPaidPlan) ===
    'slot-bound'
  )
}

/** Idle time after which Desktop ends a hosted session and frees its slot. */
export const FREEBUFF_DESKTOP_IDLE_RELEASE_MS = 15 * 60 * 1000

/** Pins an end/refund request to one window of a stable Desktop tab. */
export const FREEBUFF_DESKTOP_ADMITTED_AT_HEADER =
  'x-freebuff-desktop-admitted-at'

/**
 * Names the app making a session call. Freebuff Desktop sends `desktop`:
 * current CLI builds share Desktop's multi-session header and table, so
 * nothing else on the wire tells the two apart.
 */
export const FREEBUFF_CLIENT_HEADER = 'x-freebuff-client'
export const FREEBUFF_CLIENT_DESKTOP = 'desktop'

/**
 * The calling app's own version (`0.0.212`, `1.4.0`), sent by the CLI and
 * Desktop on session calls. Observe-only: friction lines
 * (`freebuff_session_refused`) carry it so a refusal can be tied to the build
 * that saw it. Never gates anything; a client may omit it.
 */
export const FREEBUFF_CLIENT_VERSION_HEADER = 'x-freebuff-client-version'

/** A random id Freebuff Desktop mints once per install and keeps across
 *  sign-ins. Not a credential. */
export const FREEBUFF_INSTALL_ID_HEADER = 'x-freebuff-install-id'

/**
 * Whether Freebuff Desktop's window was in front of the user when a
 * completions request left: `watching` (focused, recent input), `visible`
 * (on screen, another app focused) or `away` (hidden, minimized, locked or
 * idle). Omitted when the app cannot tell.
 */
export const FREEBUFF_ATTENTION_HEADER = 'x-freebuff-attention'
export const FREEBUFF_ATTENTION_STATES = ['watching', 'visible', 'away'] as const
export type FreebuffAttention = (typeof FREEBUFF_ATTENTION_STATES)[number]

export function parseFreebuffAttention(
  value: unknown,
): FreebuffAttention | undefined {
  return (FREEBUFF_ATTENTION_STATES as readonly unknown[]).includes(value)
    ? (value as FreebuffAttention)
    : undefined
}

/** Client-persisted identity for a possibly unacknowledged Desktop POST. */
export const FREEBUFF_DESKTOP_ATTEMPT_HEADER = 'x-freebuff-desktop-attempt-id'

/** Renew this tab's live paid hour in place: charge its price again and
 *  restart its hour. The value is a client UUID that makes retries
 *  charge once. */
export const FREEBUFF_SESSION_RENEWAL_HEADER = 'x-freebuff-session-renewal-id'

/** Versioned opt-in: instance ids become single-use execution claims. */
export const FREEBUFF_PURCHASE_CONTINUITY_HEADER =
  'x-freebuff-purchase-continuity'

/** Every claim a 0.0.197+ CLI mints on the purchase protocol starts with this.
 *  The server reads it to tell the CLI's claims from Desktop tabs: only a CLI
 *  claim can be the successor of a legacy single-session CLI hour. */
export const FREEBUFF_CLI_CLAIM_PREFIX = 'cli:'

export function isFreebuffCliClaim(
  instanceId: string | null | undefined,
): boolean {
  return !!instanceId?.startsWith(FREEBUFF_CLI_CLAIM_PREFIX)
}
