import { isFreebuffSubscriptionProModelId } from '../constants/freebuff-subscriptions'
import type { FreebuffFreebucksInfo } from '../types/freebuff-session'
import { getFreebuffModelMeter } from './freebuff-session-pools'

/**
 * Whether a picker must draw this row LOCKED: a paid-only row
 * (FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS) and an account without a live plan.
 *
 * Listed, not hidden — the thing standing between the user and the row is a
 * plan we sell, and hiding it gives the upgrade nothing to point at. A locked
 * row shows no Freebucks price (a figure beside a row Freebucks cannot open
 * reads as the way in) and a press opens the plans page instead of starting a
 * session. The server refuses the admission on every surface regardless
 * (`checkProOnlyModel`, `requiresSubscription: true`); this only decides what
 * the picker draws.
 *
 * `hasPaidSubscription` must be the SERVER's verdict — `subscription.tierId`
 * on the session response — never a local belief.
 */
export function freebuffPlanRequired(
  modelId: string,
  hasPaidSubscription: boolean,
  /** The session response's Freebucks block, when the caller has it. Its
   *  `planRequiredModelIds` is the SERVER's per-viewer verdict and wins over
   *  the static list: it also locks the rows a plan unlocks at LIMITED
   *  access (FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS) for a viewer there. */
  freebucks?: Pick<FreebuffFreebucksInfo, 'planRequiredModelIds'> | null,
): boolean {
  if (hasPaidSubscription) return false
  const serverVerdict = freebucks?.planRequiredModelIds
  if (serverVerdict) return serverVerdict.includes(modelId)
  return isFreebuffSubscriptionProModelId(modelId)
}

/** The locked row's short label, for a badge or a detail line. */
export const FREEBUFF_PLAN_REQUIRED_LABEL = 'Paid plan'

/** The locked row's sentence. Matches the server refusal's `availableHours`. */
export const FREEBUFF_PLAN_REQUIRED_LINE = 'Included with a paid plan.'

export type FreebucksRowIntent =
  | { kind: 'allow'; price: number | undefined; walletSpend: number }
  | { kind: 'paywall'; price: number; walletSpend: 0 }
  | { kind: 'confirm'; price: number; walletSpend: number; claimEarned?: true }
  | { kind: 'confirm'; price: undefined; walletSpend: undefined }

/** Advisory selection and admission policy. The caller supplies only a valid, unexpired session.
 * Null requires spending consent before trying admission; only undefined is legacy. */
export function freebucksRowIntent(
  freebucks: FreebuffFreebucksInfo | null | undefined,
  modelId: string,
  activeModelId: string | undefined,
): FreebucksRowIntent {
  const { budget, canStart } = getFreebuffModelMeter({
    model: modelId,
    freebucks,
  })
  const price = budget?.price
  if (modelId === activeModelId) return { kind: 'allow', price, walletSpend: 0 }
  if (freebucks === null)
    return { kind: 'confirm', price: undefined, walletSpend: undefined }
  if (!freebucks || price === undefined)
    return { kind: 'allow', price, walletSpend: 0 }
  if (!canStart) return { kind: 'paywall', price, walletSpend: 0 }
  if (freebucks.balance < price && freebucks.quotaExempt)
    return { kind: 'allow', price, walletSpend: 0 }
  const walletSpend = Math.max(0, price - freebucks.daily.remaining)
  if (freebucks.balance < price)
    return { kind: 'confirm', price, walletSpend, claimEarned: true }
  return activeModelId !== undefined || walletSpend > 0
    ? { kind: 'confirm', price, walletSpend }
    : { kind: 'allow', price, walletSpend }
}
