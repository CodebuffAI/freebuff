// The CLI can offer two kinds of freebuff row: the picker grid, and the referral banner's earned
// GLM 5.2 action. Both end up as a POST the server gates, and as a free-mode root agent that has
// to allow the model — so a row this surface can show must survive all of it. Desktop shipped the
// mirror-image of this bug (an offered GLM row its own route answered 400 for), which is what
// these lock down here.

import { describe, expect, test } from 'bun:test'

import { getFreebuffRootAgentIdForModel } from '@codebuff/common/constants/free-agents'
import {
  FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS,
  FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS,
  FREEBUFF_REWARD_MODEL_ID,
  getFreebuffModelsForAccessTier,
  FREEBUFF_GLM_V52_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  LIMITED_FREEBUFF_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { freebuffOfferViolations } from '@codebuff/common/testing/freebuff-offer-invariants'
import { freebuffPlanRequired } from '@codebuff/common/util/freebuff-model-selection'

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

/** The plan-lock list the server sends a planless viewer on this tier
 *  (`planRequiredModelIds` in web/src/server/free-session/public-api.ts). */
const serverLockList = (accessTier: FreebuffAccessTier) =>
  accessTier === 'full'
    ? FREEBUFF_PRO_ONLY_CATALOG_MODEL_IDS
    : FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS

/** Whether the picker draws this row LOCKED for a planless account, both
 *  with the server's verdict and with the tier fallback an older server (or
 *  an unavailable balance) leaves it on. The two must agree. */
const lockedForPlanless = (model: string, accessTier: FreebuffAccessTier) => {
  const withVerdict = freebuffPlanRequired(
    model,
    false,
    { planRequiredModelIds: serverLockList(accessTier) },
    accessTier,
  )
  expect(freebuffPlanRequired(model, false, undefined, accessTier)).toBe(
    withVerdict,
  )
  return withVerdict
}

describe('freebuff rows the CLI offers', () => {
  // Every row the picker offers a planless account is either USABLE on the
  // tier, or LOCKED: drawn with no price, and a press opens the plans page
  // instead of starting a session (`freebuffPlanRequired`). Locked rows are
  // listed at full access since 2026-09-21 and at limited access since
  // 2026-09-30, and the subscriber cases below hold them to the usable bar.
  for (const accessTier of ['full', 'limited'] as const) {
    test(`are all usable or locked on the ${accessTier} tier`, () => {
      expect(
        freebuffOfferViolations({
          surface: `cli picker + referral banner (${accessTier})`,
          accessTier,
          offered: freebuffCliOfferedModelIds(accessTier).filter(
            (model) =>
              // Full access admits a paid-only row at the tier layer (the plan
              // gate is `checkProOnlyModel`), so only limited needs the filter.
              accessTier === 'full' || !lockedForPlanless(model, accessTier),
          ),
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

  // The plan widens what may be PICKED, never what the free pools give. Since
  // 2026-09-30 it does not change which rows are LISTED either — only which
  // are locked — so the two grids are the same rows.
  test('the limited grid keeps every free row for a subscriber', () => {
    const free = freebuffCliOfferedModelIds('limited')
    const paid = freebuffCliOfferedModelIds('limited', true)
    expect(paid).toEqual(free)
    for (const id of free) {
      expect(freebuffPlanRequired(id, true, undefined, 'limited')).toBe(false)
    }
  })

  // The locked rows at limited access are EXACTLY the ones the server locks
  // for a planless viewer there: a row locked here but open on the server
  // hides something admission allows, and one open here but locked on the
  // server is the offered-but-refused row this file exists to catch.
  test('the limited grid locks exactly the server-locked rows for a planless account', () => {
    const offered = freebuffCliOfferedModelIds('limited')
    const locked = offered.filter((id) => lockedForPlanless(id, 'limited'))
    expect(locked).toEqual(
      offered.filter((id) =>
        FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS.includes(id),
      ),
    )
    expect(locked.length).toBeGreaterThan(0)
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
        true,
      ),
    ).toBe(FREEBUFF_GPT_6_LUNA_MODEL_ID)
    expect(
      resolveFreebuffModelSelectionForSession(
        FREEBUFF_GPT_6_LUNA_MODEL_ID,
        unpaidSession,
        true,
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
