import { SOLAR_PRICE_CHANGES, solarOfferAt } from '@codebuff/common/constants/freebuff-solar-promo'
import {
  toLandingSession,
  resolveFreebuffModelPickForSession,
} from '../../hooks/use-freebuff-session'
import { freebucksFixture } from '@codebuff/common/testing/freebuff'
import { FREEBUFF_EARN_PROMPT_SHORT } from '@codebuff/common/constants/freebuff-earn'
import { afterEach, beforeAll, describe, expect, test, spyOn } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { FREEBUCKS_LABEL } from '../../utils/freebucks'
import * as openUrl from '../../utils/open-url'
import { FreebuffModelSelector } from '../freebuff-model-selector'
import {
  FREEBUFF_REWARD_MODEL_ID,
  DEFAULT_FREEBUFF_MODEL_ID,
  FALLBACK_FREEBUFF_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  FREEBUFF_FABLE_5_MODEL_ID,
  FREEBUFF_GLM_V52_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_MINIMAX_M3_MODEL_ID,
  FREEBUFF_MODELS,
  getFreebuffModelSupersededBy,
  isFreebuffModelId,
  LIMITED_FREEBUFF_MODELS,
  LIMITED_FREEBUFF_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'

import { initializeThemeStore } from '../../hooks/use-theme'
import {
  getSelectedFreebuffModel,
  useFreebuffModelStore,
} from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'

let cleanupRenderer: (() => void) | undefined

/**
 * The instant every render in this file happens at.
 *
 * Row availability is time-of-day dependent, so reading the real clock made
 * these assertions depend on the hour CI ran at: V4 Pro is `off_peak_only` and
 * closes for DeepSeek's expensive window (00:00-10:00 UTC), and a closed row
 * draws no supersession notice and is not joinable — which is how the
 * switch-to-Flash test went red on an unrelated PR (#1927) and green on one
 * merged the same day (#1924).
 *
 * 19:00 UTC on a fixed date is outside that window AND inside deployment hours
 * (15:00 Eastern, 12:00 Pacific), so every catalog row is open here regardless
 * of which of the two availability rules it carries. The relative fixtures
 * below are built from this same instant rather than the real clock, or a
 * countdown measured against the frozen picker would run backwards.
 */
const FIXED_NOW_MS = Date.UTC(2026, 7, 20, 19, 0, 0)

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
  useFreebuffSessionStore.getState().setSession(null)
  useFreebuffSessionStore.getState().setFailure(null)
  useFreebuffModelStore.getState().setSelectedModel(FALLBACK_FREEBUFF_MODEL_ID)
})

const renderSelector = async (
  maxHeight = 40,
  startSession?: (model: string) => Promise<void>,
) => {
  // Tear down any selector this test already rendered. Only the LAST one was
  // reachable from afterEach, so a test that renders twice used to leave the
  // earlier root mounted — and a mounted selector keeps running its landing
  // repair effect, rewriting the shared model store out from under whichever
  // test ran next.
  cleanupRenderer?.()
  cleanupRenderer = undefined
  const setup = await createTestRenderer({ width: 100, height: 40 })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() =>
    root.render(
      <FreebuffModelSelector
        maxHeight={maxHeight}
        nowMs={FIXED_NOW_MS}
        startSession={startSession}
      />,
    ),
  )
  await setup.renderOnce()
  return setup
}

/**
 * LIMITED tier, which since 2026-08-31 is the only tier where the reward is a
 * MODEL you can select. At full access the reward is an extra premium session
 * and the reward model is an ordinary unmetered grid row, so there is no
 * earned selection there for the landing repair to keep or discard.
 */
const renderSelectorWithGlmRemaining = async (remaining?: number) => {
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'limited',
    referral: {
      code: 'test-referral',
      referrerName: null,
      qualifiedCount: 1,
      ...(remaining === undefined
        ? {}
        : { weeklySessionsRemaining: remaining }),
      resetAt: new Date(FIXED_NOW_MS + 60_000).toISOString(),
      githubLinked: true,
    },
  })
  useFreebuffModelStore.getState().setSelectedModel(FREEBUFF_REWARD_MODEL_ID)

  const nextSetup = await renderSelector(30)
  await nextSetup.renderOnce()
  await Promise.resolve()
  await nextSetup.renderOnce()
}

describe('FreebuffModelSelector referral selection', () => {
  test('keeps a fractional unlocked reward session selected while its request is pending', async () => {
    await renderSelectorWithGlmRemaining(0.25)
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_REWARD_MODEL_ID)
  })

  test('still repairs a locked reward selection to a visible grid model', async () => {
    await renderSelectorWithGlmRemaining(0)
    // The LIMITED hero, which is no longer the full-access default: GLM 5.3
    // Flash became that on 2026-09-05 and is earned-metered at this tier, so
    // repairing onto it would move the user from one locked row to another.
    expect(getSelectedFreebuffModel()).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })

  test('treats an omitted reward balance as locked', async () => {
    await renderSelectorWithGlmRemaining()
    expect(getSelectedFreebuffModel()).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })
})

