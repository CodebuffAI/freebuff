import { describe, expect, it } from 'bun:test'

import { AD_CAMPAIGN_STATUSES } from '../constants/freebuff-ads'
import {
  ACTIVATION_ATTRIBUTION_WINDOW_DAYS,
  clampPlacementDailyCapCents,
  PLACEMENT_DAILY_CAP_DEFAULT_CENTS,
  PLACEMENT_DAILY_CAP_LADDER,
  PLACEMENT_DAILY_CAP_MAX_CENTS,
  PLACEMENT_DAILY_CAP_MIN_CENTS,
  placementDailyCapLadderIndex,
  ATTRIBUTION_WINDOW_COPY,
  DIAGNOSTIC_METRICS,
  NOT_SERVING_COPY,
  NOT_SERVING_REASONS,
  PLACEMENTS_CONSOLE_ENABLED,
  PLACEMENT_METRIC_LABELS,
  PLACEMENT_PREVIEW_WIDTHS,
  PLACEMENT_FORMATS,
  PLACEMENT_SLOTS,
  SPONSOR_BREAK_CREATIVE_LIMITS,
  SPONSOR_BREAK_FORMATS,
  INTERRUPTING_BREAK_FORMATS,
  isInterruptingBreakFormat,
  isInterruptingBreakPlacement,
  isSponsorBreakFormat,
  SPONSOR_BREAK_HERO_SPEC,
  TRACKED_LINK_PLACEMENT_ID,
  isSponsorBreakPlacement,
  placementFormat,
  placementSlotLabel,
  placementSurface,
  PLACEMENT_STATUS_LABELS,
  PRIMARY_METRICS,
  UNDERSPEND_COPY,
  UNDERSPEND_REASONS,
  avgCpa,
  avgCpc,
  costPerActivation,
  ctr,
  ecpm,
  isServing,
  placementDisplayStatus,
  spendUsd,
} from '../constants/freebuff-placements'

import type { PlacementTotals } from '../constants/freebuff-placements'

function totals(overrides: Partial<PlacementTotals> = {}): PlacementTotals {
  return {
    activations: 0,
    impressionsServed: 0,
    impressionsViewed: 0,
    clicks: 0,
    billableClicks: 0,
    spendCents: 0,
    deliverySpendCents: overrides.spendCents ?? 0,
    ...overrides,
  }
}

describe('derived metrics', () => {
  it('divides CTR by viewed impressions, not served ones', () => {
    // Served counts ads the client never painted. Using it as the denominator
    // deflates every advertiser's CTR against the numbers they see elsewhere,
    // so the difference between these two figures has to show up in the rate.
    const value = ctr(
      totals({
        impressionsServed: 2_000,
        impressionsViewed: 1_000,
        clicks: 10,
      }),
    )

    expect(value).toBe(0.01)
  })

  it('keeps CTR diagnostic and counts raw clicks, not only billed clicks', () => {
    // CPA does not bill a click. CTR must remain a diagnostic of actual click
    // behaviour across both billing models rather than a disguised invoice rate.
    const value = ctr(
      totals({ impressionsViewed: 1_000, clicks: 20, billableClicks: 10 }),
    )

    expect(value).toBe(0.02)
  })

  it('computes CPA, CPC and eCPM in dollars', () => {
    const measured = totals({
      activations: 4,
      impressionsViewed: 10_000,
      clicks: 40,
      billableClicks: 40,
      spendCents: 6_000,
    })

    expect(costPerActivation(measured)).toBe(15)
    expect(avgCpa(measured)).toBe(15)
    expect(avgCpc(measured)).toBe(1.5)
    expect(ecpm(measured)).toBe(6)
    expect(spendUsd(measured)).toBe(60)
  })

  it('returns null rather than NaN or zero on an empty denominator', () => {
    // "No clicks yet" and "a CTR of zero" are different facts, and a new
    // campaign shows the first one for days. Rendering it as 0% tells an
    // advertiser their creative failed when nothing has been measured at all.
    const empty = totals()

    expect(ctr(empty)).toBeNull()
    expect(costPerActivation(empty)).toBeNull()
    expect(avgCpc(empty)).toBeNull()
    expect(ecpm(empty)).toBeNull()
  })

  it('treats a negative or non-finite denominator as no answer', () => {
    expect(ctr(totals({ impressionsViewed: -5, billableClicks: 1 }))).toBeNull()
    expect(
      ctr(totals({ impressionsViewed: Number.NaN, billableClicks: 1 })),
    ).toBeNull()
    expect(
      ecpm(
        totals({
          impressionsViewed: Number.POSITIVE_INFINITY,
          spendCents: 100,
        }),
      ),
    ).toBeNull()
  })

  it('reports zero spend as zero, not as missing', () => {
    // A funded campaign that has genuinely spent nothing today is a real
    // measurement; only an absent denominator is unknown.
    expect(spendUsd(totals({ spendCents: 0 }))).toBe(0)
    expect(costPerActivation(totals({ activations: 3, spendCents: 0 }))).toBe(0)
  })
})

