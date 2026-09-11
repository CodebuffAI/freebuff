import { describe, expect, it } from 'bun:test'

import {
  AD_SPEND_LEDGER_REASONS,
  AD_STATEMENT_KINDS,
  AD_POSTPAID_DEFAULT_CREDIT_LINE_CENTS,
  AD_TOP_UP_MAX_CENTS,
  AD_TOP_UP_MIN_CENTS,
  AD_TOP_UP_PRESET_CENTS,
  AD_TOP_UP_STEP_CENTS,
  isCreditReason,
  isPlausibleCollectedCents,
  isValidTopUpCents,
  statementKindForReason,
  topUpAmountError,
} from '../freebuff-topups'

describe('the entry rule', () => {
  it('accepts every preset', () => {
    // A button on our own dialog that our own validator refuses is the
    // stupidest possible bug, and it is one constant edit away at all times.
    for (const preset of AD_TOP_UP_PRESET_CENTS) {
      expect(topUpAmountError(preset)).toBeNull()
    }
  })

  it('accepts the exact boundaries', () => {
    expect(isValidTopUpCents(AD_TOP_UP_MIN_CENTS)).toBe(true)
    expect(isValidTopUpCents(AD_TOP_UP_MAX_CENTS)).toBe(true)
  })

  it('rejects just outside them, and says which end', () => {
    expect(topUpAmountError(AD_TOP_UP_MIN_CENTS - 1)).toContain('minimum')
    expect(topUpAmountError(AD_TOP_UP_MAX_CENTS + 100)).toContain('invoice')
  })

  it('rejects part-dollar amounts', () => {
    expect(topUpAmountError(50_050)).toBe('Top up in whole dollars.')
  })

  it('rejects nonsense rather than coercing it', () => {
    expect(topUpAmountError(Number.NaN)).toBeTruthy()
    expect(topUpAmountError(Number.POSITIVE_INFINITY)).toBeTruthy()
    expect(topUpAmountError(1.5)).toBeTruthy()
    expect(topUpAmountError(-50_000)).toBeTruthy()
  })

  it('never repairs an amount, only refuses it', () => {
    // There is deliberately no normalizeTopUpCents. Snapping-and-clamping is
    // right for a slider and catastrophic for money: it would turn a $20,000
    // top-up into the cap with no error anywhere.
    const constants = require('../freebuff-topups') as Record<string, unknown>
    expect(constants.normalizeTopUpCents).toBeUndefined()
  })

  it('gives every rejection a message an advertiser can act on', () => {
    for (const bad of [0, 1, 4_999, 50_050, 5_000_000]) {
      const message = topUpAmountError(bad)
      expect(message).toBeTruthy()
      expect(message!.length).toBeGreaterThan(10)
    }
  })

  it('is a whole-dollar step, so presets are all round', () => {
    for (const preset of AD_TOP_UP_PRESET_CENTS) {
      expect(preset % AD_TOP_UP_STEP_CENTS).toBe(0)
    }
  })
})

describe('placements postpaid defaults', () => {
  it('starts new card-on-file advertisers with a $200 credit line', () => {
    expect(AD_POSTPAID_DEFAULT_CREDIT_LINE_CENTS).toBe(20_000)
  })
})

describe('the collected-amount rule is deliberately looser', () => {
  it('accepts amounts the entry rule would refuse', () => {
    // Tax-inclusive presentment, a promotion code, or Stripe rounding can all
    // produce a non-round net. The money is already ours by then; refusing it
    // would strand a payment with no balance and no refund.
    expect(isValidTopUpCents(50_137)).toBe(false)
    expect(isPlausibleCollectedCents(50_137)).toBe(true)

    expect(isValidTopUpCents(1_00)).toBe(false)
    expect(isPlausibleCollectedCents(1_00)).toBe(true)
  })

  it('still refuses nonsense', () => {
    expect(isPlausibleCollectedCents(0)).toBe(false)
    expect(isPlausibleCollectedCents(-1)).toBe(false)
    expect(isPlausibleCollectedCents(1.5)).toBe(false)
    expect(isPlausibleCollectedCents(Number.NaN)).toBe(false)
  })

  it('caps at an absurd ceiling rather than the entry maximum', () => {
    expect(isPlausibleCollectedCents(AD_TOP_UP_MAX_CENTS * 2)).toBe(true)
    expect(isPlausibleCollectedCents(AD_TOP_UP_MAX_CENTS * 2 + 1)).toBe(false)
  })
})

describe('ledger reasons and what the advertiser is shown', () => {
  it('maps every reason to a statement kind', () => {
    for (const reason of AD_SPEND_LEDGER_REASONS) {
      const kind = statementKindForReason(reason)
      expect(AD_STATEMENT_KINDS).toContain(kind)
    }
  })

  it('never shows a chargeback as a refund', () => {
    // "Refunded" on this console means we caught invalid activity and gave
    // the money back — a trust win we show on purpose. A chargeback is the
    // opposite event and must not borrow the word.
    expect(statementKindForReason('chargeback')).toBe('adjustment')
    expect(statementKindForReason('refund')).toBe('refund')
  })

  it('knows which direction each reason moves money', () => {
    expect(isCreditReason('topup')).toBe(true)
    expect(isCreditReason('refund')).toBe(true)
    expect(isCreditReason('spend')).toBe(false)
    expect(isCreditReason('chargeback')).toBe(false)
  })

  it('has a distinct database reason for chargeback even though the UI does not', () => {
    // One stops serving and one does not, so the database must tell them
    // apart even where the statement deliberately does not.
    expect(AD_SPEND_LEDGER_REASONS).toContain('chargeback')
    expect(AD_STATEMENT_KINDS).not.toContain('chargeback')
  })
})