describe('FreebuffModelSelector tier layout', () => {
  test('keeps the referral actions on one condensed row', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      referral: {
        code: 'test-referral',
        referrerName: null,
        qualifiedCount: 0,
        weeklySessionsRemaining: 0,
        resetAt: new Date(FIXED_NOW_MS + 60_000).toISOString(),
        githubLinked: true,
      },
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MINIMAX_M3_MODEL_ID)

    const frame = (await renderSelector()).captureCharFrame()
    const actionRow =
      frame.split('\n').find((line) => line.includes('Copy invite link')) ?? ''

    // The label is shared with Desktop and the browser
    // (FREEBUFF_EARN_PROMPT_SHORT), so asserting the constant rather than the
    // string keeps the three surfaces free to be re-worded together — which is
    // the whole reason it is shared. What this test is really pinning is that
    // it sits on the SAME row as the copy control.
    expect(actionRow).toContain(FREEBUFF_EARN_PROMPT_SHORT)
    expect(frame).not.toContain('Or earn')
    expect(frame).not.toContain('for small tasks')
  })

  test('orders the premium row above UNLIMITED, saved unlimited model focused', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    // Solar Pro 4 moved into UNLIMITED on 2026-09-03. Keeping it as the saved
    // pick exercises both section ordering and focus without relying on a
    // second premium row that no longer exists.
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_SOLAR_PRO_4_MODEL_ID)

    const setup = await renderSelector()
    const frame = setup.captureCharFrame()
    const premiumHeaderIndex = frame.indexOf('PREMIUM')
    const recommendedModelIndex = frame.indexOf('GPT-5.6 Luna')
    const selectedModelIndex = frame.indexOf('Solar Pro 4')
    const unlimitedHeaderIndex = frame.indexOf('UNLIMITED')

    expect(premiumHeaderIndex).toBeGreaterThanOrEqual(0)
    expect(recommendedModelIndex).toBeGreaterThan(premiumHeaderIndex)
    expect(unlimitedHeaderIndex).toBeGreaterThan(recommendedModelIndex)
    expect(selectedModelIndex).toBeGreaterThan(unlimitedHeaderIndex)
    // The cursor sits on the SAVED pick, not on the recommendation.
    expect(frame).toContain('› Solar Pro 4')
    expect(frame).not.toContain('› GPT-5.6 Luna')
  })

  /**
   * ARMED, NOT DELETED. The catalog carries NO supersedes notice as of
   * 2026-08-21: V4 Pro held the last one ("V4 Flash is what we recommend") and
   * it was removed when Pro moved to a flat-priced lane and Flash became the
   * row that sleeps at peak — pointing Pro at Flash now steers users to a model
   * that is closed for ten hours precisely when Pro is their best option.
   *
   * The RULE this guards — only the selected row nags, so the list does not
   * repeat one notice on every row it applies to — is UI logic that outlives
   * any particular pair of models, so it runs again automatically the next time
   * a supersedes notice exists rather than being re-derived from a regression.
   */
  const allModelIds = FREEBUFF_MODELS.map((m) => m.id)
  const supersededModelId = allModelIds.find((id) =>
    getFreebuffModelSupersededBy(id, allModelIds),
  )
  test.if(Boolean(supersededModelId))(
    'shows the supersedes nudge only on the row the user is on',
    async () => {
      useFreebuffSessionStore.getState().setSession({
        status: 'none',
        accessTier: 'full',
      })
      // Assert against the real copy rather than a hardcoded fragment, so
      // rewording the notice doesn't fail this test for the wrong reason. It
      // must still render on ONE line — the width math reserves its length.
      const superseded = getFreebuffModelSupersededBy(
        supersededModelId!,
        allModelIds,
      )!
      const notice = superseded.notice
      const occurrences = (frame: string) => frame.split(notice).length - 1

      // On a superseded model: the nudge appears, once, on that model's card.
      useFreebuffModelStore.getState().setSelectedModel(supersededModelId!)
      const onSuperseded = (await renderSelector()).captureCharFrame()
      expect(occurrences(onSuperseded)).toBe(1)

      // On a row that is NOT superseded, that notice stays quiet — otherwise
      // the list would repeat it on every row it applies to.
      const otherId = allModelIds.find((id) => id !== supersededModelId)!
      useFreebuffModelStore.getState().setSelectedModel(otherId)
      const onOther = (await renderSelector()).captureCharFrame()
      expect(occurrences(onOther)).toBe(0)

      // And on the replacement itself: no nudge at all.
      useFreebuffModelStore.getState().setSelectedModel(superseded.modelId)
      const onCurrent = (await renderSelector()).captureCharFrame()
      expect(occurrences(onCurrent)).toBe(0)
    },
  )

  test('badges the new builds so a returning user notices they changed', async () => {
    // Independent of the supersedes machinery above, which is why it is its own
    // test now: `isNew` is a property of the row, and Flash still carries it.
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    // Selected explicitly: `isNew` sits on the V4 Flash row, and the collapsed
    // view draws only the card the user is on — which is V4 Pro by default
    // since 2026-08-21, and carries no badge.
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain('DeepSeek V4 Flash 07/31')
    expect(frame).toContain('NEW')
  })

  test('places the exhausted-quota recommendation beneath UNLIMITED', async () => {
    const resetAt = new Date(FIXED_NOW_MS + 60_000).toISOString()
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      rateLimitsByModel: {
        [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: {
          model: FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
          limit: 6,
          period: 'pacific_day',
          resetTimeZone: 'America/Los_Angeles',
          resetAt,
          windowHours: 24,
          recentCount: 6,
        },
      },
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MINIMAX_M3_MODEL_ID)

    const setup = await renderSelector()
    const frame = setup.captureCharFrame()
    const premiumHeaderIndex = frame.indexOf('PREMIUM')
    const unlimitedHeaderIndex = frame.indexOf('UNLIMITED')
    // Located by the ROW rather than by a ' RECOMMENDED ' border title, which
    // was removed on 2026-08-21 — nothing in the picker is badged as a
    // recommendation any more. The property under test is unchanged: when the
    // premium pool is spent, the row the user is steered onto sits in the
    // UNLIMITED group rather than above the list.
    //
    // MiMo 2.5 is that row since 2026-08-18 — Flash moved into the premium
    // group and can no longer be what a spent user lands on.
    const heroModelIndex = frame.indexOf('MiMo 2.5', unlimitedHeaderIndex)

    expect(unlimitedHeaderIndex).toBeGreaterThan(premiumHeaderIndex)
    expect(heroModelIndex).toBeGreaterThan(unlimitedHeaderIndex)
  })

  test('collapses to the unlimited hero when the premium default is spent', async () => {
    // A returning user sitting on a spent PREMIUM row opens the picker already
    // on a row `pick` silently refuses. Both the selection AND the cursor have
    // to leave it, or Enter does nothing with no explanation — and the picker
    // has to collapse onto the replacement, or it opens on greyed, unusable
    // premium rows with the recommendation below them.
    //
    // KEYED ON A PREMIUM ROW (Luna), NOT ON THE DEFAULT. It used to key on
    // DEFAULT_FREEBUFF_MODEL_ID, which was right for as long as every default
    // was premium — 2026-08-12 to 08-30. The default is now unmetered, so
    // exhausting "its pool" exhausts nothing and the step-down under test never
    // fires. Keying on the row that actually HAS a pool keeps this covering the
    // behaviour rather than passing vacuously.
    const resetAt = new Date(FIXED_NOW_MS + 60_000).toISOString()
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      rateLimitsByModel: {
        [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: {
          model: FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
          limit: 6,
          period: 'pacific_day',
          resetTimeZone: 'America/Los_Angeles',
          resetAt,
          windowHours: 24,
          recentCount: 6,
        },
      },
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)

    const setup = await renderSelector()
    await Promise.resolve()
    await setup.renderOnce()
    await setup.renderOnce()

    // Lands on the RECOMMENDATION, which is now unmetered — so unlike every
    // version of this test since 2026-08-12 the destination is not the
    // fallback. The user is moved off the row they cannot use and onto the one
    // the picker leads with, rather than being demoted two steps.
    expect(getSelectedFreebuffModel()).toBe(DEFAULT_FREEBUFF_MODEL_ID)
    const frame = setup.captureCharFrame()
    // `›` is the cursor: it has to be on the row Enter now commits.
    expect(frame).toContain('› GLM 5.3 Flash')
    // …and that row is the whole screen, exactly as for a user who is already
    // on the recommendation. The spent rows live behind the toggle.
    expect(frame).toContain('See all')
    expect(frame).not.toContain('PREMIUM')
  })

  test('repairs an invalid selection to the unlimited recommendation when premium is exhausted', async () => {
    const resetAt = new Date(FIXED_NOW_MS + 60_000).toISOString()
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      rateLimitsByModel: {
        [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: {
          model: FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
          limit: 6,
          period: 'pacific_day',
          resetTimeZone: 'America/Los_Angeles',
          resetAt,
          windowHours: 24,
          recentCount: 6,
        },
      },
    })
    useFreebuffModelStore.getState().setSelectedModel(FREEBUFF_GLM_V52_MODEL_ID)

    const setup = await renderSelector()
    await Promise.resolve()
    await setup.renderOnce()
    await setup.renderOnce()

    // Repaired onto the recommendation. Was the fallback while the default was
    // premium; an unmetered default is always joinable, so an invalid selection
    // now lands on the row the picker leads with.
    expect(getSelectedFreebuffModel()).toBe(DEFAULT_FREEBUFF_MODEL_ID)
    expect(setup.captureCharFrame()).toContain('› GLM 5.3 Flash')
  })

  test('shows every limited-tier model when the access tier arrives after mount', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    // The pick must DIFFER from the recommendation, or the picker mounts
    // collapsed and this test asserts nothing about the list. `expanded` is
    // computed once, in a useState initializer, so the state at MOUNT is what
    // decides it — the later tier change cannot reopen it.
    //
    // This was GLM 5.3 Flash until 2026-09-05, when GLM became the default and
    // the pick silently became the recommendation. Any joinable non-default row
    // in both catalogs restores the intent.
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    const setup = await renderSelector()

    flushSync(() => {
      useFreebuffSessionStore.getState().setSession({
        status: 'none',
        accessTier: 'limited',
      })
    })
    await Promise.resolve()
    await setup.renderOnce()
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    // From the catalog, not a hardcoded list: the point is that NONE of the
    // tier's rows stay hidden when the tier arrives late.
    for (const model of LIMITED_FREEBUFF_MODELS) {
      expect(frame).toContain(model.displayName)
    }
    // The pre-transition pick was a full-access model, so this is the path
    // where a full-access-only row would linger.
    expect(frame).not.toContain('GPT-5.6 Luna')
    expect(frame).not.toContain('PREMIUM')
    expect(frame).not.toContain('UNLIMITED')
  })

  test('badges only natively multimodal rows with Images', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    // Expanded (a saved non-recommended pick) so every row is on screen.
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MINIMAX_M3_MODEL_ID)

    const rowOf = (frame: string, name: string) =>
      frame.split('\n').find((line) => line.includes(name)) ?? ''
    const frame = (await renderSelector()).captureCharFrame()

    // Natively multimodal: the badge is a real capability claim.
    expect(rowOf(frame, 'MiMo 2.5')).toContain('Images')
    expect(rowOf(frame, 'GPT-5.6 Luna')).toContain('Images')
    expect(rowOf(frame, 'MiMo 2.5')).toContain('Images')
    // Text-only. They still accept a pasted image (read server-side as a
    // description), but badging them made the label mean nothing — and the
    // badge is what widened the hero card.
    expect(rowOf(frame, 'DeepSeek V4 Flash')).not.toContain('Images')
    expect(rowOf(frame, 'DeepSeek V4 Pro')).not.toContain('Images')
  })

  test('says the reasoning effort on rows whose catalog entry carries one', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MINIMAX_M3_MODEL_ID)

    // Anchored on taglines: model names also appear in superseded-notice lines
    const rowOf = (frame: string, tagline: string) =>
      frame.split('\n').find((line) => line.includes(tagline)) ?? ''
    const frame = (await renderSelector()).captureCharFrame()

    expect(rowOf(frame, 'Smart & Fast')).toContain('Reasoning: high')
    const lunaRow = rowOf(frame, 'GPT-5.6 Luna')
    expect(lunaRow).toContain('Strong all-around')
    expect(lunaRow).toContain('Reasoning: high')
    expect(rowOf(frame, 'MiniMax M3')).not.toContain('Reasoning')
  })

  test('says nothing about a premium quota the account does not have', async () => {
    // Quota-exempt accounts (god/admin) draw on no free pool, so no snapshot
    // arrives. The header used to fall back to the static limit and render
    // "0 of 4 used · resets in 11h 43m" for an account with neither.
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    // A row that isn't the hero, so the picker opens expanded and the PREMIUM
    // header is actually drawn. The assertion is the ABSENCE of numbers on
    // that header, so which unmetered row is selected changes nothing here —
    // only that it is not the recommendation. It was GLM 5.3 Flash until
    // 2026-09-05, when GLM became the default and this quietly started
    // asserting against a COLLAPSED picker that draws no section at all.
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)

    const frame = (await renderSelector()).captureCharFrame()
    // The section still groups the rows; only the invented numbers are gone.
    expect(frame).toContain('PREMIUM')
    expect(frame).not.toContain('used')
    expect(frame).not.toContain('resets in')
  })

  test('sizes the hero card to its content, with no Press-Enter gutter', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)

    const frame = (await renderSelector()).captureCharFrame()
    // trimEnd drops the terminal's blank columns to the right of the card, so
    // what's left ends at the card's own right border.
    const heroRow = (
      frame.split('\n').find((line) => line.includes('› DeepSeek V4 Flash')) ??
      ''
    ).trimEnd()

    expect(frame).not.toContain('Press Enter')
    // The reserved cue gutter used to sit between the last badge and the right
    // border, padding the card out by ~17 columns of empty space. What remains
    // is ordinary slack from the widest row in the set.
    //
    // So this bound tracks the WIDEST ROW, not the hero's own content, and it
    // moves whenever any row in the set grows. It went 10 -> 14 when GLM 5.3
    // Flash gained a reasoning ladder, which widens its row two different ways:
    // a model with a pinned `reasoningEffort` shows ` · Reasoning: <rung>`, and
    // a model the user has picked a rung for shows ` · Reasoning: <rung>*`
    // whether or not one is pinned (see reasoningSuffixFor). GLM 5.3 Flash has
    // no pinned effort — it runs at the provider's own setting — but an earlier
    // test in this file leaves a saved pick in the store, so the starred form is
    // what is actually being measured here. That is the card sizing itself to
    // its content, which is the behaviour under test.
    //
    // Kept well under 17 deliberately — the number has to stay small enough to
    // fail if the reserved gutter ever comes back, which is the only thing this
    // assertion is really guarding. Widen it again only for a real content
    // change, and check WHICH row got wider before you do.
    const gapToBorder =
      heroRow.length - 1 - (heroRow.indexOf('NEW') + 'NEW'.length)
    expect(heroRow.endsWith('│')).toBe(true)
    expect(gapToBorder).toBeLessThan(14)
  })
})

