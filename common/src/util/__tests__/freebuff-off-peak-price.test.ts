import { expect, spyOn, test } from 'bun:test'
import { freebucksOffPeakCopy } from '../freebuff-off-peak-price'

const quote = {
  prices: { flash: 10 },
  offPeak: {
    flash: { startHourUtc: 22, endHourUtc: 6, price: 10, regularPrice: 15 },
  },
}

test('formats both sides of local midnight and seasonal time changes', () => {
  const summer = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-09-17T23:00:00Z'),
    timeZone: 'America/Los_Angeles',
  })!
  expect(summer.tooltip).toBe(
    'Off-peak: 10 Freebucks/hour, daily 3:00 PM–11:00 PM PDT.',
  )
  const winter = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-12-01T23:00:00Z'),
    timeZone: 'America/Los_Angeles',
  })!
  expect(winter.tooltip).toContain('2:00 PM–10:00 PM PST')
  const germany = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-09-17T23:00:00Z'),
    timeZone: 'Europe/Berlin',
  })!
  expect(germany.tooltip).toContain('12:00 AM–8:00 AM GMT+2')
  const dst = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-10-24T23:00:00Z'),
    timeZone: 'Europe/Berlin',
  })!
  expect(dst.tooltip).toContain('12:00 AM GMT+2–7:00 AM GMT+1')
})

test('recognizes stacked first-tab discounts without replacing the quoted price', () => {
  const discounted = {
    ...quote,
    prices: { flash: 0 },
    firstTabDiscount: { amount: 10, available: true },
  }
  const copy = freebucksOffPeakCopy(discounted, 'flash', {
    now: Date.parse('2026-09-17T23:00:00Z'),
    timeZone: 'America/Los_Angeles',
  })!
  expect(copy.active).toBe(true)
  expect(copy.tooltip).toBe(
    'Off-peak: 10 Freebucks/hour, daily 3:00 PM–11:00 PM PDT.',
  )
  expect(discounted.prices.flash).toBe(0)
})

test('does not invent an offer on older servers or unpriced models', () => {
  expect(
    freebucksOffPeakCopy({ prices: { flash: 10 } }, 'flash'),
  ).toBeUndefined()
  expect(freebucksOffPeakCopy(quote, 'other')).toBeUndefined()
  expect(freebucksOffPeakCopy(null, 'flash')).toBeUndefined()
})

test('quotes UTC hours, rather than throwing, on a device that cannot name its zone', () => {
  // The exact production crash: the Web picker calls this with no zone while
  // rendering each row, the runtime reported `Etc/Unknown`, and
  // `new Intl.DateTimeFormat(undefined, { timeZone: 'Etc/Unknown' })` threw.
  const original = Intl.DateTimeFormat.prototype.resolvedOptions
  const spy = spyOn(
    Intl.DateTimeFormat.prototype,
    'resolvedOptions',
  ).mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), timeZone: 'Etc/Unknown' }
  })
  try {
    const copy = freebucksOffPeakCopy(quote, 'flash', {
      now: Date.parse('2026-09-17T23:00:00Z'),
    })!
    expect(copy.tooltip).toBe(
      'Off-peak: 10 Freebucks/hour, daily 10:00 PM–6:00 AM UTC.',
    )
  } finally {
    spy.mockRestore()
  }
  // Same answer for a caller that passes the unusable name itself.
  expect(
    freebucksOffPeakCopy(quote, 'flash', {
      now: Date.parse('2026-09-17T23:00:00Z'),
      timeZone: 'Etc/Unknown',
    })!.tooltip,
  ).toBe('Off-peak: 10 Freebucks/hour, daily 10:00 PM–6:00 AM UTC.')
})

test('does not label a stale regular-price quote as discounted', () => {
  const copy = freebucksOffPeakCopy(
    { ...quote, prices: { flash: 15 } },
    'flash',
    {
      now: Date.parse('2026-09-17T23:00:00Z'),
    },
  )!
  expect(copy.active).toBe(false)
  expect(copy.tooltip).toContain('10 Freebucks/hour')
})
