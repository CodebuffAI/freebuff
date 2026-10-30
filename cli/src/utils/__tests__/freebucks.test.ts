import { describe, expect, test } from 'bun:test'

import {
  freebucksHeaderLine,
  freebucksRefundLine,
  freebucksResetCountdown,
  freebucksPriceFor,
  freebucksPriceText,
  freebucksRowIntent,
  sortModelsByPrice,
} from '../freebucks'

import type { FreebuffFreebucksInfo } from '@codebuff/common/types/freebuff-session'

/** 30 left in today's pool, 20 banked, GLM 5 / MiMo 10 / Flash 15. */
const metered = (
  over: Partial<FreebuffFreebucksInfo> = {},
): FreebuffFreebucksInfo => ({
  balance: 50,
  daily: {
    limit: 75,
    spent: 45,
    remaining: 30,
    resetAt: '2026-09-05T07:00:00Z',
  },
  wallet: { balance: 20, monthlyBonus: 0 },
  spend: { limitUsd: 1.5, resetAt: '2026-09-05T07:00:00Z' },
  monthly: {
    limitUsd: 25,
    spentUsd: 5,
    remainingUsd: 20,
    resetAt: '2026-10-01T07:00:00Z',
  },
  planId: null,
  prices: { glm: 5, mimo: 10, flash: 15 },
  ...over,
})

describe('freebucksRowIntent', () => {
  test('an unmetered account is never asked anything', () => {
    expect(freebucksRowIntent(undefined, 'glm', undefined).kind).toBe('allow')
  })

  test('a row the price map does not carry falls through unmetered', () => {
    // The map is the allowlist: an absent row is metered by whatever metered it
    // before, so the picker must not invent a price or a question for it.
    expect(freebucksRowIntent(metered(), 'muse', undefined)).toEqual({
      kind: 'allow',
      price: undefined,
      walletSpend: 0,
    })
  })

  test('what the pool covers outright is just bought', () => {
    expect(freebucksRowIntent(metered(), 'glm', undefined)).toEqual({
      kind: 'allow',
      price: 5,
      walletSpend: 0,
    })
  })

  test('what the pool cannot cover asks, naming only the wallet share', () => {
    const intent = freebucksRowIntent(
      metered({
        daily: { limit: 75, spent: 65, remaining: 10, resetAt: 'x' },
      }),
      'flash',
      undefined,
    )
    expect(intent).toEqual({ kind: 'confirm', price: 15, walletSpend: 5 })
  })

  test('pool and wallet together decide affordability, not the pool alone', () => {
    const intent = freebucksRowIntent(
      metered({
        balance: 25,
        daily: { limit: 75, spent: 70, remaining: 5, resetAt: 'x' },
        wallet: { balance: 20, monthlyBonus: 0 },
      }),
      'flash',
      undefined,
    )
    expect(intent).toEqual({ kind: 'confirm', price: 15, walletSpend: 10 })
  })

  test('a balance that exactly equals the price buys the session', () => {
    // The boundary: `<=` here would refuse a session the server admits and
    // leave the last Freebucks in the account unspendable.
    const intent = freebucksRowIntent(
      metered({
        balance: 15,
        daily: { limit: 75, spent: 75, remaining: 0, resetAt: 'x' },
        wallet: { balance: 15, monthlyBonus: 0 },
      }),
      'flash',
      undefined,
    )
    expect(intent.kind).toBe('confirm')
    expect(intent.walletSpend).toBe(15)
  })

  test('one short of the price is a wall', () => {
    expect(
      freebucksRowIntent(
        metered({
          balance: 14,
          daily: { limit: 75, spent: 75, remaining: 0, resetAt: 'x' },
          wallet: { balance: 14, monthlyBonus: 0 },
        }),
        'flash',
        undefined,
      ),
    ).toEqual({ kind: 'paywall', price: 15, walletSpend: 0 })
  })

  test('re-picking the running model never asks', () => {
    expect(freebucksRowIntent(metered(), 'glm', 'glm').kind).toBe('allow')
  })

  test('switching away from a running session asks', () => {
    expect(freebucksRowIntent(metered(), 'glm', 'flash')).toEqual({
      kind: 'confirm',
      price: 5,
      walletSpend: 0,
    })
  })

  test('a switch that also dips into the wallet stays ONE question', () => {
    // Both conditions hold. The caller words the wallet copy and folds the
    // session ending in as a clause; what matters here is that it is a single
    // verdict carrying the wallet share, never two stacked asks.
    expect(
      freebucksRowIntent(
        metered({
          daily: { limit: 75, spent: 70, remaining: 5, resetAt: 'x' },
        }),
        'flash',
        'glm',
      ),
    ).toEqual({ kind: 'confirm', price: 15, walletSpend: 10 })
  })

  test('a wall stays a wall even mid-session', () => {
    expect(
      freebucksRowIntent(
        metered({
          balance: 4,
          daily: { limit: 75, spent: 75, remaining: 0, resetAt: 'x' },
          wallet: { balance: 4, monthlyBonus: 0 },
        }),
        'glm',
        'flash',
      ).kind,
    ).toBe('paywall')
  })
})