describe('FreebuffModelSelector limited-model offer', () => {
  const offerSession = (
    offer: Partial<{
      remaining: number
      total: number
      userRemaining: number
      userResetAt: string
    }> = {},
  ) => ({
    status: 'none' as const,
    accessTier: 'full' as const,
    limitedModelOffers: [
      {
        model: FREEBUFF_FABLE_5_MODEL_ID,
        remaining: 38,
        total: 50,
        userRemaining: 1,
        userResetAt: new Date(FIXED_NOW_MS + 5 * 60 * 60_000).toISOString(),
        ...offer,
      },
    ],
  })

  test('renders nothing when the server sends no offer', async () => {
    // The regression that matters most: a user who is not in the wave must see
    // the picker exactly as it was before the offer existed.
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).not.toContain('LIMITED TRIAL')
    expect(frame).not.toContain('Fable')
  })

  test('renders the offered model with its scarcity and data-use label', async () => {
    useFreebuffSessionStore.getState().setSession(offerSession())
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain('LIMITED TRIAL')
    expect(frame).toContain('38 of 50 sessions left')
    expect(frame).toContain('Claude Fable 5')
    // The disclosure that makes collecting the traces legitimate travels on the
    // row itself, not in a footnote somewhere else.
    expect(frame).toContain('May use data for AI training')
  })

  test('stays visible while collapsed, unlike the ordinary tiers', async () => {
    // The picker opens collapsed for a user already on the recommended model.
    // A wave nobody sees is a wave nobody joins. Read off the constant so the
    // collapsed state survives the next flip of the recommended default.
    useFreebuffModelStore.getState().setSelectedModel(DEFAULT_FREEBUFF_MODEL_ID)
    useFreebuffSessionStore.getState().setSession(offerSession())
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain('See all')
    expect(frame).toContain('Claude Fable 5')
    expect(frame).not.toContain('PREMIUM')
  })

  test('explains a spent personal allowance instead of hiding the row', async () => {
    useFreebuffSessionStore
      .getState()
      .setSession(offerSession({ userRemaining: 0 }))
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain('Claude Fable 5')
    expect(frame).toContain("you've used yours")
    expect(frame).toContain('resets in')
  })

  test('drops an offer this build has no catalog entry for', async () => {
    // A server rolling out a model older clients don't know must be a no-op,
    // not a row with a blank name and no data-use warning.
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      limitedModelOffers: [
        {
          model: 'someone/unreleased-model-9',
          remaining: 5,
          total: 50,
          userRemaining: 1,
          userResetAt: new Date(FIXED_NOW_MS + 60_000).toISOString(),
        },
      ],
    })
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).not.toContain('LIMITED TRIAL')
    expect(frame).not.toContain('unreleased-model-9')
  })

  test('keeps an offered selection instead of repairing it away', async () => {
    // The offer model is not in FREEBUFF_MODELS, so the picker's
    // invalid-selection repair would otherwise bounce the user off the row they
    // just picked.
    useFreebuffSessionStore.getState().setSession(offerSession())
    useFreebuffModelStore.getState().setSelectedModel(FREEBUFF_FABLE_5_MODEL_ID)
    await renderSelector()
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_FABLE_5_MODEL_ID)
  })

  test('repairs the selection once the wave ends', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
    })
    useFreebuffModelStore.getState().setSelectedModel(FREEBUFF_FABLE_5_MODEL_ID)
    await renderSelector()
    expect(isFreebuffModelId(getSelectedFreebuffModel())).toBe(true)
  })
})