describe('display status', () => {
  it('labels an approved but unfunded campaign "Not funded"', () => {
    // It is `active` in the database and not serving in reality. Showing it as
    // "Active" is how an advertiser spends a week wondering why nothing
    // delivers.
    expect(
      placementDisplayStatus({ status: 'active', billingActive: false }),
    ).toBe('not_funded')
    expect(PLACEMENT_STATUS_LABELS.not_funded).toBe('Not funded')
  })

  it('is exactly active AND not billing_active', () => {
    expect(
      placementDisplayStatus({ status: 'active', billingActive: true }),
    ).toBe('active')
    expect(
      placementDisplayStatus({ status: 'paused', billingActive: false }),
    ).toBe('paused')
    expect(
      placementDisplayStatus({ status: 'draft', billingActive: false }),
    ).toBe('draft')
    expect(
      placementDisplayStatus({ status: 'ended', billingActive: false }),
    ).toBe('ended')
  })

  it('only reports serving for a funded active campaign', () => {
    expect(isServing({ status: 'active', billingActive: true })).toBe(true)
    expect(isServing({ status: 'active', billingActive: false })).toBe(false)
    expect(isServing({ status: 'paused', billingActive: true })).toBe(false)
  })

  it('covers every ad_campaign_status with a label', () => {
    // Mirrors the "status unions mirror the database enums" test in
    // freebuff-ads.test.ts. A status added to the pg enum and not here renders
    // as a blank cell rather than an error.
    for (const status of AD_CAMPAIGN_STATUSES) {
      expect(PLACEMENT_STATUS_LABELS[status]).toBeTruthy()
      expect(placementDisplayStatus({ status, billingActive: true })).toBe(
        status,
      )
    }
  })
})

