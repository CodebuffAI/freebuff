import type { FreebuffFreebucksInfo } from '../types/freebuff-session'
import { getFreebuffModelMeter } from './freebuff-session-pools'

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