describe('FreebuffModelSelector plan line', () => {
  const PLAN_SESSION = {
    status: 'none',
    accessTier: 'full',
    subscription: {
      tierId: 'starter',
      tiers: [
        {
          id: 'starter',
          displayName: 'Starter',
          priceUsd: 8,
          firstPeriodPriceUsd: 2.5,
          dailySessions: 2,
          fiveDaySessions: 6,
          monthlySessions: 50,
          monthlySpendLimitUsd: 40,
          dailyPremiumSessions: 2,
          disclaimers: [],
          current: true,
          upgrade: false,
          downgrade: false,
        },
      ],
      usage: {
        dayUsed: 1.3,
        dayLimit: 2,
        fiveDayUsed: 3,
        fiveDayLimit: 6,
        monthUsed: 11,
        monthLimit: 50,
        dayPremiumUsed: 1,
        dayPremiumLimit: 2,
        dayResetAt: new Date(FIXED_NOW_MS + 3 * 3600_000).toISOString(),
        periodEndsAt: new Date(FIXED_NOW_MS + 20 * 24 * 3600_000).toISOString(),
        monthSpendUsd: 3.21,
        monthSpendLimitUsd: 40,
      },
    },
  } as never

  test('a subscriber sees their plan windows under the catalog', async () => {
    useFreebuffSessionStore.getState().setSession(PLAN_SESSION)
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain('STARTER PLAN')
    expect(frame).toContain('today 1.3 of 2')
    expect(frame).toContain('week 3 of 6')
    expect(frame).toContain('month 11 of 50')
  })

  test('a blocking limit names itself and its reset', async () => {
    useFreebuffSessionStore.getState().setSession({
      ...(PLAN_SESSION as Record<string, unknown>),
      subscription: {
        ...(PLAN_SESSION as { subscription: Record<string, unknown> })
          .subscription,
        blockedBy: 'daily',
      },
    } as never)
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain("today's plan sessions are used")
    expect(frame).toContain('resets in 3h')
  })

  test('a free account sees its own three windows in the same shape', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      freeWindows: {
        dayUsed: 1,
        dayLimit: 4,
        weekUsed: 3,
        weekLimit: 14,
        monthUsed: 9,
        monthLimit: 40,
        dayResetAt: new Date(FIXED_NOW_MS + 5 * 3600_000).toISOString(),
        monthResetAt: new Date(FIXED_NOW_MS + 20 * 24 * 3600_000).toISOString(),
      },
    } as never)
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).toContain(
      'FREE · today 1 of 4 · week 3 of 14 · month 9 of 40',
    )
  })

  test('no plan means no plan line', async () => {
    useFreebuffSessionStore
      .getState()
      .setSession({ status: 'none', accessTier: 'full' } as never)
    const frame = (await renderSelector()).captureCharFrame()
    expect(frame).not.toContain('PLAN ·')
  })
})