describe('copy and configuration', () => {
  it('marks the DB-backed control and delivery planes as wired', () => {
    // Rollups may still be zero, but campaign attribution and the spend ledger
    // are real and the console no longer resolves users to a fixture account.
    expect(PLACEMENTS_CONSOLE_ENABLED).toBe(true)
  })

  it('previews the destination-label breakpoint plus the widths people run', () => {
    // 48 is the narrowest width that still renders the destination domain;
    // 80 and 100 are the terminals users actually have (100 rather than 120
    // so the widest card still fits the preview dialog unscrolled). The
    // renderer's 20-column floor is deliberately absent — nobody runs one,
    // and the house-ad budget enforces it separately via MIN_INLINE_AD_WIDTH.
    expect(PLACEMENT_PREVIEW_WIDTHS).toEqual([48, 80, 100])
  })

  it('states the attribution window in the copy that goes on screen', () => {
    // Without a shared rule the advertiser's install count and ours differ and
    // no dispute can be settled.
    expect(ATTRIBUTION_WINDOW_COPY).toContain(
      String(ACTIVATION_ATTRIBUTION_WINDOW_DAYS),
    )
  })

  it('sells every real slot, and only real slots', () => {
    // Every id must be a PLACEMENT id, never a surface name. `cli_chat` was
    // listed here once; it is a surface, and the transcript's real slots are
    // `CLI-Chat-Inline-1..8`. A surface name here is a campaign sold against
    // inventory that can never match at serve time.
    const surfaceNames = new Set<string>(
      PLACEMENT_SLOTS.map((slot) => slot.surface),
    )
    for (const slot of PLACEMENT_SLOTS) {
      expect([slot.id, surfaceNames.has(slot.id)]).toEqual([slot.id, false])
    }

    expect(PLACEMENT_SLOTS.every((slot) => slot.available)).toBe(true)
    expect(new Set(PLACEMENT_SLOTS.map((slot) => slot.id)).size).toBe(
      PLACEMENT_SLOTS.length,
    )
  })

  it('covers the chat surfaces, which are the larger pool', () => {
    // Chat was blocked on a Gravity exclusivity term that does not exist. The
    // transcript alone is twice the waiting room's slot count.
    const bySurface = (surface: string) =>
      PLACEMENT_SLOTS.filter((slot) => slot.surface === surface).length
    // CLI transcript + its legacy single slot + both Desktop units. NOT the
    // eight `CLI-Chat-Inline-N` ids:
    // no shipping client requests those, so selling them would be selling a
    // decaying legacy path.
    // Plus the three sponsor breaks, which are deliberately the same surface:
    // a break is a different RENDERER on Desktop chat, not a new surface, and
    // adding one costs a house creative and a pinned rollup row.
    expect(bySurface('cli_chat')).toBe(7)
    expect(bySurface('waiting_room')).toBe(4)
    expect(bySurface('freebuff_web_chat')).toBe(2)
    expect(bySurface('chat_assistant')).toBe(1)
  })

  it('gives every slot a format, so no slot renders by guesswork', () => {
    // The whole point of the column: a renderer asks the catalog how to draw
    // a slot rather than pattern-matching its id. A slot with no format would
    // fall through `placementFormat`'s conservative default and silently
    // render inline, which for a break is a blank-looking card.
    for (const slot of PLACEMENT_SLOTS) {
      expect([slot.id, PLACEMENT_FORMATS.includes(slot.format)]).toEqual([
        slot.id,
        true,
      ])
    }
  })

  it('names the three sponsor breaks and leaves every other slot inline', () => {
    const breaks = PLACEMENT_SLOTS.filter((slot) =>
      isSponsorBreakPlacement(slot.id),
    ).map((slot) => slot.id)
    expect(breaks).toEqual([
      'Desktop-Spotlight',
      'Desktop-Showcase',
      'Desktop-Intermission',
    ])
    expect(placementFormat('Desktop-Spotlight')).toBe('spotlight')
    expect(placementFormat('Desktop-Showcase')).toBe('showcase')
    expect(placementFormat('Desktop-Intermission')).toBe('intermission')
    // Resolvable as slots, exactly like every other sellable id.
    for (const id of breaks) expect(placementSurface(id)).toBe('cli_chat')
    expect(SPONSOR_BREAK_FORMATS).toEqual([
      'showcase',
      'spotlight',
      'intermission',
    ])
  })

  it('caps the two INTERRUPTING breaks and never Showcase (COD-455)', () => {
    // Two predicates, two questions. The creative rules (hero required, no
    // text-only house floor) are the same for all three; the daily cap, the
    // min-session floor and the fail-closed-with-no-Redis are the price of
    // TAKING THE SCREEN AWAY, which Showcase does not do -- it is the same
    // above-composer slot drawn taller, on the same rotation as the banner it
    // is being compared against. Capping it at one a day would leave the
    // treatment arm byte-identical to control for all but one rotation, so the
    // format test would measure nothing.
    expect(INTERRUPTING_BREAK_FORMATS).toEqual(['spotlight', 'intermission'])
    expect(isInterruptingBreakFormat('showcase')).toBe(false)
    expect(isSponsorBreakFormat('showcase')).toBe(true)

    const interrupting = PLACEMENT_SLOTS.filter((slot) =>
      isInterruptingBreakPlacement(slot.id),
    ).map((slot) => slot.id)
    expect(interrupting).toEqual(['Desktop-Spotlight', 'Desktop-Intermission'])
    expect(isInterruptingBreakPlacement('Desktop-Showcase')).toBe(false)

    // Still the conservative fallback for an unknown id, in both directions.
    expect(isInterruptingBreakPlacement('some-future-grain')).toBe(false)
    // Every interrupting format is a break; the reverse does not hold.
    for (const format of INTERRUPTING_BREAK_FORMATS) {
      expect([format, isSponsorBreakFormat(format)]).toEqual([format, true])
    }
  })

  it('answers inline for an id it does not know, never undefined', () => {
    // The conservative direction. An unknown id guessed as a break would turn
    // one typo into a full-screen interruption; guessed as inline it renders
    // as the ordinary card it almost certainly is.
    expect(placementFormat('CLI-Chat-Inline-3')).toBe('inline')
    expect(placementFormat('some-future-grain')).toBe('inline')
    expect(isSponsorBreakPlacement('some-future-grain')).toBe(false)
  })

  it('bounds break copy far below the inline lengths', () => {
    // A break title renders at display size; inline-length copy does not
    // shrink to fit, it overflows or truncates mid-word.
    expect(SPONSOR_BREAK_CREATIVE_LIMITS).toEqual({
      titleMaxLength: 28,
      bodyMaxLength: 60,
      ctaMaxLength: 18,
    })
    expect(SPONSOR_BREAK_HERO_SPEC.minWidth).toBe(1024)
    expect(SPONSOR_BREAK_HERO_SPEC.minHeight).toBe(640)
    // The floor is itself on-ratio, so the minimum acceptable image passes
    // both gates rather than being rejected by the one it defines.
    expect(
      Math.abs(
        SPONSOR_BREAK_HERO_SPEC.minWidth / SPONSOR_BREAK_HERO_SPEC.minHeight -
          SPONSOR_BREAK_HERO_SPEC.aspectRatio,
      ),
    ).toBeLessThan(1e-9)
  })

  it('gives every not-serving and underspend reason copy', () => {
    // Each of these is a state we can distinguish. Any reason without copy
    // would render an empty banner, which reads as "broken".
    for (const reason of NOT_SERVING_REASONS) {
      expect(NOT_SERVING_COPY[reason].message).toBeTruthy()
    }
    for (const reason of UNDERSPEND_REASONS) {
      expect(UNDERSPEND_COPY[reason]).toBeTruthy()
    }
  })

  it('labels every metric it exposes', () => {
    for (const metric of [...PRIMARY_METRICS, ...DIAGNOSTIC_METRICS]) {
      expect(PLACEMENT_METRIC_LABELS[metric]).toBeTruthy()
    }
  })

  it('exposes both CPA and CPC primary facts for model-aware dashboards', () => {
    expect(PRIMARY_METRICS).toEqual([
      'billableClicks',
      'activations',
      'spend',
      'avgCpc',
      'avgCpa',
    ])
  })

  it('never labels impressions as a purchasable unit', () => {
    // eCPM is a derived yield figure for comparison against CPM inventory the
    // advertiser already buys. We do not sell impressions.
    expect(PLACEMENT_METRIC_LABELS.ecpm).toBe('Effective CPM')
  })
})

