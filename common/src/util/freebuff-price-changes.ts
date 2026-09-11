import type { FreebuffFreebucksInfo } from '../types/freebuff-session'

/** Apply the SERVER'S announced schedule, including on delayed responses. */
export function applyFreebucksPriceChanges<
  T extends Pick<FreebuffFreebucksInfo, 'prices' | 'priceNotices' | 'priceChanges'>,
>(info: T, now = Date.now()): T {
  const due = info.priceChanges?.filter(
    (change) => Date.parse(change.at) <= now,
  )
  if (!due?.length) return info
  const prices = { ...info.prices }
  const priceNotices = { ...info.priceNotices }
  for (const change of due.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  )) {
    if (prices[change.modelId] === undefined) continue
    prices[change.modelId] = change.price
    priceNotices[change.modelId] = change.tagline
  }
  return {
    ...info,
    prices,
    priceNotices,
    priceChanges: info.priceChanges?.filter(
      (change) => Date.parse(change.at) > now,
    ),
  }
}

export function nextFreebucksPriceChange(
  info: Pick<FreebuffFreebucksInfo, 'priceChanges'> | null | undefined,
): number {
  return Math.min(
    ...(info?.priceChanges ?? [])
      .map((change) => Date.parse(change.at))
      .filter(Number.isFinite),
  )
}

/** Wake an open picker at its quote's next change. Returns effect cleanup. */
export function watchFreebucksPriceChanges(
  info: Pick<FreebuffFreebucksInfo, 'priceChanges'> | null | undefined,
  onChange: () => void,
): () => void {
  const next = nextFreebucksPriceChange(info)
  if (!Number.isFinite(next)) return () => {}
  const timer = setTimeout(
    onChange,
    Math.min(2_147_483_647, Math.max(0, next - Date.now())),
  )
  return () => clearTimeout(timer)
}