describe('GLM selection uses the applicable meter', () => {
  test.each([0, 4, 5, 25])(
    'Freebucks balance %s wins over a contradictory earned quota',
    async (balance) => {
      useFreebuffSessionStore.getState().setSession({
        status: 'none',
        accessTier: 'limited',
        freebucks: freebucksFixture(balance),
        rateLimitsByModel: {
          [FREEBUFF_GLM_V53_FLASH_MODEL_ID]: {
            model: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
            limit: balance >= 5 ? 0 : 1,
            recentCount: 0,
            period: 'pacific_day',
            resetTimeZone: 'America/Los_Angeles',
            resetAt: '2026-09-06T07:00:00.000Z',
            windowHours: 24,
          },
        },
      })
      useFreebuffModelStore
        .getState()
        .setSelectedModel(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
      const setup = await renderSelector()
      await setup.renderOnce()
      // The LIMITED hero when the balance cannot cover GLM. It stopped being
      // the full-access default on 2026-09-05: GLM became that, and repairing
      // an unaffordable GLM onto GLM would be a no-op.
      expect(getSelectedFreebuffModel()).toBe(
        balance >= 5
          ? FREEBUFF_GLM_V53_FLASH_MODEL_ID
          : LIMITED_FREEBUFF_MODEL_ID,
      )
      if (balance >= 5)
        // The price reads `5/hr`; the balance lives in the header line.
        expect(setup.captureCharFrame()).toContain('5 Freebucks/hr')
    },
  )

  test('fresh balances and leaving the audience update selection without remounting', async () => {
    const setBalance = (balance?: number) =>
      useFreebuffSessionStore.getState().setSession({
        status: 'none',
        accessTier: 'limited',
        ...(balance === undefined
          ? {}
          : { freebucks: freebucksFixture(balance) }),
      })
    setBalance(25)
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    const setup = await renderSelector()
    await setup.renderOnce()
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    setBalance(4)
    await setup.renderOnce()
    await setup.renderOnce()
    // The LIMITED hero — see the note in the case above.
    expect(getSelectedFreebuffModel()).toBe(LIMITED_FREEBUFF_MODEL_ID)
    setBalance(5)
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    await setup.renderOnce()
    await setup.renderOnce()
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    setBalance()
    await setup.renderOnce()
    await setup.renderOnce()
    expect(getSelectedFreebuffModel()).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })
})

test('GLM Enter submits the exact selected model once while admission is pending', async () => {
  const session = {
    status: 'none' as const,
    accessTier: 'limited' as const,
    freebucks: freebucksFixture(5),
  }
  useFreebuffSessionStore.getState().setSession(session)
  useFreebuffModelStore
    .getState()
    .setSelectedModel(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
  const requested: string[] = []
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const setup = await renderSelector(40, async (model) => {
    requested.push(
      resolveFreebuffModelPickForSession(
        model,
        useFreebuffSessionStore.getState().session,
      ),
    )
    await pending
  })
  try {
    await setup.mockInput.pressEnter()
    await setup.renderOnce()
    await setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(requested).toEqual([FREEBUFF_GLM_V53_FLASH_MODEL_ID])
  } finally {
    finish()
    await pending
  }
})

test('returning to the landing picker keeps the currency until the fresh probe', () => {
  const freebucks = freebucksFixture(5)
  const landing = toLandingSession({
    status: 'ended',
    accessTier: 'limited',
    freebucks,
  })
  expect(landing.freebucks).toEqual(freebucks)
  expect(
    resolveFreebuffModelPickForSession(
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      landing,
    ),
  ).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
})

test.each([
  ['legacy', undefined],
  ['Freebucks', 4],
] as const)(
  'clicking unfunded GLM makes no admission request (%s)',
  async (_label, balance) => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'limited',
      ...(balance === undefined
        ? {}
        : { freebucks: freebucksFixture(balance) }),
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MIMO_V25_MODEL_ID)
    const requested: string[] = []
    const setup = await renderSelector(40, async (model) => {
      requested.push(model)
    })
    const y = setup
      .captureCharFrame()
      .split('\n')
      .findIndex((line) => line.includes('GLM 5.3 Flash'))
    expect(y).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(15, y)
    await setup.renderOnce()
    expect(requested).toEqual([])
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_MIMO_V25_MODEL_ID)
  },
)

