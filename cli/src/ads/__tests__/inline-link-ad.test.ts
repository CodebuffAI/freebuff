import { describe, expect, test } from 'bun:test'

import {
  CLI_INLINE_LINK_AD_LIVE,
  CLI_INLINE_LINK_PLACEMENT_ID,
  cliInlineAdStyle,
  inlineAdRequestPlan,
  inlineLinkText,
} from '../inline-link-ad'

const CARD = 'Inline-After-Agent-CLI'

describe('the CLI inline link gate', () => {
  test('ships dark: the checked-in gate is off', () => {
    expect(CLI_INLINE_LINK_AD_LIVE).toBe(false)
  })

  test('gate off: the card placement, whatever the policy says', () => {
    for (const policyStyle of ['link', 'card', null, undefined, 'nonsense']) {
      expect(cliInlineAdStyle(policyStyle)).toBe('card')
      expect(
        inlineAdRequestPlan({
          cardPlacementId: CARD,
          linkPlacementId: CLI_INLINE_LINK_PLACEMENT_ID,
          policyStyle,
        }),
      ).toEqual({ style: 'card', placementId: CARD })
    }
  })

  test('gate on and policy link: the link with its own placement', () => {
    expect(
      inlineAdRequestPlan({
        cardPlacementId: CARD,
        linkPlacementId: CLI_INLINE_LINK_PLACEMENT_ID,
        policyStyle: 'link',
        gate: true,
      }),
    ).toEqual({ style: 'link', placementId: 'Inline-Link-After-Agent-CLI' })
  })

  test('gate on but the policy is not link (or unresolved): the card', () => {
    for (const policyStyle of ['card', null, undefined, 'LINK']) {
      expect(
        inlineAdRequestPlan({
          cardPlacementId: CARD,
          linkPlacementId: CLI_INLINE_LINK_PLACEMENT_ID,
          policyStyle,
          gate: true,
        }),
      ).toEqual({ style: 'card', placementId: CARD })
    }
  })

  test('a caller with no link placement always gets the card', () => {
    expect(
      inlineAdRequestPlan({ cardPlacementId: CARD, policyStyle: 'link', gate: true }),
    ).toEqual({ style: 'card', placementId: CARD })
  })
})

describe('inlineLinkText', () => {
  test('adText, then title, then cta', () => {
    expect(inlineLinkText({ adText: ' ', title: 'Neon', cta: 'Try' })).toBe('Neon')
    expect(inlineLinkText({ adText: '', title: '', cta: 'Try it' })).toBe('Try it')
    expect(inlineLinkText({})).toBe('')
  })

  test('long copy keeps its first sentence when that fits', () => {
    const copy =
      'Serverless Postgres that scales to zero. Branch your database like code and ship faster than ever before today.'
    expect(inlineLinkText({ adText: copy }, 80)).toBe(
      'Serverless Postgres that scales to zero',
    )
  })

  test('otherwise it is cut between words, never past the limit', () => {
    const copy =
      'Serverless postgres that scales to zero and branches like code for every preview deployment you make'
    const text = inlineLinkText({ adText: copy }, 40)
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text.endsWith('…')).toBe(true)
    expect(copy.startsWith(text.slice(0, -1))).toBe(true)
    expect(inlineLinkText({ adText: copy }, 0)).toBe('')
  })
})
