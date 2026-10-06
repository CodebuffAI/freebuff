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
    'Off-peak: 10 Freebucks/hr 3 PM–11 PM PDT. 15 otherwise.',
  )
  const winter = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-12-01T23:00:00Z'),
    timeZone: 'America/Los_Angeles',
  })!
  expect(winter.tooltip).toContain('2 PM–10 PM PST')
  const germany = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-09-17T23:00:00Z'),
    timeZone: 'Europe/Berlin',
  })!
  expect(germany.tooltip).toContain('12 AM–8 AM GMT+2')
  const dst = freebucksOffPeakCopy(quote, 'flash', {
    now: Date.parse('2026-10-24T23:00:00Z'),
    timeZone: 'Europe/Berlin',
  })!
  expect(dst.tooltip).toContain('12 AM GMT+2–7 AM GMT+1')
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
      'Off-peak: 10 Freebucks/hr 10 PM–6 AM UTC. 15 otherwise.',
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
  ).toBe('Off-peak: 10 Freebucks/hr 10 PM–6 AM UTC. 15 otherwise.')
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
  expect(copy.tooltip).toContain('Off-peak: 10 Freebucks/hr')
  // The policy says off-peak, so the next change is the window's END: no
  // promise of a drop then.
  expect(copy.resumes).toBeUndefined()
})

test('at peak, says when the off-peak price is back, with the weekday when it is not today', () => {
  // DeepSeek's clock: off-peak 10:00-00:00 UTC daily and all Beijing weekend.
  const fast = {
    prices: { fast: 50 },
    offPeak: {
      fast: {
        startHourUtc: 10,
        endHourUtc: 0,
        weekendsOffPeak: true,
        price: 25,
        regularPrice: 50,
      },
    },
  }
  // Monday 01:00 UTC is Sunday 6 PM in Los Angeles; the drop is Monday there.
  const sunday = freebucksOffPeakCopy(fast, 'fast', {
    now: Date.parse('2026-10-05T01:00:00Z'),
    timeZone: 'America/Los_Angeles',
  })!
  expect(sunday.resumes).toEqual({ price: 25, at: 'Mon 3:00 AM PDT' })
  // The sentence names the weekday peak, on the reader's days: Beijing's
  // weekday mornings are Sunday-Thursday evenings in Los Angeles.
  expect(sunday.badge).toBe('Peak')
  expect(sunday.tooltip).toBe(
    'Peak: 50 Freebucks/hr Sun–Thu, 5 PM–3 AM PDT. 25 otherwise.',
  )
  // Same local day: the time alone.
  expect(
    freebucksOffPeakCopy(fast, 'fast', {
      now: Date.parse('2026-10-05T08:00:00Z'),
      timeZone: 'America/Los_Angeles',
    })!.resumes,
  ).toEqual({ price: 25, at: '3:00 AM PDT' })
  // Off-peak: nothing to wait for.
  const offPeak = freebucksOffPeakCopy(
    { ...fast, prices: { fast: 25 } },
    'fast',
    {
      now: Date.parse('2026-10-05T12:00:00Z'),
      timeZone: 'America/Los_Angeles',
    },
  )!
  expect(offPeak.resumes).toBeUndefined()
  expect(offPeak.badge).toBe('Off-peak')
  expect(offPeak.tooltip).toBe(sunday.tooltip)
})

test("appends the server's reason after the hours", () => {
  const copy = freebucksOffPeakCopy(
    {
      prices: quote.prices,
      offPeak: {
        flash: { ...quote.offPeak.flash, reason: 'when Freebuff is quiet' },
      },
    },
    'flash',
    { now: Date.parse('2026-09-17T23:00:00Z'), timeZone: 'America/Los_Angeles' },
  )!
  expect(copy.tooltip).toBe(
    'Off-peak: 10 Freebucks/hr 3 PM–11 PM PDT, when Freebuff is quiet. 15 otherwise.',
  )
})