// A row the meter cannot cover used to be inert in both directions: the Enter
// handler and the click handler both gated on `isJoinable`, so pressing it did
// nothing at all — no message, no plans link. On a metered account that is the
// whole of what users reported as "I can't change models": the cheapest row
// starts and every dearer one is silent (2026-09-08). The wall now speaks, and
// the second press opens the page that is the only thing which changes the
// answer.
describe('a row the balance cannot cover', () => {
  const renderUnaffordableLuna = async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      freebucks: freebucksFixture(10, {
        [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: 20,
        [FREEBUFF_MIMO_V25_MODEL_ID]: 10,
      }),
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MIMO_V25_MODEL_ID)
    const requested: string[] = []
    const setup = await renderSelector(40, async (model) => {
      requested.push(model)
    })
    await setup.renderOnce()
    // Walk the focus onto Luna rather than assuming where it lands.
    for (let i = 0; i < 12; i++) {
      if (setup.captureCharFrame().includes('› GPT-5.6 Luna')) break
      flushSync(() => setup.mockInput.pressKey('ARROW_DOWN'))
      await setup.renderOnce()
    }
    expect(setup.captureCharFrame()).toContain('› GPT-5.6 Luna')
    return { setup, requested }
  }

  test('explains the wall on the first press instead of doing nothing', async () => {
    const { setup, requested } = await renderUnaffordableLuna()
    flushSync(() => setup.mockInput.pressEnter())
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain(`Not enough ${FREEBUCKS_LABEL}`)
    expect(frame).toContain('Enter opens plans')
    expect(requested).toEqual([])
  })

  test('opens the plans page on the second press, and starts nothing', async () => {
    const openSpy = spyOn(openUrl, 'safeOpen').mockResolvedValue(true)
    try {
      const { setup, requested } = await renderUnaffordableLuna()
      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(openSpy).toHaveBeenCalledWith('https://freebuff.com/plans')
      expect(requested).toEqual([])
      expect(getSelectedFreebuffModel()).toBe(FREEBUFF_MIMO_V25_MODEL_ID)
    } finally {
      openSpy.mockRestore()
    }
  })

  test('a row closed for the hour stays inert — no wall to raise', async () => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      freebucks: freebucksFixture(10, {
        [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: 20,
      }),
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_MIMO_V25_MODEL_ID)
    const setup = await renderSelector()
    await setup.renderOnce()
    // Nothing is asking anything before a press; the assertion above is what
    // makes the two cases distinguishable at all.
    expect(setup.captureCharFrame()).not.toContain(
      `Not enough ${FREEBUCKS_LABEL}`,
    )
  })
})