describe('ordering', () => {
  const rows = [
    { id: 'flash', displayName: 'DeepSeek V4 Flash' },
    { id: 'glm', displayName: 'GLM 5.3 Flash' },
    { id: 'mimo', displayName: 'MiMo 2.5' },
  ]

  test('cheapest first when metered', () => {
    expect(sortModelsByPrice(rows, metered()).map((r) => r.id)).toEqual([
      'glm',
      'mimo',
      'flash',
    ])
  })

  test('an unmetered account keeps the catalog order', () => {
    // Not alphabetical: the catalog leads with the recommended row, and a name
    // sort would quietly replace that for every account not on the meter.
    expect(sortModelsByPrice(rows, undefined)).toBe(rows)
  })

  test('an unpriced row sorts last, not first', () => {
    // `undefined` is not free.
    const withUnpriced = [{ id: 'muse', displayName: 'Muse Spark' }, ...rows]
    expect(sortModelsByPrice(withUnpriced, metered()).map((r) => r.id)).toEqual(
      ['glm', 'mimo', 'flash', 'muse'],
    )
  })

  test('equal prices break on name, so the order is stable', () => {
    const tied = [
      { id: 'solar', displayName: 'Solar Pro 4' },
      { id: 'luna', displayName: 'GPT-6 Luna' },
    ]
    const prices = { solar: 20, luna: 20 }
    expect(
      sortModelsByPrice(tied, metered({ prices })).map((r) => r.id),
    ).toEqual(['luna', 'solar'])
  })
})

describe('the header line', () => {
  test('shows session balances and ignores legacy dollar caps', () => {
    expect(freebucksHeaderLine(metered())).toBe(
      '6/15 hours daily · 4 hours in wallet',
    )
  })

  test('omits the allowance a server did not send, rather than showing $0', () => {
    // "$0 left" to somebody with a full allowance is worse than saying nothing.
    const { monthly: _drop, ...rest } = metered()
    expect(freebucksHeaderLine(rest as FreebuffFreebucksInfo)).toBe(
      '6/15 hours daily · 4 hours in wallet',
    )
  })

  test('carries the reset countdown when given a clock', () => {
    const now = Date.parse('2026-09-05T02:48:00Z') // 4h 12m before the fixture's reset
    expect(freebucksHeaderLine(metered(), now)).toBe(
      '6/15 hours daily · resets in 4h 12m · 4 hours in wallet',
    )
  })

  test('the countdown reads hours and minutes, then days, then "now"', () => {
    const reset = '2026-09-05T07:00:00Z'
    expect(
      freebucksResetCountdown(reset, Date.parse('2026-09-05T06:22:00Z')),
    ).toBe('38m')
    expect(
      freebucksResetCountdown(reset, Date.parse('2026-09-05T02:48:00Z')),
    ).toBe('4h 12m')
    expect(
      freebucksResetCountdown(reset, Date.parse('2026-09-03T01:00:00Z')),
    ).toBe('2d 6h')
    expect(
      freebucksResetCountdown(reset, Date.parse('2026-09-05T07:00:01Z')),
    ).toBe('now')
  })

  test('hides an empty wallet, as Web and Desktop do', () => {
    expect(
      freebucksHeaderLine(metered({ wallet: { balance: 0, monthlyBonus: 0 } })),
    ).toBe('6/15 hours daily')
  })

  test('rounds hours down to whole hours, so a balance never reads as more than it buys', () => {
    expect(
      freebucksHeaderLine(
        metered({
          daily: { limit: 75, spent: 46, remaining: 29, resetAt: 'x' },
          wallet: { balance: 6, monthlyBonus: 0 },
        }),
      ),
    ).toBe('5/15 hours daily · 1 hour in wallet')
  })

  test('a wallet under an hour is hidden, never "0 hours"', () => {
    expect(
      freebucksHeaderLine(metered({ wallet: { balance: 0.4, monthlyBonus: 0 } })),
    ).toBe('6/15 hours daily')
    expect(
      freebucksHeaderLine(metered({ wallet: { balance: 5, monthlyBonus: 0 } })),
    ).toBe('6/15 hours daily · 1 hour in wallet')
  })
})

describe('the price text', () => {
  test('is the multiplier of the 1x hour', () => {
    expect(freebucksPriceText(10)).toBe('2x')
    expect(freebucksPriceText(15)).toBe('3x')
  })

  test('says "1x" and "Free" where a row label stays blank, never "0x"', () => {
    expect(freebucksPriceText(5)).toBe('1x')
    expect(freebucksPriceText(0)).toBe('Free')
  })
})

describe('freebucksPriceFor', () => {
  test('is undefined off the meter and for a row the map omits', () => {
    expect(freebucksPriceFor(undefined, 'glm')).toBeUndefined()
    expect(freebucksPriceFor(metered(), 'nope')).toBeUndefined()
  })
})

describe('the refund receipt', () => {
  test('names half the price less usage, never the time left on the hour', () => {
    // The whole point of the line: six reports in two hours read the refund as
    // pro-rated by elapsed minutes.
    expect(freebucksRefundLine(10, false)).toBe(
      "2 hours of balance returned: half the session's price less what it used, not the time left on it.",
    )
    expect(freebucksRefundLine(5, false)).toBe(
      "1 hour of balance returned: half the session's price less what it used, not the time left on it.",
    )
  })

  test('a settled zero says so, and says what a refund returns', () => {
    // The reported case. Silence here is what users read as "the feature was
    // removed"; it must not read as an error either.
    expect(freebucksRefundLine(0, false)).toBe(
      "No hours returned: refunds apply only to full access sessions ended within 30 minutes, and a refund never refills a daily allowance already used up. A refund is half a session's price less what it used, in whole hours, never unused time.",
    )
  })

  test('a pending receipt promises the rule, not a number', () => {
    expect(freebucksRefundLine(null, true)).toBe(
      "Refund settling: half this session's price less what it used may come back, in whole hours.",
    )
    // Pending outranks a stale amount: the settled figure is not known yet.
    expect(freebucksRefundLine(4, true)).toBe(
      "Refund settling: half this session's price less what it used may come back, in whole hours.",
    )
  })

  test('says nothing when no receipt exists', () => {
    expect(freebucksRefundLine(null, false)).toBeNull()
  })
})
