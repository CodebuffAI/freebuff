import type {
  FreebuffFreebucksInfo,
  FreebuffOffPeakPrice,
} from '../types/freebuff-session'
import { discountedSessionPrice } from './freebuff-first-tab-discount'

/** Resolve a server-owned daily policy, including windows crossing midnight. */
export function offPeakPriceAt(offer: FreebuffOffPeakPrice, now: number) {
  const start = new Date(now)
  start.setUTCHours(offer.startHourUtc, 0, 0, 0)
  if (+start > now) start.setUTCDate(start.getUTCDate() - 1)
  const end = new Date(start)
  end.setUTCHours(offer.endHourUtc, 0, 0, 0)
  if (+end <= +start) end.setUTCDate(end.getUTCDate() + 1)
  const active = now < +end
  if (!active) {
    start.setUTCDate(start.getUTCDate() + 1)
    end.setUTCDate(end.getUTCDate() + 1)
  }
  return {
    start,
    end,
    nextChangeAt: active ? +end : +start,
    price: active ? offer.price : offer.regularPrice,
    tagline: active
      ? `Off-peak pricing · ${offer.regularPrice} Freebucks/hour at peak`
      : `Peak pricing · ${offer.price} Freebucks/hour off-peak`,
  }
}

/** Apply the SERVER'S dated changes and recurring policies to new-session
 * quotes only. Never change balances or an already-admitted session's charge. */
export function applyFreebucksPriceChanges<
  T extends Pick<
    FreebuffFreebucksInfo,
    'prices' | 'listPrices' | 'priceNotices' | 'priceChanges' | 'firstTabDiscount' | 'offPeak'
  >,
>(info: T, now = Date.now()): T {
  const due = info.priceChanges?.filter((change) => Date.parse(change.at) <= now)
  let prices = info.prices
  let listPrices = info.listPrices
  let priceNotices = info.priceNotices
  const apply = (modelId: string, price: number, tagline: string) => {
    if (prices[modelId] === undefined) return
    const discounted = discountedSessionPrice(
      price,
      info.firstTabDiscount?.available ? info.firstTabDiscount.amount : 0,
    )
    if (prices[modelId] !== discounted)
      prices = { ...prices, [modelId]: discounted }
    if (listPrices && listPrices[modelId] !== price)
      listPrices = { ...listPrices, [modelId]: price }
    if (priceNotices?.[modelId] !== tagline)
      priceNotices = { ...priceNotices, [modelId]: tagline }
  }
  for (const change of (due ?? []).sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  )) {
    apply(change.modelId, change.price, change.tagline)
  }
  // Recurring policy remains authoritative after dated transitions expire.
  for (const [modelId, offer] of Object.entries(info.offPeak ?? {})) {
    const current = offPeakPriceAt(offer, now)
    apply(modelId, current.price, current.tagline)
  }
  if (
    !due?.length &&
    prices === info.prices &&
    listPrices === info.listPrices &&
    priceNotices === info.priceNotices
  )
    return info
  return {
    ...info,
    prices,
    ...(listPrices ? { listPrices } : {}),
    priceNotices,
    priceChanges: info.priceChanges?.filter(
      (change) => Date.parse(change.at) > now,
    ),
  }
}

export function nextFreebucksPriceChange(
  info:
    | Pick<FreebuffFreebucksInfo, 'priceChanges' | 'offPeak'>
    | null
    | undefined,
  now = Date.now(),
): number {
  return Math.min(
    ...(info?.priceChanges ?? [])
      .map((change) => Date.parse(change.at))
      .filter(Number.isFinite),
    ...Object.values(info?.offPeak ?? {}).map(
      (offer) => offPeakPriceAt(offer, now).nextChangeAt,
    ),
  )
}

/** Keep an open picker current after exhausted transitions and device sleep.
 * Re-arm even when a delayed wake leaves the price (and React deps) unchanged. */
export function watchFreebucksPriceChanges(
  info:
    | Pick<FreebuffFreebucksInfo, 'priceChanges' | 'offPeak'>
    | null
    | undefined,
  onChange: () => void,
): () => void {
  let next = nextFreebucksPriceChange(info)
  if (!Number.isFinite(next)) return () => {}
  let changes = info?.priceChanges
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    if (Number.isFinite(next))
      timer = setTimeout(
        wake,
        Math.min(2_147_483_647, Math.max(0, next - Date.now())),
      )
  }
  const wake = () => {
    clearTimeout(timer)
    const now = Date.now()
    const due = now >= next
    if (due) changes = changes?.filter((change) => Date.parse(change.at) > now)
    next = nextFreebucksPriceChange({ ...info, priceChanges: changes }, now)
    arm()
    if (due) onChange()
  }
  const resume = () => {
    if (Date.now() >= next) wake()
  }
  const visible = () => {
    if (document.visibilityState === 'visible') resume()
  }
  arm()
  // OpenTUI may provide window/document shims without DOM event APIs.
  globalThis.window?.addEventListener?.('focus', resume)
  globalThis.document?.addEventListener?.('visibilitychange', visible)
  return () => {
    clearTimeout(timer)
    globalThis.window?.removeEventListener?.('focus', resume)
    globalThis.document?.removeEventListener?.('visibilitychange', visible)
  }
}