test.each([false, true])(
  'Freebucks does not change Luna plan access (paid=%s)',
  async (paid) => {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'limited',
      freebucks: freebucksFixture(25, { [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: 20 }),
      ...(paid ? { subscription: { tierId: 'starter', tiers: [] } } : {}),
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)
    const setup = await renderSelector()
    await setup.renderOnce()
    // Unpaid at limited access repairs onto the LIMITED hero, which since
    // 2026-09-05 is not the full-access default.
    expect(getSelectedFreebuffModel()).toBe(
      paid ? FREEBUFF_GPT_5_6_LUNA_MODEL_ID : LIMITED_FREEBUFF_MODEL_ID,
    )
    if (paid) expect(setup.captureCharFrame()).toContain('GPT-5.6 Luna')
    else expect(setup.captureCharFrame()).not.toContain('GPT-5.6 Luna')
  },
)

test('quota-exempt Luna remains selected at zero Freebucks', async () => {
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'full',
    freebucks: {
      ...freebucksFixture(0, { [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]: 20 }),
      quotaExempt: true,
    },
  })
  useFreebuffModelStore
    .getState()
    .setSelectedModel(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)
  const setup = await renderSelector()
  await setup.renderOnce()
  expect(getSelectedFreebuffModel()).toBe(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)
})

