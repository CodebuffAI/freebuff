import type { FreebuffAccessTier } from '../constants/freebuff-models'

export type SubscriberAccessTierCounts = Record<
  FreebuffAccessTier | 'unknown',
  number
>

export function subscriberAccessTierRows(
  counts: SubscriberAccessTierCounts | undefined,
): [string, string][] {
  return (
    [
      ['full', 'Full access'],
      ['limited', 'Limited access'],
      ['unknown', 'Unknown access tier'],
    ] as const
  ).map(([tier, label]) => [
    label,
    counts?.[tier].toLocaleString('en-US') ?? '—',
  ])
}
