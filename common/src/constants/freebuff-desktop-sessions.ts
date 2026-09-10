import {
  type FreebuffAccessTier,
  type FreebuffDesktopConcurrency,
} from './freebuff-model-entitlements'
import {
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_MUSE_SPARK_MODEL_IDS,
  freebuffModelIdMatches,
} from './freebuff-models'

/** Models that always use constrained Desktop concurrency. */
const FREEBUFF_DESKTOP_SLOT_BOUND_MODEL_IDS = [
  // Every quota-metered Desktop model must stay slot-bound until admit stamps
  // identify the tab; same-millisecond parallel admits otherwise pair
  // ambiguously when usage is finalized.
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  // Muse Spark, from the day it reached Desktop (2026-09-04). Metered like the
  // rows above it, so the same rule applies — and it earns the slot twice over:
  // its scarce resource is requests per minute against ceilings Meta meters per
  // TEAM and every Freebuff user shares, so one tab per user is also one more
  // bound on how many concurrent turns sit inside them.
  ...FREEBUFF_MUSE_SPARK_MODEL_IDS,
] as const

const FREEBUFF_DESKTOP_CONCURRENCY_LIMITS = {
  free: { 'slot-bound': 1, 'multi-tab': 3 },
  subscriber: { 'slot-bound': 3, 'multi-tab': 8 },
} as const

export function freebuffDesktopConcurrencyLimits(
  accessTier: FreebuffAccessTier | null | undefined,
  hasPaidPlan: boolean,
): Record<FreebuffDesktopConcurrency, number> {
  if (accessTier === 'limited' && !hasPaidPlan) {
    return { 'slot-bound': 1, 'multi-tab': 0 }
  }
  return hasPaidPlan
    ? FREEBUFF_DESKTOP_CONCURRENCY_LIMITS.subscriber
    : FREEBUFF_DESKTOP_CONCURRENCY_LIMITS.free
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

/** Client-persisted identity for a possibly unacknowledged Desktop POST. */
export const FREEBUFF_DESKTOP_ATTEMPT_HEADER = 'x-freebuff-desktop-attempt-id'

/** Versioned opt-in: instance ids become single-use execution claims. */
export const FREEBUFF_PURCHASE_CONTINUITY_HEADER =
  'x-freebuff-purchase-continuity'
