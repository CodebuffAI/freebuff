// The CLI can offer two kinds of freebuff row: the picker grid, and the referral banner's earned
// GLM 5.2 action. Both end up as a POST the server gates, and as a free-mode root agent that has
// to allow the model — so a row this surface can show must survive all of it. Desktop shipped the
// mirror-image of this bug (an offered GLM row its own route answered 400 for), which is what
// these lock down here.

import { describe, expect, test } from 'bun:test'

import { getFreebuffRootAgentIdForModel } from '@codebuff/common/constants/free-agents'
import {
  FREEBUFF_REWARD_MODEL_ID,
  getFreebuffModelsForAccessTier,
  FREEBUFF_GLM_V52_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  LIMITED_FREEBUFF_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { freebuffOfferViolations } from '@codebuff/common/testing/freebuff-offer-invariants'

import {
  resolveFreebuffModelPickForSession,
  resolveFreebuffModelSelectionForSession,
} from '../../hooks/use-freebuff-session'
import { freebuffCliOfferedModelIds } from '../freebuff-model-selector'

import type { FreebuffAccessTier } from '@codebuff/common/constants/freebuff-models'
import type { FreebuffSessionResponse } from '../../types/freebuff-session'

function cliAcceptsModel(
  model: string,
  accessTier: FreebuffAccessTier,
  hasPaidSubscription = false,
): boolean {
  const session: FreebuffSessionResponse = {
    status: 'none',
    accessTier,
    ...(hasPaidSubscription
      ? { subscription: { tierId: 'starter', tiers: [] } }
      : {}),
  }
  return resolveFreebuffModelPickForSession(model, session) === model
}

describe('freebuff rows the CLI offers', () => {
  for (const accessTier of ['full', 'limited'] as const) {
    test(`are all usable on the ${accessTier} tier`, () => {
      expect(
        freebuffOfferViolations({
          surface: `cli picker + referral banner (${accessTier})`,
          accessTier,
          offered: freebuffCliOfferedModelIds(accessTier),
          // the CLI's own resolver, which every session start runs the selection through: a model
          // it coerces away is one the user picked and never got
          accepts: (model) => cliAcceptsModel(model, accessTier),
          rootAgentIdFor: getFreebuffRootAgentIdForModel,
          catalog: 'supported',
        }),
      ).toEqual([])
    })
  }

  // A paid plan reaches limited regions, so a limited-region subscriber's grid gains the models
  // their plan meters. Its own surface: the CLI's own resolver has to keep the pick too, or the
  // user picks the model they bought and the session starts on MiMo.
  test('are all usable on the limited tier for a subscriber', () => {
    expect(
      freebuffOfferViolations({
        surface: 'cli picker + referral banner (limited, subscriber)',
        accessTier: 'limited',
        hasPaidSubscription: true,
        offered: freebuffCliOfferedModelIds('limited', true),
        accepts: (model) => cliAcceptsModel(model, 'limited', true),
        rootAgentIdFor: getFreebuffRootAgentIdForModel,
        catalog: 'supported',
      }),
    ).toEqual([])
  })

  // The plan widens what may be PICKED, never what the free pools give.
  test('the limited grid keeps every free row for a subscriber', () => {
    const free = freebuffCliOfferedModelIds('limited')
    const paid = freebuffCliOfferedModelIds('limited', true)
    for (const id of free) expect(paid).toContain(id)
    expect(paid.length).toBeGreaterThan(free.length)
  })

  test('a limited subscriber startup keeps their saved plan model selected', () => {
    const paidSession: FreebuffSessionResponse = {
      status: 'none',
      accessTier: 'limited',
      subscription: { tierId: 'starter', tiers: [] },
    }
    const unpaidSession: FreebuffSessionResponse = {
      status: 'none',
      accessTier: 'limited',
    }

    expect(
      resolveFreebuffModelSelectionForSession(
        FREEBUFF_GPT_6_LUNA_MODEL_ID,
        paidSession,
      ),
    ).toBe(FREEBUFF_GPT_6_LUNA_MODEL_ID)
    expect(
      resolveFreebuffModelSelectionForSession(
        FREEBUFF_GPT_6_LUNA_MODEL_ID,
        unpaidSession,
      ),
    ).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })

  test('the earned reward is offered on BOTH tiers', () => {
    // Limited access included: a bounty grant is redeemable there, so the row
    // has to be reachable there. The banner still only renders it against a
    // live balance.
    //
    // At FULL access it is also in the GRID since 2026-08-31 — the reward model
    // is GLM 5.3 Flash, an ordinary unmetered row and the CLI's default pick.
    // The old assertion that the grid never shows it was correct only while the
    // reward was GLM 5.2, which no tier's catalog listed.
    expect(freebuffCliOfferedModelIds('full')).toContain(
      FREEBUFF_REWARD_MODEL_ID,
    )
    expect(freebuffCliOfferedModelIds('limited')).toContain(
      FREEBUFF_REWARD_MODEL_ID,
    )
    // GLM 5.3 Flash is directly selectable in the limited grid as well.
    expect(getFreebuffModelsForAccessTier('limited').map((m) => m.id)).toContain(
      FREEBUFF_REWARD_MODEL_ID,
    )
  })

  // 'base2-free' is the fallback root, and its allowlist has never included the referral reward.
  // A GLM row that fell through to it would 403 with free_mode_invalid_agent_model on the first
  // turn instead of failing at selection, so the mapping is what keeps the reward runnable.
  test('the reward maps to its own root agent rather than the fallback', () => {
    expect(getFreebuffRootAgentIdForModel(FREEBUFF_GLM_V52_MODEL_ID)).toBe(
      'base2-free-glm',
    )
  })
})