/**
 * The reporting grain is wider than the slot catalog, and the labeller has to
 * know it.
 *
 * `PLACEMENT_SLOTS` lists what an advertiser can buy a position in. A tracked
 * link is not one of those — nothing auctions it and nothing serves an
 * impression into it — but the delivery rollup groups by `placement_id`, so
 * every surface that labels a placement will meet it.
 */
describe('placementSlotLabel', () => {
  it('renders every real slot exactly as the breakdown table already did', () => {
    // This is a behaviour-preservation assertion, not a new format: these
    // strings are what the table showed before the labeller moved here.
    expect(placementSlotLabel('waiting-room-1')).toBe('Waiting room 1')
    expect(placementSlotLabel('CLI-Chat-Inline')).toBe('CLI Chat Inline')
    expect(placementSlotLabel('Web-Chat-After-User-Message')).toBe(
      'Web Chat After User Message',
    )
    for (const slot of PLACEMENT_SLOTS) {
      expect(placementSlotLabel(slot.id).length).toBeGreaterThan(0)
    }
  })

  it('names the four format slots by their format, not their position', () => {
    // `Single-Ad-Unit-1` is the one this exists for: the hyphen-splitter
    // renders it "Single Ad Unit 1", which names nothing an advertiser bought.
    expect(placementSlotLabel('Single-Ad-Unit-1')).toBe('CLI — Dock')
    expect(placementSlotLabel('Desktop-Spotlight')).toBe('Desktop — Spotlight')
    expect(placementSlotLabel('Desktop-Showcase')).toBe('Desktop — Showcase')
    expect(placementSlotLabel('Desktop-Intermission')).toBe(
      'Desktop — Intermission',
    )
  })

  it('names the tracked-link grain, which no slot describes', () => {
    expect(placementSlotLabel(TRACKED_LINK_PLACEMENT_ID)).toBe('Tracked links')
    // That it is not a slot is proved by the compiler rather than asserted
    // here: `PLACEMENT_SLOTS` is `as const`, so comparing a slot id against
    // this constant is a type error ("no overlap"). Adding it to the catalog
    // would put a tracked link in front of an advertiser choosing where their
    // ad appears, which is not what it is.
    expect(
      (PLACEMENT_SLOTS as readonly { id: string }[]).some(
        (slot) => slot.id === TRACKED_LINK_PLACEMENT_ID,
      ),
    ).toBe(false)
  })

  it('degrades an unknown grain to something readable, never undefined', () => {
    // The next grain after tracked links must render as a string a human can
    // read, not as a gap that looks like a bug in the numbers beside it.
    expect(placementSlotLabel('some-future-grain')).toBe('Some future grain')
    expect(placementSlotLabel('')).toBe('')
  })
})