test('the collapsed picker recommends affordable GLM when the default costs too much', async () => {
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'limited',
    freebucks: freebucksFixture(5, {
      [DEFAULT_FREEBUFF_MODEL_ID]: 15,
      [FREEBUFF_MIMO_V25_MODEL_ID]: 10,
      [FREEBUFF_GLM_V53_FLASH_MODEL_ID]: 5,
      [FREEBUFF_SOLAR_PRO_4_MODEL_ID]: 5,
    }),
  })
  useFreebuffModelStore.getState().setSelectedModel(DEFAULT_FREEBUFF_MODEL_ID)
  const requested: string[] = []
  const setup = await renderSelector(40, async (model) => {
    requested.push(model)
  })
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain('GLM 5.3 Flash')
  expect(getSelectedFreebuffModel()).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
  await setup.mockInput.pressEnter()
  await setup.renderOnce()
  expect(requested).toEqual([FREEBUFF_GLM_V53_FLASH_MODEL_ID])
})

test('a funded Luna row does not show its exhausted legacy quota in the section header', async () => {
  const id = FREEBUFF_GPT_5_6_LUNA_MODEL_ID
  useFreebuffSessionStore.getState().setSession({
    status: 'none',
    accessTier: 'full',
    freebucks: freebucksFixture(25, { [id]: 20 }),
    rateLimitsByModel: {
      [id]: {
        model: id,
        limit: 1,
        recentCount: 1,
        pool: 'premium',
        period: 'pacific_day',
        resetTimeZone: 'America/Los_Angeles',
        resetAt: '2026-09-06T07:00:00.000Z',
        windowHours: 24,
      },
    },
  })
  useFreebuffModelStore.getState().setSelectedModel(id)
  const setup = await renderSelector()
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain('20 Freebucks/hr')
  expect(setup.captureCharFrame()).not.toContain('1 of 1 used')
  expect(getSelectedFreebuffModel()).toBe(id)
})

test('an open Solar CLI picker leaves the holiday price at the cutoff and submits at 5', async () => {
  const cutoff = Date.parse('2026-09-08T07:00:00Z')
  const clock = spyOn(Date, 'now').mockReturnValue(cutoff - 137)
  const realTimeout = globalThis.setTimeout
  let wake: (() => void) | undefined
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms: number,
    ...args: unknown[]
  ) => {
    if (ms === 137) wake = fn
    return realTimeout(fn, ms, ...args)
  }) as typeof setTimeout)
  const requested: string[] = []
  try {
    useFreebuffSessionStore.getState().setSession({
      status: 'none',
      accessTier: 'full',
      freebucks: {
        ...freebucksFixture(5, {
          [DEFAULT_FREEBUFF_MODEL_ID]: 15,
          [FREEBUFF_GLM_V53_FLASH_MODEL_ID]: 5,
          [FREEBUFF_SOLAR_PRO_4_MODEL_ID]: 0,
        }),
        priceNotices: { [FREEBUFF_SOLAR_PRO_4_MODEL_ID]: solarOfferAt(cutoff - 137).tagline },
        priceChanges: SOLAR_PRICE_CHANGES.filter((change) => Date.parse(change.at) >= cutoff),
      },
    })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_SOLAR_PRO_4_MODEL_ID)
    const setup = await renderSelector(40, async (model) => {
      requested.push(model)
    })
    expect(setup.captureCharFrame()).toContain('Labor Day weekend')
    expect(setup.captureCharFrame()).toContain('0 Freebucks')
    expect(wake).toBeDefined()
    // Keep the whole catalog open: the collapsed recommendation can change
    // when another model becomes the cheapest affordable choice. Whether it
    // OPENS collapsed depends on the hero: a default the balance cannot cover
    // (DeepSeek at 15) fell back to Solar, the selection, so it collapsed;
    // an affordable default (GLM at 5, since 2026-09-05) is not the selection,
    // so it opens expanded with the cursor already on Solar. Only reach for
    // the toggle when there is one, or Down walks the cursor onto GLM.
    if (!setup.captureCharFrame().includes('Show fewer')) {
      await setup.mockInput.pressArrow('down')
      await setup.renderOnce()
      await new Promise((resolve) => realTimeout(resolve, 20))
      await setup.mockInput.pressEnter()
      await setup.renderOnce()
      await new Promise((resolve) => realTimeout(resolve, 20))
      await setup.renderOnce()
    }
    expect(setup.captureCharFrame()).toContain('Show fewer')
    flushSync(() => {
      clock.mockReturnValue(cutoff)
      wake!()
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain('Labor Day weekend')
    expect(setup.captureCharFrame()).toContain('Solar Pro 4')
    expect(setup.captureCharFrame()).toMatch(/Solar Pro 4[^\n]*\n[^\n]*5 Freebucks\/hr/)
    await setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(requested).toEqual([FREEBUFF_SOLAR_PRO_4_MODEL_ID])
  } finally {
    cleanupRenderer?.()
    cleanupRenderer = undefined
    timerSpy.mockRestore()
    clock.mockRestore()
  }
})
