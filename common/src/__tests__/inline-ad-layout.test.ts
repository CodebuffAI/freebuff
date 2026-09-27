import { describe, expect, it } from 'bun:test'

import {
  MIN_INLINE_WIDTH_WITH_DESTINATION,
  MIN_PARTNER_WIDTH_WITH_DESTINATION,
  PARTNER_LINE_DISCLOSURE,
  extractDomain,
  getAdDisplayLabel,
  getInlineAdLayout,
  getPartnerLineLayout,
  isValidBrandHex,
  truncateToWidth,
} from '../ads/inline-ad-layout'

const AD = {
  title: 'Ship Postgres in one command',
  adText: 'Serverless Postgres with branching.',
  url: 'https://neon.tech/freebuff',
}

describe('getInlineAdLayout at the widths the builder previews', () => {
  it('drops the destination domain entirely below 48 columns', () => {
    // This is the single most surprising thing about a narrow terminal, and
    // the reason the campaign builder previews 20 columns at all: an
    // advertiser who never sees it assumes their domain always shows.
    const narrow = getInlineAdLayout(AD, 20)
    const wide = getInlineAdLayout(AD, 48)

    expect(narrow.label).toBe('')
    expect(wide.label).toBe('neon.tech')
    expect(MIN_INLINE_WIDTH_WITH_DESTINATION).toBe(48)
  })

  it('keeps the domain at exactly 48 and loses it at 47', () => {
    expect(getInlineAdLayout(AD, 48).label).toBe('neon.tech')
    expect(getInlineAdLayout(AD, 47).label).toBe('')
  })

  it('truncates the title harder as the terminal narrows', () => {
    const widths = [20, 48, 60] as const
    const titles = widths.map((width) => getInlineAdLayout(AD, width).title)

    // Monotonic: a wider terminal never shows less title.
    expect(titles[0]!.length).toBeLessThan(titles[1]!.length)
    expect(titles[1]!.length).toBeLessThanOrEqual(titles[2]!.length)
    expect(titles[0]).toContain('…')
    expect(titles[2]).toBe(AD.title)
  })

  it('never returns a string wider than the content area', () => {
    for (const width of [20, 48, 60]) {
      const layout = getInlineAdLayout(AD, width)
      const contentWidth = Math.max(0, width - 4)
      expect(layout.title.length).toBeLessThanOrEqual(contentWidth)
      expect(layout.description.length).toBeLessThanOrEqual(contentWidth)
    }
  })

  it('survives a zero or negative width without throwing', () => {
    const layout = getInlineAdLayout(AD, 0)
    expect(layout.title).toBe('')
    expect(layout.description).toBe('')
    expect(layout.label).toBe('')
  })
})

describe('truncation measures UTF-16 code units, not display columns', () => {
  // Pinned deliberately. `truncateToWidth` uses String.length, so wide
  // characters occupy one unit here and two columns in a terminal — text that
  // fits by this measure can still overflow on screen. The web preview
  // reproduces this exactly rather than silently disagreeing with the
  // renderer; fixing it means fixing both at once.
  it('counts a CJK character as one unit', () => {
    expect(truncateToWidth('日本語テキスト', 5)).toBe('日本語テ…')
  })

  it('counts an astral-plane emoji as two units', () => {
    // '🚀' is a surrogate pair, so a naive slice can cut it in half.
    const truncated = truncateToWidth('🚀🚀🚀', 4)
    expect(truncated.length).toBeLessThanOrEqual(4)
  })

  it('leaves text alone when it already fits', () => {
    expect(truncateToWidth('short', 20)).toBe('short')
  })
})