describe('placement daily cap', () => {
  it('offers a self-serve ceiling of 500_000 cents a day', () => {
    // The bound the campaigns API validates. If this moves, the API moves with
    // it -- both read this constant, which is the whole reason it is here.
    expect(PLACEMENT_DAILY_CAP_MIN_CENTS).toBe(2_500)
    expect(PLACEMENT_DAILY_CAP_MAX_CENTS).toBe(500_000)
  })

  it('clamps into the bounds and answers with whole cents', () => {
    expect(clampPlacementDailyCapCents(0)).toBe(PLACEMENT_DAILY_CAP_MIN_CENTS)
    expect(clampPlacementDailyCapCents(-1)).toBe(PLACEMENT_DAILY_CAP_MIN_CENTS)
    expect(clampPlacementDailyCapCents(9_999_999)).toBe(
      PLACEMENT_DAILY_CAP_MAX_CENTS,
    )
    expect(clampPlacementDailyCapCents(3_234.6)).toBe(3_235)
    // A cap off the slider's ladder is a legal cap: the input takes any
    // amount, and nothing on the way to the database snaps it.
    expect(clampPlacementDailyCapCents(13_700)).toBe(13_700)
    expect(clampPlacementDailyCapCents(Number.NaN)).toBe(
      PLACEMENT_DAILY_CAP_DEFAULT_CENTS,
    )
  })

  it('walks a ladder that spans the bounds with a growing step', () => {
    const rungs = PLACEMENT_DAILY_CAP_LADDER
    expect(rungs[0]).toBe(PLACEMENT_DAILY_CAP_MIN_CENTS)
    expect(rungs[rungs.length - 1]).toBe(PLACEMENT_DAILY_CAP_MAX_CENTS)
    expect(
      rungs.every((cents, index) => index === 0 || cents > rungs[index - 1]!),
    ).toBe(true)
    // Small enough to drag through, and fine enough at the low end that the
    // $25-$50/day campaigns the product actually runs are all reachable.
    expect(rungs.length).toBeLessThan(80)
    expect(rungs).toContain(2_500)
    expect(rungs).toContain(5_000)
    expect(rungs).toContain(PLACEMENT_DAILY_CAP_DEFAULT_CENTS)
  })

  it('puts an off-ladder cap on the nearest rung without leaving the range', () => {
    expect(
      PLACEMENT_DAILY_CAP_LADDER[placementDailyCapLadderIndex(2_500)],
    ).toBe(2_500)
    expect(
      PLACEMENT_DAILY_CAP_LADDER[placementDailyCapLadderIndex(2_600)],
    ).toBe(2_500)
    expect(
      PLACEMENT_DAILY_CAP_LADDER[
        placementDailyCapLadderIndex(PLACEMENT_DAILY_CAP_MAX_CENTS)
      ],
    ).toBe(PLACEMENT_DAILY_CAP_MAX_CENTS)
    expect(
      PLACEMENT_DAILY_CAP_LADDER[placementDailyCapLadderIndex(9_999_999)],
    ).toBe(PLACEMENT_DAILY_CAP_MAX_CENTS)
  })
})