describe('display label', () => {
  it('prefers the destination domain, stripped of www', () => {
    expect(extractDomain('https://www.neon.tech/x')).toBe('neon.tech')
    expect(getAdDisplayLabel(AD)).toEqual({
      text: 'neon.tech',
      variant: 'domain',
    })
  })

  it('falls back to the title when the ad carries no URL', () => {
    // Carbon exposes no destination URL, which is why one of its ads renders a
    // headline where a Gravity ad renders a domain.
    expect(getAdDisplayLabel({ title: 'A headline', url: '' })).toEqual({
      text: 'A headline',
      variant: 'title',
    })
  })

  it('falls back to Sponsored when there is neither', () => {
    expect(getAdDisplayLabel({ title: '', url: '' })).toEqual({
      text: 'Sponsored',
      variant: 'title',
    })
  })

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(extractDomain('not a url')).toBe('not a url')
  })
})

/**
 * The PARTNER row: one line of an advertiser's colour in the CLI, previewed
 * in the console from this same function.
 */
describe('getPartnerLineLayout', () => {
  const PARTNER = { title: 'Review PR with Greptile', url: 'https://greptile.com' }

  it('keeps the title and the domain on a standard terminal', () => {
    const layout = getPartnerLineLayout(PARTNER, 80)
    expect(layout.title).toBe(PARTNER.title)
    expect(layout.label).toBe('greptile.com')
    expect(layout.disclosure).toBe(PARTNER_LINE_DISCLOSURE)
  })

  it('drops the domain below its own breakpoint, not the inline card’s', () => {
    // A single row with no border and no CTA box still reads at widths where
    // the inline card has already given up, so this breakpoint is lower.
    expect(getPartnerLineLayout(PARTNER, 44).label).toBe('greptile.com')
    expect(getPartnerLineLayout(PARTNER, 43).label).toBe('')
    expect(MIN_PARTNER_WIDTH_WITH_DESTINATION).toBe(44)
    expect(MIN_PARTNER_WIDTH_WITH_DESTINATION).toBeLessThan(
      MIN_INLINE_WIDTH_WITH_DESTINATION,
    )
  })

  it('never drops the disclosure, however narrow the row', () => {
    // An unlabelled line of somebody's brand colour inside our own chrome is
    // the one state this format may not have. The title goes first.
    for (const width of [0, 6, 12, 20, 43, 80]) {
      const layout = getPartnerLineLayout(PARTNER, width)
      expect([width, layout.disclosure]).toEqual([
        width,
        PARTNER_LINE_DISCLOSURE,
      ])
    }
    expect(getPartnerLineLayout(PARTNER, 6).title).toBe('')
  })

  it('fits inside the row it was given, at every width', () => {
    for (const width of [20, 44, 66, 80, 120]) {
      const layout = getPartnerLineLayout(PARTNER, width)
      const used =
        layout.title.length +
        (layout.label ? layout.label.length + 2 : 0) +
        layout.disclosure.length +
        2
      expect([width, used <= width]).toEqual([width, true])
    }
  })

  it('never prints the title twice when the ad has no URL', () => {
    // The inline card falls back to the title for its destination label.
    // Doing that here would put the same words at both ends of one row.
    const layout = getPartnerLineLayout({ title: 'A headline', url: '' }, 80)
    expect(layout.title).toBe('A headline')
    expect(layout.label).toBe('')
  })

  it('survives a missing title without throwing', () => {
    const layout = getPartnerLineLayout(
      { title: '', url: 'https://greptile.com' },
      80,
    )
    expect(layout.title).toBe('')
    expect(layout.label).toBe('greptile.com')
  })
})

describe('isValidBrandHex', () => {
  it('accepts six-digit hex in either case, and nothing else', () => {
    expect(isValidBrandHex('#20d6a0')).toBe(true)
    expect(isValidBrandHex('#20D6A0')).toBe(true)
    // Everything a creative might carry instead. Each of these reaches a
    // STYLE rather than a text node, which is why the check exists at all.
    for (const value of [
      '#20d6a',
      '20d6a0',
      '#20d6a0;',
      'red',
      'var(--x)',
      '#fff',
      '',
      null,
      undefined,
    ]) {
      expect([value, isValidBrandHex(value)]).toEqual([value, false])
    }
  })
})
