import { FREEBUFF_TIER_CHANGE_NOTICE } from '../util/freebuff-model-availability'
import { describe, expect, test } from 'bun:test'

import { isFreeModeAllowedAgentModel } from '../constants/free-agents'
import {
  DEFAULT_FREEBUFF_MODEL_ID,
  DEFAULT_FREEBUFF_WEB_MODEL_ID,
  FALLBACK_FREEBUFF_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_ENABLE_MIMO_MODELS_IN_UI,
  FREEBUFF_FABLE_5_MODEL_ID,
  FREEBUFF_GLM_V52_MODEL_ID,
  FREEBUFF_REWARD_MODEL_ID,
  FREEBUFF_REWARD_MODEL_IDS,
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_WEB_LIMITED_MODEL_IDS,
  FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS,
  FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_MAX_PRICE,
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_GPT_5_6_LUNA_PROVIDER_ROUTE,
  FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT,
  FREEBUFF_KIMI_K3_ECO_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_MUSE_SPARK_MODEL_IDS,
  FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
  FREEBUFF_OX_ALPHA_MODEL_ID,
  FREEBUFF_SERVICE_ONLY_MODEL_IDS,
  isFreebuffServiceOnlyModelId,
  FREEBUFF_STANDARD_MODEL_IDS,
  FREEBUFF_WEB_ALL_MODELS,
  FREEBUFF_WEB_DEEMPHASIZED_MODEL_IDS,
  FREEBUFF_WEB_GOD_ONLY_MODELS,
  FREEBUFF_WEB_MODELS,
  FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS,
  LIMITED_FREEBUFF_HERO_MODEL_ID,
  LIMITED_FREEBUFF_MODEL_ID,
  LIMITED_FREEBUFF_MODEL_IDS,
  LIMITED_FREEBUFF_MODEL_MISMATCH_MESSAGE,
  MUSE_SPARK_12_CONTRIBUTOR_UPSTREAM_MODEL_ID,
  MUSE_SPARK_13_CONTRIBUTOR_UPSTREAM_MODEL_ID,
  MUSE_SPARK_FALLBACK_AFTER_MS,
  MUSE_SPARK_FALLBACK_MODEL_ID,
  MUSE_SPARK_FALLBACK_NOTICE,
  SUPPORTED_FREEBUFF_MODELS,
  FREEBUFF_WEB_PREMIUM_MODEL_IDS,
  canFreebuffModelSpawnGeminiThinker,
  freebuffWithdrawnModelMessage,
  getFreebuffDeploymentAvailabilityLabel,
  getFreebuffModel,
  getFreebuffModelImageSupport,
  getFreebuffModelReasoningEffort,
  getFreebuffModelSupersededBy,
  getFreebuffModelsForAccessTier,
  getFreebuffWebModel,
  getRecommendedFreebuffModelId,
  getRecommendedFreebuffWebModelId,
  isFreebuffDeploymentHours,
  isFreebuffRewardModelId,
  isRewardModelRedeemableAtLimitedTier,
  isFreebuffGlmV53FlashModelId,
  isFreebuffGpt56LunaModelId,
  isFreebuffLimitedOfferModelId,
  isFreebuffModelAllowedForAccessTier,
  isFreebuffModelId,
  isFreebuffMultimodalModelId,
  isFreebuffPausedFreeModelId,
  isFreebuffPremiumModelId,
  isFreebuffSessionModelAllowedForAccessTier,
  isFreebuffSessionModelAvailable,
  freebuffModelUnavailableAt,
  freebuffModelUnavailableWindow,
  formatFreebuffModelUnavailableWindow,
  FREEBUFF_DEPLOYMENT_HOURS_LABEL,
  isFreebuffSessionModelId,
  isFreebuffTracedModelId,
  isFreebuffWebDeemphasizedModelId,
  isFreebuffWebGeoExemptModelId,
  isFreebuffWebGodOnlyModelId,
  isFreebuffWebModelAllowedForLimitedTier,
  isFreebuffWebModelId,
  isFreebuffWebMultimodalModelId,
  isFreebuffWebPremiumModelId,
  isFreebuffWebRememberableModelId,
  isFreebuffWebSelectableModelId,
  isMuseSparkModelId,
  isSupportedFreebuffModelId,
  migrateSupersededFreebuffModelPreference,
  resolveAvailableFreebuffModel,
  resolveFreebuffModelForAccessTier,
  resolveFreebuffSessionModelForAccessTier,
  resolveFreebuffWebModel,
  resolveFreebuffWebModelForLimitedTier,
  resolveRememberedFreebuffWebModel,
} from '../constants/freebuff-models'
import type { FreebuffModelOption } from '../constants/freebuff-models'
import { minimaxModels } from '../constants/model-config'

const FREEBUFF_KIMI_MODEL_ID = 'moonshotai/kimi-k2.7-code'
// Both removed 2026-08-04. Held as literals, not imported constants, so these
// guards keep asserting on the WIRE ids even if a constant of the same name is
// ever reintroduced.
const FREEBUFF_MIMO_V25_PRO_MODEL_ID = 'mimo/mimo-v2.5-pro'
const FREEBUFF_CROF_GLM_V52_MODEL_ID = 'crof/glm-5.2'

const MINIMAX_M3_MODEL_ID = minimaxModels.minimaxM3

describe('freebuff model availability', () => {
  test('the default is joinable at every hour; the fallback is unlimited', () => {
    // The two constants answer different questions: the default is the STARTING
    // pick (leading FREEBUFF_MODELS is the only steer — nothing is badged), the
    // fallback is what is always joinable when the premium pool is spent.
    expect(DEFAULT_FREEBUFF_MODEL_ID).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(FALLBACK_FREEBUFF_MODEL_ID).toBe(FREEBUFF_MIMO_V25_MODEL_ID)

    //
    // THE invariant that moved the default off Flash. A default is what a new
    // user lands on before they know the catalog exists, so it must be open at
    // every hour — and Flash now closes for the ten-hour peak window. Asserted
    // at both ends of that window rather than at "now", or the test passes or
    // fails depending on what time CI runs.
    expect(
      isFreebuffSessionModelAvailable(
        DEFAULT_FREEBUFF_MODEL_ID,
        new Date('2026-08-21T02:00:00Z'),
      ),
    ).toBe(true)
    expect(
      isFreebuffSessionModelAvailable(
        DEFAULT_FREEBUFF_MODEL_ID,
        new Date('2026-08-21T12:00:00Z'),
      ),
    ).toBe(true)

    // The fallback being NON-premium is the load-bearing half: it is where every
    // surface steps down when the pool is spent, so a premium value here would
    // step users onto a model that fails admission for exactly the users it was
    // meant to rescue.
    expect(isFreebuffPremiumModelId(FALLBACK_FREEBUFF_MODEL_ID)).toBe(false)

    // AND THE DEFAULT IS NOW NON-PREMIUM TOO, which is new as of 2026-08-30 and
    // is a strengthening rather than a relaxation. Every default from
    // 2026-08-18 onward was premium, which made the step-down mandatory for any
    // surface holding a live quota — miss it and the recommended pick becomes
    // one whose next send fails admission. An unmetered default cannot reach
    // that state at all.
    //
    // Asserted as an EQUALITY on the current value rather than loosened to
    // "premium or not": if a future default is premium again, the step-down
    // becomes load-bearing again and whoever makes that change should be made
    // to come here and say so.
    expect(isFreebuffPremiumModelId(DEFAULT_FREEBUFF_MODEL_ID)).toBe(false)
  })

  test('DeepSeek Pro keeps its AI-training warning while paused', () => {
    // Not in FREEBUFF_MODELS any more — paused models stay in SUPPORTED so the
    // server can recognise and coerce them, and a row support can still look up
    // has to keep its disclosure.
    const deepseek = SUPPORTED_FREEBUFF_MODELS.find(
      (m) => m.id === FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
    )
    expect((deepseek as { warning?: string } | undefined)?.warning).toBe(
      'May use data for AI training',
    )
  })

  test('DeepSeek Flash carries the AI-training warning before selection', () => {
    const deepseek = FREEBUFF_MODELS.find(
      (m) => m.id === FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )
    expect((deepseek as { warning?: string } | undefined)?.warning).toBe(
      'May use data for AI training',
    )
  })

  test('only the DeepSeek family is trace-stored in free mode', () => {
    // MiMo is the non-training row still in the picker; M3 was withdrawn on
    // 2026-08-20 and is no longer there to check.
    const mimo = FREEBUFF_MODELS.find(
      (m) => m.id === FREEBUFF_MIMO_V25_MODEL_ID,
    )
    expect((mimo as { warning?: string } | undefined)?.warning).toBeUndefined()
    // The DeepSeek family discloses AI training and IS stored.
    expect(isFreebuffTracedModelId(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID)).toBe(
      true,
    )
    expect(isFreebuffTracedModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)).toBe(
      true,
    )
    // Everything else (incl. M3 on Fireworks) is NOT stored.
    expect(isFreebuffTracedModelId(MINIMAX_M3_MODEL_ID)).toBe(false)
    expect(isFreebuffTracedModelId(FREEBUFF_KIMI_MODEL_ID)).toBe(false)
    expect(isFreebuffTracedModelId(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(false)
    expect(isFreebuffTracedModelId(null)).toBe(false)
  })

  test('trace storage follows machine-readable data-use metadata', () => {
    const models: readonly FreebuffModelOption[] = SUPPORTED_FREEBUFF_MODELS
    for (const model of models) {
      // Muse Spark is the one row that carries the training grant and is still
      // NOT traced. Meta trains on these prompts upstream regardless — that is
      // the Contributor discount — so our own copy buys nothing the grant has
      // not already given away. It entered this test's scope on 2026-09-04 by
      // joining the CLI catalog; without the exception the widening would have
      // started retaining users' prompts as a side effect of a catalog edit.
      // See FREEBUFF_UNTRACED_TRAINING_MODEL_IDS.
      if (FREEBUFF_MUSE_SPARK_MODEL_IDS.some((id) => id === model.id)) {
        expect(model.dataUse).toBe('training')
        expect(model.warning).toBeDefined()
        expect(isFreebuffTracedModelId(model.id)).toBe(false)
        continue
      }
      expect(isFreebuffTracedModelId(model.id)).toBe(
        model.dataUse === 'training',
      )
      // Ox Alpha is the ONE row where a warning does not imply a training
      // grant, and it entered this test's scope on 2026-08-24 by joining the
      // CLI catalog -- the exception used to hold for free because the row was
      // browser-only. Its host RETAINS prompts and does not train on them, so
      // `dataUse` stays 'service' (that is what drives trace storage, and
      // claiming a grant we were not given would be wrong in the direction
      // that changes behavior) while the warning still tells a user what they
      // want to know before pasting a private repo into an anonymous provider.
      // ox-alpha.test.ts pins the pairing so it reads as a decision.
      if (model.id === FREEBUFF_OX_ALPHA_MODEL_ID) {
        expect(model.dataUse).toBe('service')
        expect(model.warning).toBeDefined()
        continue
      }
      expect(model.warning !== undefined).toBe(model.dataUse === 'training')
    }
  })

  test('DeepSeek V4 Flash is selectable and unlimited on full access', () => {
    expect(FREEBUFF_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )
    expect(isFreebuffModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)).toBe(true)
    // Unmetered again as of 2026-08-24, reversing the 08-18 metering now that
    // the Luminal lane gives Flash somewhere cheap to run.
    expect(isFreebuffPremiumModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)).toBe(
      false,
    )
    // Unmetered means being in NO pool, which only holds if it left the premium
    // id list too — the flag and the list are one change.
    expect(FREEBUFF_STANDARD_MODEL_IDS).toContain(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )
    // The catalog must never be all-premium: something has to be left for an
    // account whose pool is spent.
    expect(FREEBUFF_MODELS.some((model) => !model.premium)).toBe(true)
  })

  test('the limited tier offers Flash again', () => {
    expect(LIMITED_FREEBUFF_MODEL_IDS).toContain(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(LIMITED_FREEBUFF_MODEL_IDS).toContain(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )
    expect(
      isFreebuffWebModelAllowedForLimitedTier(
        FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      ),
    ).toBe(true)
    expect(isFreebuffPremiumModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)).toBe(
      false,
    )
  })

  test('the fallback stays available at every hour, not merely unmetered', () => {
    // Flash leaving the premium pool makes it eligible for this slot by the
    // "MUST BE NON-PREMIUM" rule, but it is `off_peak_only`, so it must NOT
    // take it: a fallback that is shut for ten hours a day is not a fallback.
    expect(FALLBACK_FREEBUFF_MODEL_ID).not.toBe(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )
    const fallback = SUPPORTED_FREEBUFF_MODELS.find(
      (model) => model.id === FALLBACK_FREEBUFF_MODEL_ID,
    )!
    expect(fallback.premium).toBe(false)
    expect(fallback.availability).toBe('always')
  })

  test('GLM 5.3 Flash LEADS the catalog, and still nothing is badged', () => {
    // One default at every tier and on every surface as of 2026-09-05, when it
    // retook the lead it held from 08-30 to 09-02.
    const all = FREEBUFF_MODELS.map((model) => model.id)
    expect(all[0]).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(DEFAULT_FREEBUFF_MODEL_ID).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(DEFAULT_FREEBUFF_WEB_MODEL_ID).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)

    // The properties that make it admissible as a default, asserted rather than
    // trusted — each one is a way the first Enter press could fail.
    expect(isFreebuffPremiumModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID)).toBe(
      false,
    )
    expect(isFreebuffPausedFreeModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID)).toBe(
      false,
    )
    // STILL NOTHING IS BADGED. Leading the list is the whole recommendation:
    // no ' RECOMMENDED ' badge and no supersedes notice, because a
    // `supersededBy` would rewrite SAVED picks on every load
    // (migrateSupersededFreebuffModelPreference) — a user who deliberately
    // chose another row would be moved off it at each launch.
    expect(
      getFreebuffModelSupersededBy(FREEBUFF_GPT_5_6_LUNA_MODEL_ID, all),
    ).toBeUndefined()
  })

  /**
   * GLM 5.3 Flash IS the reward model now (2026-08-31), and GLM 5.2 is
   * withdrawn — which reverses this test without weakening what it guards.
   *
   * The hazard was never "these two must not be the same row". It was that they
   * share a family name and a `z-ai/` prefix, and a predicate written as a
   * PREFIX MATCH would silently merge two entitlements. That produced the worst
   * quota bug this file records: `crof/glm-5.2` was a second wire id for the
   * earned model sitting in the daily premium pool, and hand-written callers
   * collected it with zero referrals for five days.
   *
   * So what this pins is that every GLM predicate is still an EXPLICIT ID LIST
   * — including now, when the two happen to name the same model, because the
   * next reward move will separate them again.
   */
  test('the GLM predicates are explicit id lists, never prefix matches', () => {
    // Same id today, DIFFERENT QUESTIONS: one asks "is this the reward", the
    // other "does this need the OpenRouter price fence". They are free to
    // diverge the next time the reward moves, and must be edited separately.
    expect(isFreebuffRewardModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID)).toBe(true)
    expect(isFreebuffGlmV53FlashModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID)).toBe(
      true,
    )
    // Neither predicate matches the OTHER GLM row, which is what a prefix match
    // on `z-ai/glm` would have done.
    expect(isFreebuffRewardModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(false)
    expect(isFreebuffGlmV53FlashModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(false)
    // The reward model is UNMETERED at full access — the reward it backs is an
    // extra PREMIUM session there, not this row. Being in the standard list is
    // what makes that true, and it is the property most easily broken by
    // "tidying" the reward into the premium lists.
    expect(isFreebuffPremiumModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID)).toBe(
      false,
    )
    expect(
      (FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).includes(
        FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      ),
    ).toBe(true)
    // GLM 5.2 is in NO pool at all now: withdrawn, and out of the web catalog
    // the standard list is derived from. Both halves matter — it is
    // `premium: true`, so a row left in the catalog but out of the premium
    // lists would become UNMETERED rather than merely stricter.
    expect(isFreebuffPremiumModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(false)
    expect(
      (FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).includes(
        FREEBUFF_GLM_V52_MODEL_ID,
      ),
    ).toBe(false)
    expect(isFreebuffPausedFreeModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(true)
    // Suffix tolerance holds, so a dated provider snapshot cannot dodge either
    // predicate — and still does not cross between the two rows.
    expect(isFreebuffGlmV53FlashModelId('z-ai/glm-5.3-flash-20260601')).toBe(
      true,
    )
    expect(isFreebuffRewardModelId('z-ai/glm-5.3-flash-20260601')).toBe(true)
    expect(isFreebuffRewardModelId('z-ai/glm-5.2-20260601')).toBe(false)
  })

  test('GLM 5.3 Flash is unmetered at full access', () => {
    // Unmetered on 2026-08-28, matching DeepSeek V4 Flash and MiMo. It was
    // premium-pooled while its cost was unknown; measured prod spend settled
    // that as the cheapest row we serve, 8.9x under the already-unmetered
    // V4 Flash. Capping the cheapest model while the dearer ones run uncapped
    // inverts the reason caps exist.
    expect(isFreebuffPremiumModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID)).toBe(
      false,
    )
    expect(
      (FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).includes(
        FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      ),
    ).toBe(true)
  })

  test('GLM 5.3 Flash: unmetered for FULL access, selectable at limited on every surface', () => {
    // The four properties this change had to deliver, asserted together
    // because they are separately true and separately breakable.
    const id = FREEBUFF_GLM_V53_FLASH_MODEL_ID

    // 1. NOT METERED — out of the shared premium pool.
    expect(isFreebuffPremiumModelId(id)).toBe(false)
    expect(FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).toContain(id)

    // 2. PARITY with the row the change was specified against. If DeepSeek V4
    //    Flash is ever re-metered, this fails and forces the pair to be
    //    reconsidered together rather than drifting apart silently.
    expect(isFreebuffPremiumModelId(id)).toBe(
      isFreebuffPremiumModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
    )
    expect(FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).toContain(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )

    // 3. Explicitly available in both limited catalogs. Freebucks admission
    //    charges the same model price regardless of the picker surface.
    expect(LIMITED_FREEBUFF_MODEL_IDS as readonly string[]).toContain(id)
    expect(FREEBUFF_WEB_GEO_EXEMPT_MODEL_IDS as readonly string[]).toContain(id)
    expect(FREEBUFF_WEB_LIMITED_MODEL_IDS as readonly string[]).toContain(id)
    expect(isFreebuffWebModelAllowedForLimitedTier(id, false)).toBe(true)
    expect(isRewardModelRedeemableAtLimitedTier(id)).toBe(true)

    // 4. FULLY AVAILABLE to full access: in the catalog, open at every hour,
    //    not paused, and reachable on every surface's model list.
    expect(FREEBUFF_MODELS.map((m) => m.id)).toContain(id)
    expect(isFreebuffPausedFreeModelId(id)).toBe(false)
    expect(FREEBUFF_MODELS.find((m) => m.id === id)?.availability).toBe(
      'always',
    )
  })

  /**
   * NOTHING NUDGES ANYONE ANYWHERE, as of 2026-08-21.
   *
   * This is one assertion over the whole catalog rather than a per-model check,
   * because the hazard is a notice being ADDED back rather than an existing one
   * being wrong — and because both notices that used to live here expired
   * without anyone noticing (each claimed V4 Flash was the better default;
   * Flash then became premium and started closing during peak hours).
   *
   * It matters more than copy: migrateSupersededFreebuffModelPreference
   * rewrites a SAVED pick on every load, so a supersedes notice silently moves
   * users off the model they chose, on every launch, with no action from them.
   */
  test('no model supersedes any other', () => {
    const all = FREEBUFF_MODELS.map((model) => model.id)
    for (const id of all) {
      expect(getFreebuffModelSupersededBy(id, all)).toBeUndefined()
    }
  })

  /**
   * Luna is FULL-ACCESS ONLY. Admission is shared by CLI, Desktop, Web and
   * Cloud — so a limited-tier user must be refused it on every one of them
   * rather than shown a picker row whose first send fails.
   */
  test('Luna is full-access only', () => {
    // V4 Pro left this list on 2026-08-26 — not because the property changed
    // but because the property is now enforced somewhere stronger: a withdrawn
    // model is refused at EVERY tier (see the withdrawal test below), so
    // asserting it is merely out of the limited one would be a weaker claim
    // than the code makes.
    //
    // GLM 5.3 Flash LEFT this list on 2026-08-31, when it became the earned
    // reward: a limited-tier caller may name it so a bounty grant is redeemable
    // from any region, and the POOL refuses them if they hold none. It is
    // asserted in its own test above rather than dropped silently. V4 Flash
    // left on 2026-09-02, when it rejoined the limited catalog.
    for (const id of [FREEBUFF_GPT_5_6_LUNA_MODEL_ID]) {
      expect(isFreebuffSessionModelAllowedForAccessTier(id, 'limited')).toBe(
        false,
      )
      expect(isFreebuffSessionModelAllowedForAccessTier(id, 'full')).toBe(true)
    }
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_GLM_V53_FLASH_MODEL_ID,
        'full',
      ),
    ).toBe(true)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        'limited',
      ),
    ).toBe(true)
  })

  /**
   * THE invariant, restated as what it has always really been: V4 Pro and V4
   * Flash are never closed at the same time.
   *
   * Which one closes has flipped three times in two days, each time following
   * the LANE — a row is shut at peak only while served by a provider that
   * doubles there. Pinning the assertion to a particular row made it a
   * tripwire for every lane move; pinning it to the pair keeps the property
   * that actually protects users, which is that the catalog's two strongest
   * models are never dark together.
   *
   * Both are `always` as of 2026-08-22, with Pro on a flat-priced lane.
   */
  test('V4 Pro and V4 Flash are never both closed', () => {
    for (const hour of [0, 2, 5, 9, 10, 12, 18, 23]) {
      const at = new Date(Date.UTC(2026, 7, 22, hour, 0, 0))
      const pro = isFreebuffSessionModelAvailable(
        FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
        at,
      )
      const flash = isFreebuffSessionModelAvailable(
        FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        at,
      )
      expect(pro || flash, `both closed at ${hour}:00 UTC`).toBe(true)
    }
    // Today specifically: neither closes at all.
    const peak = new Date('2026-08-22T02:00:00Z')
    expect(
      isFreebuffSessionModelAvailable(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, peak),
    ).toBe(true)
    expect(
      isFreebuffSessionModelAvailable(
        FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        peak,
      ),
    ).toBe(true)
  })

  /**
   * Closing Flash is only worth doing if its traffic lands on the CHEAPER row
   * rather than the weaker one. Without `unavailableFallback` it would fall to
   * FALLBACK_FREEBUFF_MODEL_ID (the unlimited row), which would defeat the
   * point of closing it.
   */
  /**
   * ARMED, NOT DELETED. `unavailableFallback` is what stops a closed row
   * dumping its traffic on the unlimited model instead of the other premium
   * one, and it has been needed twice — Flash -> Pro, then Pro -> Flash — as
   * the closure followed the lane. Nothing declares it today because nothing
   * closes, so this asserts the mechanism rather than a particular pair.
   */
  test('any row that closes redirects to an OPEN premium row, not the unlimited one', () => {
    const peak = new Date('2026-08-22T02:00:00Z')
    for (const model of FREEBUFF_MODELS) {
      if (isFreebuffSessionModelAvailable(model.id, peak)) continue
      const landed = resolveAvailableFreebuffModel(model.id, peak)
      expect(landed, `${model.id} redirect`).not.toBe(model.id)
      expect(isFreebuffSessionModelAvailable(landed, peak)).toBe(true)
    }
  })

  test('Solar is fully unlimited at full access', () => {
    expect(isFreebuffPremiumModelId(FREEBUFF_SOLAR_PRO_4_MODEL_ID)).toBe(false)
    expect(FREEBUFF_STANDARD_MODEL_IDS as readonly string[]).toContain(
      FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    )
  })

  test('the tier notice states the Solar entitlement directly', () => {
    expect(FREEBUFF_TIER_CHANGE_NOTICE).toContain(
      'Solar Pro 4 is now unmetered at full access',
    )
    expect(FREEBUFF_TIER_CHANGE_NOTICE).toContain(
      'available with limited access',
    )
  })

  test('MiMo 2.5 remains supported and follows the UI rollout flag', () => {
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_MIMO_V25_MODEL_ID,
    )

    if (FREEBUFF_ENABLE_MIMO_MODELS_IN_UI) {
      expect(FREEBUFF_MODELS.map((model) => model.id)).toContain(
        FREEBUFF_MIMO_V25_MODEL_ID,
      )
    } else {
      expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
        FREEBUFF_MIMO_V25_MODEL_ID,
      )
    }

    expect(isFreebuffPremiumModelId(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(false)
    expect(getFreebuffModelImageSupport(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(true)
  })

  test('MiMo 2.5 Pro is fully removed from Freebuff', () => {
    // Retired from the client pickers 2026-07-31, server half removed
    // 2026-08-04 once the tail had decayed from ~170 to ~33 daily users. Same
    // two-stage shape Kimi K2.7 Code went through. Paid/BYOK MiMo Pro is
    // unaffected; it never resolves through these helpers.
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_MIMO_V25_PRO_MODEL_ID,
    )
    expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_MIMO_V25_PRO_MODEL_ID,
    )
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_MIMO_V25_PRO_MODEL_ID,
    )
    expect(isFreebuffModelId(FREEBUFF_MIMO_V25_PRO_MODEL_ID)).toBe(false)
    expect(isSupportedFreebuffModelId(FREEBUFF_MIMO_V25_PRO_MODEL_ID)).toBe(
      false,
    )
    expect(isFreebuffSessionModelId(FREEBUFF_MIMO_V25_PRO_MODEL_ID)).toBe(false)
    expect(isFreebuffPremiumModelId(FREEBUFF_MIMO_V25_PRO_MODEL_ID)).toBe(false)
    // The non-Pro model must not be caught by the removal: the ids share a
    // prefix, and freebuffModelIdMatches only tolerates dated suffixes.
    expect(isFreebuffSessionModelId(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(true)
  })

  test('reports image support only for known Freebuff models', () => {
    expect(
      getFreebuffModelImageSupport(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID),
    ).toBe(false)
    expect(getFreebuffModelImageSupport(MINIMAX_M3_MODEL_ID)).toBe(true)
    expect(
      getFreebuffModelImageSupport('vendor/new-vision-model'),
    ).toBeUndefined()

    for (const model of SUPPORTED_FREEBUFF_MODELS) {
      expect(isFreebuffMultimodalModelId(model.id)).toBe(model.multimodal)
    }
    for (const model of FREEBUFF_WEB_ALL_MODELS) {
      expect(isFreebuffWebMultimodalModelId(model.id)).toBe(model.multimodal)
    }
  })

  test('Kimi K2.7 Code is fully removed from Freebuff', () => {
    // Removed 2026-07-31 (client pickers went first, on 2026-07-30). The server
    // half is gone too, so a stale client selection is no longer admitted —
    // that tail was still a material daily spend. Paid/BYOK Kimi is unaffected;
    // it never resolves through these helpers.
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_KIMI_MODEL_ID,
    )
    expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_KIMI_MODEL_ID,
    )
    expect(
      getFreebuffModelsForAccessTier('full').map((m) => m.id),
    ).not.toContain(FREEBUFF_KIMI_MODEL_ID)
    expect(isFreebuffModelId(FREEBUFF_KIMI_MODEL_ID)).toBe(false)
    expect(isSupportedFreebuffModelId(FREEBUFF_KIMI_MODEL_ID)).toBe(false)
    expect(getFreebuffWebModel(FREEBUFF_KIMI_MODEL_ID).id).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
    expect(isFreebuffPremiumModelId(FREEBUFF_KIMI_MODEL_ID)).toBe(false)
    expect(
      isFreebuffModelAllowedForAccessTier(FREEBUFF_KIMI_MODEL_ID, 'full'),
    ).toBe(false)
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_KIMI_MODEL_ID, 'full'),
    ).toBe(FALLBACK_FREEBUFF_MODEL_ID)
    // Session admission no longer accepts it either, so live stale sessions
    // resolve to the fallback instead of continuing on Kimi.
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_KIMI_MODEL_ID,
        'full',
      ),
    ).toBe(false)
    expect(
      resolveFreebuffSessionModelForAccessTier(FREEBUFF_KIMI_MODEL_ID, 'full', {
        includeGodOnly: false,
      }),
    ).toBe(FALLBACK_FREEBUFF_MODEL_ID)
    // Retired K2.6 is no longer a freebuff model; stale saved selections must
    // fall back rather than be admitted.
    expect(isSupportedFreebuffModelId('moonshotai/kimi-k2.6')).toBe(false)
    expect(
      isFreebuffModelAllowedForAccessTier('moonshotai/kimi-k2.6', 'full'),
    ).toBe(false)
    expect(
      resolveFreebuffModelForAccessTier('moonshotai/kimi-k2.6', 'full'),
    ).not.toBe('moonshotai/kimi-k2.6')
  })

  test('both HY3 routes are fully removed from Freebuff', () => {
    // HY3 was withdrawn from the Web picker during the initial rollout and left
    // in FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS, which is a client-side filter
    // and therefore not a gate at all — the same mistake that let the CrofAI
    // GLM route be farmed. Removed outright 2026-08-04, along with the
    // god-only paid OpenRouter route.
    //
    // As of 2026-08-07 the wire-id CONSTANTS are gone too: hy3-fallback.ts and
    // the Atlas Cloud adapter that was its paid lane have been deleted, so
    // nothing routes `tencent/hy3` on any path, paid or free. The slugs are
    // spelled out literally here precisely because no constant remains to
    // import — that is the point of the test.
    for (const hy3Id of ['tencent/hy3:free', 'tencent/hy3']) {
      expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(hy3Id)
      expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
        hy3Id,
      )
      expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(hy3Id)
      expect(
        FREEBUFF_WEB_GOD_ONLY_MODELS.map((model) => model.id),
      ).not.toContain(hy3Id)
      expect(FREEBUFF_WEB_ALL_MODELS.map((model) => model.id)).not.toContain(
        hy3Id,
      )

      expect(isFreebuffModelId(hy3Id)).toBe(false)
      expect(isSupportedFreebuffModelId(hy3Id)).toBe(false)
      expect(isFreebuffWebModelId(hy3Id, { includeGodOnly: true })).toBe(false)
      expect(isFreebuffWebGodOnlyModelId(hy3Id)).toBe(false)
      expect(isFreebuffSessionModelId(hy3Id)).toBe(false)
      // No pool may meter it, in either direction: premium would hand it out
      // free, and standard would leave it unlimited.
      expect(isFreebuffWebPremiumModelId(hy3Id)).toBe(false)
      expect(isFreebuffPremiumModelId(hy3Id)).toBe(false)
      expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(hy3Id)
      // A stale saved selection downgrades rather than resolving to itself.
      expect(resolveFreebuffWebModel(hy3Id, { includeGodOnly: true })).toBe(
        FALLBACK_FREEBUFF_MODEL_ID,
      )
      expect(getFreebuffWebModel(hy3Id).id).toBe(FALLBACK_FREEBUFF_MODEL_ID)
    }
  })

  test('the picker-retirement list holds only ids that are harmless to reach', () => {
    // Both long-term former occupants (HY3, CrofAI GLM 5.2) were farmed or left
    // publicly advertised precisely because a picker-only retirement is a UI
    // change, not a gate. So every entry here has to pass the bar the list's
    // own doc sets: reachable by a direct API caller AND harmless while it is.
    //
    // Muse Spark 1.2 passes it (parked 2026-09-02 while its Web sessions
    // drain): it costs exactly what its replacement costs, is metered by the
    // same premium pool, and spends the same Contributor-tier budget at Meta.
    // It is a temporary occupant — see the removal order on its constant. If
    // anything ELSE turns up here, check it against the same three questions
    // before accepting it.
    // EMPTY since 2026-09-07: its only occupant, Muse Spark 1.2, went back
    // into the pickers when 1.3 was withdrawn. An id landing here again should
    // be checked against the same three questions in the comment above.
    expect(FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS).toEqual([])
    for (const id of FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS) {
      // Still a session model (live sessions keep running) and still metered
      // by some pool (never unlimited by omission).
      expect(isFreebuffSessionModelId(id)).toBe(true)
      expect(isFreebuffWebPremiumModelId(id)).toBe(true)
      expect(isFreebuffRewardModelId(id)).toBe(false)
    }
    for (const model of FREEBUFF_WEB_ALL_MODELS) {
      expect(isFreebuffWebSelectableModelId(model.id)).toBe(
        !FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS.some((id) => id === model.id),
      )
    }
  })

  test('GLM 5.2 is referral-only and reachable by exactly one model id', () => {
    // The earned route stays selectable — removing the other GLM route must
    // never take this one down with it.
    expect(isFreebuffWebSelectableModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(true)
    // Every other web model is unaffected.
    expect(
      isFreebuffWebSelectableModelId(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID),
    ).toBe(true)
  })

  test('CLI access-tier resolver preserves the reward model at every tier', () => {
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_REWARD_MODEL_ID, 'full'),
    ).toBe(FREEBUFF_REWARD_MODEL_ID)
    // At full access it survives because it is an ordinary catalog row — the
    // default one, in fact — so there is nothing special to preserve.
    //
    // At LIMITED access it survives the coercion for the reason bounties
    // introduced in 2026-08-03 and the reward swap kept: an earned session must
    // be redeemable in every region. The entitlement gate lives DOWN in the
    // reward quota pool, which at limited tier counts ONLY grants minted
    // redeemable_at_limited_tier — referral entitlement still buys a
    // limited-tier user nothing. Coercing here instead would rewrite a
    // deliberate pick to MiMo and strand the session they earned.
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_REWARD_MODEL_ID, 'limited'),
    ).toBe(FREEBUFF_REWARD_MODEL_ID)
    // The WITHDRAWN row does not survive it any more, at either tier — which is
    // the whole point of pausing rather than deleting: it is recognised, and
    // therefore coerced, instead of refused.
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_GLM_V52_MODEL_ID, 'limited'),
    ).toBe(LIMITED_FREEBUFF_MODEL_ID)
    // Everything else still collapses to the limited model.
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_KIMI_MODEL_ID, 'limited'),
    ).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })

  test('the CrofAI GLM 5.2 wire id is fully removed', () => {
    // Retired from the pickers 2026-07-30 and deleted 2026-08-04. The picker
    // retirement was client-side only, so hand-written API callers kept
    // admitting sessions on this id and drawing GLM 5.2 from the free daily
    // PREMIUM pool instead of the earned GLM pool — 12-49 distinct accounts a
    // day, five days after it was supposedly unreachable. No shipped client
    // ever bundled it, so deleting it breaks nothing.
    //
    // The invariant this guards: GLM 5.2 must have exactly ONE wire id. The
    // quota pool is chosen by model id, so a second id is a second entitlement.
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_CROF_GLM_V52_MODEL_ID,
    )
    expect(FREEBUFF_WEB_ALL_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_CROF_GLM_V52_MODEL_ID,
    )
    expect(isFreebuffWebModelId(FREEBUFF_CROF_GLM_V52_MODEL_ID)).toBe(false)
    expect(isFreebuffSessionModelId(FREEBUFF_CROF_GLM_V52_MODEL_ID)).toBe(false)
    // Critically: it must not be metered by the free daily premium pool, which
    // is the door this whole removal closes.
    expect(isFreebuffWebPremiumModelId(FREEBUFF_CROF_GLM_V52_MODEL_ID)).toBe(
      false,
    )
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(
      FREEBUFF_CROF_GLM_V52_MODEL_ID,
    )
    // A stale saved selection downgrades to the always-available fallback.
    expect(resolveFreebuffWebModel(FREEBUFF_CROF_GLM_V52_MODEL_ID)).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
    // GLM 5.2's own id stays RECOGNISED after its 2026-08-31 withdrawal — that
    // is the difference between pausing and deleting, and it is what lets a
    // released binary's pick be coerced instead of refused (#1801). It is no
    // longer the reward, which now names GLM 5.3 Flash.
    expect(isFreebuffSessionModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(true)
    expect(isFreebuffRewardModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(false)
    expect(isFreebuffRewardModelId(FREEBUFF_REWARD_MODEL_ID)).toBe(true)
  })

  test('an earned row is never remembered as the default, at the tier where it is earned', () => {
    // An earned row runs out long before the rest of the picker, so remembering
    // it would strand a new thread / app / page load on a model that fails
    // admission.
    //
    // TIER-SCOPED SINCE 2026-08-31. The reward model is GLM 5.3 Flash, earned
    // only at LIMITED access; at full access it is unmetered and is
    // DEFAULT_FREEBUFF_WEB_MODEL_ID itself, so refusing to remember it there
    // would make the product's default the one pick that never sticks.
    expect(
      isFreebuffWebRememberableModelId(FREEBUFF_REWARD_MODEL_ID, 'limited'),
    ).toBe(false)
    expect(
      resolveRememberedFreebuffWebModel(FREEBUFF_REWARD_MODEL_ID, {
        accessTier: 'limited',
      }),
    ).toBe(DEFAULT_FREEBUFF_WEB_MODEL_ID)
    // A withdrawn row is never remembered either, by a different mechanism:
    // it resolves to the always-available fallback before this rule is asked.
    expect(resolveRememberedFreebuffWebModel(FREEBUFF_GLM_V52_MODEL_ID)).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
    // A SAVED PRO PICK SELF-HEALS. Pro was withdrawn on 2026-08-26, and a saved
    // preference is the longest-lived way to hold a dead id — it survives every
    // deploy and outlives the client release that dropped the row. Resolving it
    // to the always-available fallback (rather than to the premium default) is
    // what stops a returning user's page load landing on a model whose first
    // send is refused.
    expect(
      resolveRememberedFreebuffWebModel(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID),
    ).toBe(FALLBACK_FREEBUFF_MODEL_ID)
    // The same row IS remembered at full access, where it is unmetered and
    // cannot run out. The default when the tier is unknown is the permissive
    // one, which is correct for every row but this one at that one tier.
    expect(
      isFreebuffWebRememberableModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID, 'full'),
    ).toBe(true)
    expect(
      isFreebuffWebRememberableModelId(FREEBUFF_GLM_V53_FLASH_MODEL_ID),
    ).toBe(true)
    expect(resolveRememberedFreebuffWebModel(FREEBUFF_KIMI_MODEL_ID)).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
    expect(
      resolveRememberedFreebuffWebModel(FREEBUFF_KIMI_K3_ECO_MODEL_ID, {
        includeGodOnly: true,
      }),
    ).toBe(FREEBUFF_KIMI_K3_ECO_MODEL_ID)
    // A retired/unknown saved id keeps the pre-existing resolution: the
    // always-available fallback, not the premium default.
    expect(resolveRememberedFreebuffWebModel('some/retired-model')).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
  })

  test('every Web/Cloud model falls into exactly one quota group', () => {
    // A model marked premium must be metered by the premium pool; a model that
    // is not may safely fall through to the free Standard group. A premium
    // model matching NEITHER silently lands in Standard and becomes unlimited,
    // which is a quota bug and not a cosmetic one.
    //
    // THE REWARD PREDICATE IS DELIBERATELY NOT PART OF THIS SUM as of
    // 2026-08-31. It used to be, because the reward was its own model on its
    // own pool and "referral GLM, premium, or Standard" partitioned the
    // catalog. The reward model is now GLM 5.3 Flash, which is ALSO an ordinary
    // unmetered Standard row at full access — the reward pool it belongs to
    // exists only at the limited tier. Counting it as a group here would assert
    // that the product's default model is metered, which is the opposite of
    // what it is.
    //
    // FREEBUFF_WEB_ALL_MODELS, not FREEBUFF_WEB_MODELS: the god-only rows are
    // ADDITIVE to the visible list (FREEBUFF_WEB_ALL_MODELS = god-only +
    // visible), so a loop over the visible list alone can never see a god-only
    // model that fell into no pool — which is exactly the shape this bug had.
    for (const model of FREEBUFF_WEB_ALL_MODELS) {
      expect({
        id: model.id,
        metered: isFreebuffWebPremiumModelId(model.id),
      }).toEqual({ id: model.id, metered: model.premium })
    }
  })

  test('the removed CrofAI GLM 5.2 id is admitted at no access tier', () => {
    for (const tier of ['limited', 'full'] as const) {
      expect(
        isFreebuffSessionModelAllowedForAccessTier(
          FREEBUFF_CROF_GLM_V52_MODEL_ID,
          tier,
        ),
      ).toBe(false)
    }
    expect(
      isFreebuffWebModelAllowedForLimitedTier(FREEBUFF_CROF_GLM_V52_MODEL_ID),
    ).toBe(false)
    expect(isFreebuffWebGeoExemptModelId(FREEBUFF_CROF_GLM_V52_MODEL_ID)).toBe(
      false,
    )
    expect(
      resolveFreebuffWebModelForLimitedTier(FREEBUFF_CROF_GLM_V52_MODEL_ID),
    ).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })

  test('the bounty-earned reward survives the Web limited-tier coercion', () => {
    // Regression: this coercion ran BEFORE the quota pool got a say, so a
    // limited-region user who had earned a bounty session had their pick
    // rewritten to the free model and could never spend the reward. The
    // entitlement gate is the reward pool (bounty grants only, at this tier) —
    // not this allowlist, which is purely about what the picker may display.
    //
    // Follows the reward model rather than naming one, so the next swap moves
    // this assertion with it instead of leaving it pinned to a withdrawn row.
    expect(
      isFreebuffWebModelAllowedForLimitedTier(FREEBUFF_REWARD_MODEL_ID),
    ).toBe(true)
    expect(
      resolveFreebuffWebModelForLimitedTier(FREEBUFF_REWARD_MODEL_ID),
    ).toBe(FREEBUFF_REWARD_MODEL_ID)
    // The WITHDRAWN row does not survive it — a paused id is coerced away at
    // every tier, which is why pausing had to accompany the reward swap.
    expect(
      resolveFreebuffWebModelForLimitedTier(FREEBUFF_GLM_V52_MODEL_ID),
    ).toBe(LIMITED_FREEBUFF_MODEL_ID)

    // The CrofAI GLM route is a paid premium model, NOT the earned one, and
    // must stay coerced away — the two ids are easy to confuse.
    expect(
      isFreebuffWebModelAllowedForLimitedTier(FREEBUFF_CROF_GLM_V52_MODEL_ID),
    ).toBe(false)
  })

  test('Kimi K3 is a god-only Freebuff Web/Cloud test model', () => {
    // The wire id must keep the `crof/` prefix and the `-eco` build suffix:
    // isCrofModel keys off the exact id, and CrofAI also serves a full
    // `kimi-k3` at twice the price. See kimi-k3-god-only.test.ts.
    expect(FREEBUFF_KIMI_K3_ECO_MODEL_ID).toBe('crof/kimi-k3-eco')

    expect(FREEBUFF_WEB_GOD_ONLY_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_KIMI_K3_ECO_MODEL_ID,
    )
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_KIMI_K3_ECO_MODEL_ID,
    )
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_KIMI_K3_ECO_MODEL_ID,
    )

    expect(isFreebuffWebModelId(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(false)
    expect(
      isFreebuffWebModelId(FREEBUFF_KIMI_K3_ECO_MODEL_ID, {
        includeGodOnly: true,
      }),
    ).toBe(true)
    expect(isFreebuffWebGodOnlyModelId(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(
      true,
    )
    expect(isFreebuffWebPremiumModelId(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(
      true,
    )
    // Never reachable from the CLI/Desktop picker or a limited-tier browser.
    expect(isFreebuffPremiumModelId(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(false)
    expect(isFreebuffModelId(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(false)
    expect(
      isFreebuffWebModelAllowedForLimitedTier(FREEBUFF_KIMI_K3_ECO_MODEL_ID),
    ).toBe(false)

    expect(resolveFreebuffWebModel(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
    expect(
      resolveFreebuffWebModel(FREEBUFF_KIMI_K3_ECO_MODEL_ID, {
        includeGodOnly: true,
      }),
    ).toBe(FREEBUFF_KIMI_K3_ECO_MODEL_ID)

    const model = getFreebuffWebModel(FREEBUFF_KIMI_K3_ECO_MODEL_ID)
    // 'Kimi K3', not 'Kimi K3 Eco' — deliberate, see kimi-k3-god-only.test.ts.
    expect(model.displayName).toBe('Kimi K3')
    expect(model.tagline).toBe('Via CrofAI')
    expect(model.experimental).toBe(true)
    expect(model.multimodal).toBe(false)
    expect(getFreebuffModelImageSupport(FREEBUFF_KIMI_K3_ECO_MODEL_ID)).toBe(
      false,
    )
  })

  test('Codex (test)/Luna-ES is a god-only Freebuff Web/Cloud test model', () => {
    // Mirrors the Kimi K3 assertions above: a god-only model must carry its id
    // in both FREEBUFF_WEB_GOD_ONLY_MODEL_IDS and FREEBUFF_WEB_PREMIUM_MODEL_IDS,
    // or it is neither gated nor metered. See docs/freebuff-honeypot-models.md.
    expect(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID).toBe('openai/gpt-5.6-luna-es')

    expect(FREEBUFF_WEB_GOD_ONLY_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
    )
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
    )
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
    )

    expect(isFreebuffWebModelId(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)).toBe(false)
    expect(
      isFreebuffWebModelId(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID, {
        includeGodOnly: true,
      }),
    ).toBe(true)
    expect(isFreebuffWebGodOnlyModelId(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)).toBe(
      true,
    )
    // A premium model absent from every pool lands in the unmetered Standard
    // set instead — this must be true, or it isn't in SOME pool.
    expect(isFreebuffWebPremiumModelId(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)).toBe(
      true,
    )
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(
      FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
    )
    // Never reachable from the CLI/Desktop picker or a limited-tier browser.
    expect(isFreebuffPremiumModelId(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)).toBe(
      false,
    )
    expect(isFreebuffModelId(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)).toBe(false)
    expect(
      isFreebuffWebModelAllowedForLimitedTier(
        FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID,
      ),
    ).toBe(false)

    expect(resolveFreebuffWebModel(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
    expect(
      resolveFreebuffWebModel(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID, {
        includeGodOnly: true,
      }),
    ).toBe(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)

    const model = getFreebuffWebModel(FREEBUFF_GPT_5_6_LUNA_ES_MODEL_ID)
    expect(model.displayName).toBe('Codex (test)')
    expect(model.multimodal).toBe(false)
  })

  test('Ling 3.0 Flash and Greg 2 are fully removed from Freebuff', () => {
    // All three were god-only test rows, removed 2026-08-07. Spelled literally
    // because no constant remains to import.
    for (const removedId of [
      'inclusionai/ling-3.0-flash:free',
      'crof/greg-2-ultra',
      'crof/greg-2-super',
    ]) {
      expect(FREEBUFF_WEB_ALL_MODELS.map((model) => model.id)).not.toContain(
        removedId,
      )
      expect(
        FREEBUFF_WEB_GOD_ONLY_MODELS.map((model) => model.id),
      ).not.toContain(removedId)
      expect(isFreebuffWebModelId(removedId, { includeGodOnly: true })).toBe(
        false,
      )
      expect(isFreebuffWebGodOnlyModelId(removedId)).toBe(false)
      expect(isFreebuffSessionModelId(removedId)).toBe(false)
      // No pool may still meter them, in either direction.
      expect(isFreebuffWebPremiumModelId(removedId)).toBe(false)
      expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(removedId)
      expect(resolveFreebuffWebModel(removedId, { includeGodOnly: true })).toBe(
        FALLBACK_FREEBUFF_MODEL_ID,
      )
    }
  })

  test('KAT Coder Pro V2 is fully retired from Freebuff Web and Cloud', () => {
    const retiredKatModelId = 'kwaipilot/kat-coder-pro-v2'
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(
      retiredKatModelId,
    )
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      retiredKatModelId,
    )
    expect(isFreebuffWebModelId(retiredKatModelId)).toBe(false)
    expect(isFreebuffWebPremiumModelId(retiredKatModelId)).toBe(false)
    expect(resolveFreebuffWebModel(retiredKatModelId)).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
  })

  test('MiniMax M2.7 support is fully removed', () => {
    const legacyMinimaxM27 = 'minimax/minimax-m2.7'
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      legacyMinimaxM27,
    )
    expect(isFreebuffModelId(legacyMinimaxM27)).toBe(false)
    expect(isSupportedFreebuffModelId(legacyMinimaxM27)).toBe(false)
    expect(isFreebuffModelAllowedForAccessTier(legacyMinimaxM27, 'full')).toBe(
      false,
    )
    // Old clients with a saved M2.7 selection resolve to the fallback model.
    expect(resolveFreebuffModelForAccessTier(legacyMinimaxM27, 'full')).toBe(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
  })

  test('MiniMax M3 is withdrawn: recognised, refused, served to nobody', () => {
    // Withdrawn from free mode entirely on 2026-08-20 after its hourly burn
    // became the largest single line on the bill. Out of every picker and pool...
    expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      MINIMAX_M3_MODEL_ID,
    )
    expect(isFreebuffModelId(MINIMAX_M3_MODEL_ID)).toBe(false)
    expect(isFreebuffPremiumModelId(MINIMAX_M3_MODEL_ID)).toBe(false)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(MINIMAX_M3_MODEL_ID, 'full'),
    ).toBe(false)

    // ...but still RECOGNISED, which is what separates withdrawing a model from
    // breaking the clients that still ask for it. Released binaries keep this id
    // in their compiled-in catalog; an unrecognised id can only be refused, and
    // that refusal is the #1801 retry loop.
    expect(isFreebuffSessionModelId(MINIMAX_M3_MODEL_ID)).toBe(true)
    expect(isFreebuffPausedFreeModelId(MINIMAX_M3_MODEL_ID)).toBe(true)
    // It is REFUSED, not silently substituted — the user asked for a specific
    // model and is told it is gone, with what to use instead. The refusal is
    // not session-ending, so the client shows it rather than re-admitting.
    expect(freebuffWithdrawnModelMessage(MINIMAX_M3_MODEL_ID)).toContain(
      'no longer available in Freebuff',
    )
    // Names whatever the current default is. This is the one place a specific
    // model is still named TO a user: the pick is gone, so pointing somewhere
    // is the alternative to a dead end.
    expect(freebuffWithdrawnModelMessage(MINIMAX_M3_MODEL_ID)).toContain(
      'GLM 5.3 Flash',
    )

    // The AGENT door stays open, and that is not an oversight. Withdrawal is
    // enforced at admission, so no NEW session can name the model. Sessions
    // admitted before the deploy are still live and hit this allowlist on
    // every turn; dropping the row would fail them mid-turn with
    // free_mode_invalid_agent_model — the same wedge withdrawal exists to
    // avoid. They drain against a door that is already shut in front of them.
    expect(
      isFreeModeAllowedAgentModel('base2-free-minimax-m3', MINIMAX_M3_MODEL_ID),
    ).toBe(true)
  })

  test('the recommended default leads FREEBUFF_MODELS, and the fallback is in it', () => {
    // FREEBUFF_MODELS order IS the picker row order, and it went stale once
    // when the default flipped without reordering — the rows led with Flash
    // while the recommendation already named Pro. Pin the lead position to the
    // constant that drives the recommendation, so a future default change
    // can't silently leave this list behind.
    expect(FREEBUFF_MODELS[0]!.id).toBe(DEFAULT_FREEBUFF_MODEL_ID)
    // And the model every surface steps DOWN to has to be a row the picker
    // actually offers, or the step-down lands on something the user cannot see
    // or re-select afterwards.
    expect(FREEBUFF_MODELS.map((model) => model.id)).toContain(
      FALLBACK_FREEBUFF_MODEL_ID,
    )
  })

  test('GPT-5.6 Luna is a premium model on every full-access surface', () => {
    // The wire id must stay OpenRouter's own slug: getChatCompletionsProvider
    // has no Luna branch, so it only reaches OpenRouter by falling through to
    // the default route with the slug intact.
    expect(FREEBUFF_GPT_5_6_LUNA_MODEL_ID).toBe('openai/gpt-5.6-luna')

    // CLI/Desktop picker, Web/Cloud picker, and the session/chat layers.
    expect(FREEBUFF_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    expect(getFreebuffModelsForAccessTier('full').map((m) => m.id)).toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    // Everyone on the tier can pick it — it is not god-only and not retired.
    expect(isFreebuffWebGodOnlyModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(
      false,
    )
    expect(isFreebuffWebSelectableModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(
      true,
    )

    // Metered by the SHARED daily premium pool on every surface, never a pool
    // of its own or the unmetered standard class.
    expect(isFreebuffPremiumModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(true)
    expect(isFreebuffWebPremiumModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(
      true,
    )
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    expect(isFreebuffRewardModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(false)
    // Dated snapshots can't dodge the premium quota or the pinned routing.
    expect(
      isFreebuffPremiumModelId(`${FREEBUFF_GPT_5_6_LUNA_MODEL_ID}-20260709`),
    ).toBe(true)
    expect(
      isFreebuffGpt56LunaModelId(`${FREEBUFF_GPT_5_6_LUNA_MODEL_ID}-20260709`),
    ).toBe(true)
    expect(isFreebuffGpt56LunaModelId(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(false)

    const model = getFreebuffWebModel(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)
    expect(model.displayName).toBe('GPT-5.6 Luna')
    // OpenAI's API does not train on request data, so no warning and no
    // trace storage — and it accepts images.
    expect(model.dataUse).toBe('service')
    expect(model.warning).toBeUndefined()
    expect(isFreebuffTracedModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(false)
    expect(getFreebuffModelImageSupport(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)).toBe(
      true,
    )
    // Cheap per token, so it is not one of the muted "costly premium" rows.
    expect(
      isFreebuffWebDeemphasizedModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID),
    ).toBe(false)

    // Limited regions stay geo-gated to the two limited-tier models.
    expect(
      isFreebuffWebModelAllowedForLimitedTier(FREEBUFF_GPT_5_6_LUNA_MODEL_ID),
    ).toBe(false)
    expect(
      isFreebuffModelAllowedForAccessTier(
        FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
        'limited',
      ),
    ).toBe(false)
  })

  test('GPT-5.6 Luna carries its pinned OpenAI route, price ceiling, and effort', () => {
    // These three constants are the contract web/src/llm-api/openrouter.ts
    // enforces on every Luna request.
    expect(FREEBUFF_GPT_5_6_LUNA_PROVIDER_ROUTE).toBe('openai')
    expect(FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT).toBe('high')

    // The ceiling is a cost fence, and both bounds are load-bearing. OpenRouter
    // compares strictly, so a ceiling AT OpenAI's $0.10/$0.60 list price 404s
    // every request ("No endpoints found that satisfy the max price") — that
    // shipped on 2026-07-30 and took Luna down until it was raised. It must
    // also stay well under the $1.00/$6.00 Azure/Bedrock charge, which is the
    // 10x route the fence exists to block.
    const { prompt, completion } = FREEBUFF_GPT_5_6_LUNA_MAX_PRICE
    expect(prompt).toBeGreaterThan(0.1)
    expect(completion).toBeGreaterThan(0.6)
    expect(prompt).toBeLessThan(1.0)
    expect(completion).toBeLessThan(6.0)
  })

  test('limited access exposes GLM 5.3 Flash, Flash, MiMo, and Solar Pro 4', () => {
    // Two constants since 2026-09-07. The HERO (what the pickers lead with
    // and recommend) is the same row as the full default again: GLM 5.3
    // Flash, the cheapest row we serve, priced at 5 on every tier now that
    // the meter covers every account. The COERCION TARGET (where an
    // out-of-tier pick and a substituted session land) stays on DeepSeek V4
    // Flash, the one row joinable with no meter, no grant and no plan — so a
    // rollback of the Freebucks audience cannot turn coercion into refusal.
    expect(LIMITED_FREEBUFF_HERO_MODEL_ID).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(LIMITED_FREEBUFF_HERO_MODEL_ID).toBe(DEFAULT_FREEBUFF_MODEL_ID)
    expect(LIMITED_FREEBUFF_MODEL_ID).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(LIMITED_FREEBUFF_MODEL_IDS[0]).toBe(LIMITED_FREEBUFF_HERO_MODEL_ID)
    expect(LIMITED_FREEBUFF_MODEL_IDS).toEqual([
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      FREEBUFF_MIMO_V25_MODEL_ID,
      FREEBUFF_SOLAR_PRO_4_MODEL_ID,
    ])
    expect(getFreebuffModelsForAccessTier('limited').map((m) => m.id)).toEqual(
      LIMITED_FREEBUFF_MODEL_IDS,
    )
    // Withdrawn rather than merely unlisted: the pause is what reaches the
    // released CLI and Desktop binaries that still draw the row.
    expect(
      isFreebuffModelAllowedForAccessTier(
        FREEBUFF_OX_ALPHA_MODEL_ID,
        'limited',
      ),
    ).toBe(false)
    expect(
      isFreebuffModelAllowedForAccessTier(
        FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        'limited',
      ),
    ).toBe(true)
    expect(
      isFreebuffModelAllowedForAccessTier(MINIMAX_M3_MODEL_ID, 'limited'),
    ).toBe(false)
    expect(
      isFreebuffModelAllowedForAccessTier(
        FREEBUFF_MIMO_V25_MODEL_ID,
        'limited',
      ),
    ).toBe(true)
    expect(
      isFreebuffModelAllowedForAccessTier(
        FREEBUFF_SOLAR_PRO_4_MODEL_ID,
        'limited',
      ),
    ).toBe(true)
    expect(
      isFreebuffModelAllowedForAccessTier(
        FREEBUFF_MIMO_V25_PRO_MODEL_ID,
        'limited',
      ),
    ).toBe(false)
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_MIMO_V25_MODEL_ID, 'limited'),
    ).toBe(FREEBUFF_MIMO_V25_MODEL_ID)
    // An out-of-tier pick lands on the limited default; an in-tier pick is kept.
    expect(
      resolveFreebuffModelForAccessTier(MINIMAX_M3_MODEL_ID, 'limited'),
    ).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(
      resolveFreebuffModelForAccessTier(
        FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        'limited',
      ),
    ).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(LIMITED_FREEBUFF_MODEL_MISMATCH_MESSAGE).toBe(
      'Limited free access is only available with GLM 5.3 Flash or DeepSeek V4 Flash 07/31 or MiMo 2.5 or Solar Pro 4.',
    )
    // No row in the tier supersedes another, so no picker may offer a switch
    // that admission would coerce straight back.
    for (const id of LIMITED_FREEBUFF_MODEL_IDS) {
      expect(
        getFreebuffModelSupersededBy(id, [...LIMITED_FREEBUFF_MODEL_IDS]),
      ).toBeUndefined()
    }
  })

  test('the picker hero is joinable and in-tier', () => {
    // "Hero" is the row the cursor starts on, NOT a recommendation — the
    // ' RECOMMENDED ' badge and every supersedes notice are gone. These
    // assertions are what keep the first Enter press joinable at every point
    // in a user's day.
    expect(getRecommendedFreebuffModelId('full')).toBe(
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    )
    expect(getRecommendedFreebuffModelId(undefined)).toBe(
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    )
    // THE STEP-DOWN NO LONGER FIRES FOR FULL ACCESS, and that is the point of
    // an unmetered default rather than an oversight. `premiumExhausted` says
    // the PREMIUM pool is spent; this hero does not draw on it, so stepping off
    // it would move a user off the row they were just offered, to a different
    // unmetered row, and blame a quota that was never involved.
    //
    // The guard is conditional on the default actually being premium, so this
    // reverts to a real step-down automatically if a premium default returns.
    expect(
      getRecommendedFreebuffModelId('full', { premiumExhausted: true }),
    ).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    // What actually has to hold either way: whatever the hero is with the pool
    // spent, it must be joinable on an empty wallet.
    expect(
      isFreebuffPremiumModelId(
        getRecommendedFreebuffModelId('full', { premiumExhausted: true }),
      ),
    ).toBe(false)
    // Limited access → the same row. The membership assertion below is the
    // load-bearing one: the hero is the row Enter lands on, so a hero outside
    // the tier's own set is a first keypress that fails admission.
    expect(getRecommendedFreebuffModelId('limited')).toBe(
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    )
    expect(
      getFreebuffModelsForAccessTier('limited').some(
        (m) => m.id === getRecommendedFreebuffModelId('limited'),
      ),
    ).toBe(true)
    // Still true with the premium pool spent: the flag must not drag the limited
    // hero anywhere — that tier has no premium pool to spend.
    expect(
      getRecommendedFreebuffModelId('limited', { premiumExhausted: true }),
    ).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
  })

  test('every surface starts on GLM 5.3 Flash, on two separate constants', () => {
    // They stay TWO constants because they have diverged before and may again.
    expect(DEFAULT_FREEBUFF_WEB_MODEL_ID).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(DEFAULT_FREEBUFF_MODEL_ID).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    expect(getRecommendedFreebuffWebModelId('full')).toBe(
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    )
    expect(getRecommendedFreebuffWebModelId(undefined)).toBe(
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
    )
    // Neither default may be a paused model — that is the pairing that would
    // put every new user on a row the server refuses.
    expect(isFreebuffPausedFreeModelId(DEFAULT_FREEBUFF_MODEL_ID)).toBe(false)
    expect(isFreebuffPausedFreeModelId(DEFAULT_FREEBUFF_WEB_MODEL_ID)).toBe(
      false,
    )
    // The starting pick must never be a model the picker also argues against.
    // Vacuous today — nothing supersedes anything — and kept because that is a
    // property of the catalog's current contents, not a guarantee.
    expect(
      getFreebuffModelSupersededBy(
        DEFAULT_FREEBUFF_WEB_MODEL_ID,
        FREEBUFF_WEB_MODELS.map((model) => model.id),
      ),
    ).toBeUndefined()
    // The limited tier recommends its own HERO. Asserted through the tier
    // constant so the hero and the catalog cannot part company. (The
    // full-access pool running dry no longer moves this hero — the default
    // is unmetered — but the tier split is unchanged and still load-bearing.)
    expect(getRecommendedFreebuffWebModelId('limited')).toBe(
      LIMITED_FREEBUFF_HERO_MODEL_ID,
    )
    // Does NOT step down, for the same reason the CLI hero does not: the Web
    // default is unmetered as of 2026-08-30, so a spent PREMIUM pool says
    // nothing about whether this row is joinable. The step-down is conditional
    // on the web default actually being premium and returns automatically if a
    // premium default does.
    expect(
      getRecommendedFreebuffWebModelId('full', { premiumExhausted: true }),
    ).toBe(FREEBUFF_GLM_V53_FLASH_MODEL_ID)
    // The property that must hold whatever the hero is: joinable on an empty
    // wallet.
    expect(
      isFreebuffPremiumModelId(
        getRecommendedFreebuffWebModelId('full', { premiumExhausted: true }),
      ),
    ).toBe(false)
    expect(
      isFreebuffPremiumModelId(
        getRecommendedFreebuffWebModelId('full', { premiumExhausted: true }),
      ),
    ).toBe(false)
    // The web default must be a real, selectable web model.
    expect(isFreebuffWebModelId(DEFAULT_FREEBUFF_WEB_MODEL_ID)).toBe(true)
    // The default IS a limited-tier row, from the ORDINARY catalog — which is
    // the property that matters and is asserted directly, rather than through
    // the reward list.
    expect(
      (FREEBUFF_WEB_LIMITED_MODEL_IDS as readonly string[]).includes(
        DEFAULT_FREEBUFF_WEB_MODEL_ID,
      ),
    ).toBe(true)
    // The limited COERCION target is a different row on purpose (the one
    // joinable off the meter); the limited HERO is this same row.
    expect(DEFAULT_FREEBUFF_WEB_MODEL_ID).not.toBe(LIMITED_FREEBUFF_MODEL_ID)
    expect(DEFAULT_FREEBUFF_WEB_MODEL_ID).toBe(LIMITED_FREEBUFF_HERO_MODEL_ID)
    // A limited user must reach it with NO grant and NO plan. This is the real
    // invariant: the hero is the row Enter lands on, so if the only door to it
    // were an earned one, every limited user without a grant would fail their
    // first send.
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        DEFAULT_FREEBUFF_WEB_MODEL_ID,
        'limited',
      ),
    ).toBe(true)
    // It used to assert the default was NOT reward-redeemable. That was a
    // COINCIDENCE of the two lists, not a requirement, and it stopped holding
    // on 2026-09-05 when GLM 5.3 Flash — which has been the reward row since
    // 2026-08-31 — became the default again. Being on the reward list is a
    // widening: it adds a door for accounts holding a grant. It takes nothing
    // away, and it cannot, because this row is unmetered and already in the
    // ordinary limited catalog above. What WOULD be a real fault is the default
    // drawing on a pool that can run dry, so that is asserted instead.
    expect(isFreebuffPremiumModelId(DEFAULT_FREEBUFF_WEB_MODEL_ID)).toBe(false)
  })

  test('de-emphasizes nothing, and never the default', () => {
    // The list is empty as of 2026-08-12. MiniMax M3 was the last entry and
    // left when it became the ONLY muted row: the compact treatment folds the
    // tagline onto the name line, which among full-size rows reads as a broken
    // row rather than a quiet one. M3 keeps its supersededBy notice, so the
    // steering survives — see the test below.
    expect(FREEBUFF_WEB_DEEMPHASIZED_MODEL_IDS).toEqual([])
    expect(isFreebuffWebDeemphasizedModelId(MINIMAX_M3_MODEL_ID)).toBe(false)
    expect(
      isFreebuffWebDeemphasizedModelId(`${FREEBUFF_KIMI_MODEL_ID}-20260301`),
    ).toBe(false)
    expect(
      isFreebuffWebDeemphasizedModelId(DEFAULT_FREEBUFF_WEB_MODEL_ID),
    ).toBe(false)
    expect(
      isFreebuffWebDeemphasizedModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
    ).toBe(false)
    expect(isFreebuffWebDeemphasizedModelId(null)).toBe(false)
    // V4 Pro left the list on 2026-08-12 too: its 08/13 GA build wins the
    // quality half of the de-emphasis test again, and price alone is not
    // grounds.
    expect(
      isFreebuffWebDeemphasizedModelId(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID),
    ).toBe(false)
    // De-emphasis is presentation only: anything added back stays selectable.
    for (const id of FREEBUFF_WEB_DEEMPHASIZED_MODEL_IDS) {
      expect(isFreebuffWebModelId(id)).toBe(true)
      expect(isFreebuffModelAllowedForAccessTier(id, 'full')).toBe(true)
    }
  })

  test('a withdrawn model is not offered as anyone else’s switch target', () => {
    // M3 carried a "switch to V4 Flash" nudge until it was withdrawn on
    // 2026-08-20. Now the check runs the other way: the picker offers a
    // one-click switch for whatever a notice names, so naming a withdrawn model
    // would hand users a row the server refuses.
    const all = FREEBUFF_MODELS.map((model) => model.id)
    expect(all).not.toContain(MINIMAX_M3_MODEL_ID)
    for (const id of all) {
      const superseded = getFreebuffModelSupersededBy(id, all)
      if (!superseded) continue
      expect(superseded.modelId).not.toBe(MINIMAX_M3_MODEL_ID)
      expect(all).toContain(superseded.modelId)
    }
    // The recommended default is never itself marked superseded.
    expect(
      getFreebuffModelSupersededBy(DEFAULT_FREEBUFF_MODEL_ID, all),
    ).toBeUndefined()
  })

  test('does not steer users off GPT-5.6 Luna, which is now the recommendation', () => {
    // Luna pointed at Flash until 2026-08-19. It cannot any more: a model
    // cannot both BE the recommended default and carry a one-click switch away
    // from itself, and migrateSupersededFreebuffModelPreference would have
    // rewritten every saved Luna pick onto a DeepSeek row metered one a day.
    const all = FREEBUFF_MODELS.map((model) => model.id)
    expect(
      getFreebuffModelSupersededBy(FREEBUFF_GPT_5_6_LUNA_MODEL_ID, all),
    ).toBeUndefined()
    expect(
      migrateSupersededFreebuffModelPreference(
        FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
        all,
      ),
    ).toBeNull()
    expect(all).toContain(FREEBUFF_GPT_5_6_LUNA_MODEL_ID)
    expect(
      isFreebuffWebDeemphasizedModelId(FREEBUFF_GPT_5_6_LUNA_MODEL_ID),
    ).toBe(false)
  })

  test('never steers a saved pick toward a paused model', () => {
    // The picker offers a one-click switch for whatever a supersedes notice
    // names, and migrateSupersededFreebuffModelPreference moves stored picks
    // there without asking. Either pointing at a paused model would hand users
    // a row the server refuses, so no live row may name one.
    const all = FREEBUFF_MODELS.map((model) => model.id)
    for (const id of all) {
      const superseded = getFreebuffModelSupersededBy(id, all)
      if (!superseded) continue
      expect(isFreebuffPausedFreeModelId(superseded.modelId)).toBe(false)
      expect(all).toContain(superseded.modelId)
    }
  })

  test('marks both new DeepSeek builds as NEW and dates their names', () => {
    // The wire ids are undated and auto-update, so the display has to carry the
    // signal that this is a different model than the one users already judged.
    // Pro left this list when it was paused on 2026-08-18 — it is no longer in
    // FREEBUFF_MODELS at all, and its row keeps its dated name in SUPPORTED for
    // whenever it returns.
    const dated = [[FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, '07/31']] as const
    // Widened to the interface: the const-asserted tuple's union type only
    // exposes optional fields set on EVERY member, so `isNew` is unreachable
    // through it unless the find() narrows to a single literal id.
    const catalog: readonly FreebuffModelOption[] = FREEBUFF_MODELS
    for (const [id, date] of dated) {
      const model = catalog.find((candidate) => candidate.id === id)!
      expect(model.isNew).toBe(true)
      expect(model.displayName).toContain(date)
    }
    // Nothing else claims to be new, or the badge stops meaning anything. One
    // non-dated row carries it, and it is new to these surfaces rather than
    // newly re-trained — which is what the badge is for:
    //   - GLM 5.3 Flash arrived 2026-08-26. Its wire id names its build, so
    //     there is no date for the display name to disambiguate.
    //
    // Ox Alpha was the second entry here until it was withdrawn on 2026-08-27.
    // It left this list by leaving FREEBUFF_MODELS, and its row dropped `isNew`
    // in the same change — a NEW badge on a model its host withdrew is the one
    // claim about it that is actively false. See ox-alpha.test.ts.
    const undatedNew = [
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      // Gemini 3.8 Flash arrived 2026-09-03. Its wire id names its version, so
      // there is no build date for the display name to disambiguate.
      FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
      // Muse Spark 1.3 reached the CLI and Desktop on 2026-09-04. Its wire id
      // names its version, so there is no build date to disambiguate either.
      FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
    ]
    expect(
      catalog.filter((model) => model.isNew && !undatedNew.includes(model.id)),
    ).toHaveLength(dated.length)
  })

  test('migrates no saved pick anywhere, now that nothing supersedes', () => {
    const all = FREEBUFF_MODELS.map((model) => model.id)
    // The catalog carries no supersedes notice as of 2026-08-21, so this
    // migration is INERT — every stored pick is left exactly as the user set
    // it. That is the safe state and the intended one.
    //
    // Kept as a test rather than deleted because this function is the sharp
    // edge behind those notices: it rewrites a SAVED pick on every load, so the
    // day someone adds a notice back, this is where the blast radius shows up.
    for (const current of [...all, MINIMAX_M3_MODEL_ID, undefined]) {
      expect(migrateSupersededFreebuffModelPreference(current, all)).toBeNull()
    }
    // The unlimited fallback must NEVER be migrated away from: it is where
    // every surface steps a spent user down to.
    expect(
      migrateSupersededFreebuffModelPreference(FALLBACK_FREEBUFF_MODEL_ID, all),
    ).toBeNull()
    // And never onto a model this surface cannot select.
    expect(
      migrateSupersededFreebuffModelPreference(MINIMAX_M3_MODEL_ID, [
        MINIMAX_M3_MODEL_ID,
      ]),
    ).toBeNull()
  })

  test('never de-emphasizes a model we still recommend', () => {
    // Muting + sorting-last is how the Premium group steers to the
    // replacement, so anything muted must be superseded. NOT the converse:
    // MiMo 2.5 is superseded on quality but costs the same as Flash, and
    // de-emphasis is defined as a cost signal — muting it would make the list
    // say something untrue about its price.
    const all = FREEBUFF_MODELS.map((model) => model.id)
    for (const model of FREEBUFF_MODELS) {
      if (isFreebuffWebDeemphasizedModelId(model.id)) {
        expect(getFreebuffModelSupersededBy(model.id, all)).toBeDefined()
      }
    }
    // The recommended default is never muted or superseded.
    expect(isFreebuffWebDeemphasizedModelId(DEFAULT_FREEBUFF_MODEL_ID)).toBe(
      false,
    )
    expect(
      getFreebuffModelSupersededBy(DEFAULT_FREEBUFF_MODEL_ID, all),
    ).toBeUndefined()
  })

  test('never offers a switch to a model the surface cannot select', () => {
    // A picker that lacks the replacement must show no switch at all, rather
    // than a button that resolves to nothing.
    expect(
      getFreebuffModelSupersededBy(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, [
        FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
      ]),
    ).toBeUndefined()
    expect(getFreebuffModelSupersededBy(undefined, [])).toBeUndefined()
    expect(getFreebuffModelSupersededBy('vendor/unknown', [])).toBeUndefined()
  })

  test('full-access freebuff models can spawn the gemini-thinker subagent', () => {
    // Full-access models (non-limited, non-fastest) get the thinker. Kimi is
    // gone from Freebuff entirely, so it no longer qualifies.
    expect(canFreebuffModelSpawnGeminiThinker(FREEBUFF_KIMI_MODEL_ID)).toBe(
      false,
    )
    expect(
      canFreebuffModelSpawnGeminiThinker(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID),
    ).toBe(true)
    // MiMo 2.5 Pro is gone from Freebuff, so it no longer qualifies either.
    expect(
      canFreebuffModelSpawnGeminiThinker(FREEBUFF_MIMO_V25_PRO_MODEL_ID),
    ).toBe(false)
    expect(canFreebuffModelSpawnGeminiThinker(MINIMAX_M3_MODEL_ID)).toBe(true)
    expect(
      canFreebuffModelSpawnGeminiThinker(FREEBUFF_GPT_5_6_LUNA_MODEL_ID),
    ).toBe(true)

    // Limited-tier models (DeepSeek V4 Flash, MiMo 2.5) skip it.
    expect(
      canFreebuffModelSpawnGeminiThinker(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
    ).toBe(false)
    expect(canFreebuffModelSpawnGeminiThinker(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(
      false,
    )
  })

  test('does not support GLM 5.1 for freebuff sessions', () => {
    const glm = 'z-ai/glm-5.1'
    expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(glm)
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      glm,
    )
    expect(isFreebuffModelId(glm)).toBe(false)
    expect(isSupportedFreebuffModelId(glm)).toBe(false)
  })

  test('withdrawn GLM 5.2 is out of every picker and still recognised', () => {
    // Withdrawn 2026-08-31, when the reward it backed moved to GLM 5.3 Flash.
    // Out of BOTH pickers — it reached the Web one as the earned row, and there
    // is nothing left for that row to unlock.
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_GLM_V52_MODEL_ID,
    )
    expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(
      FREEBUFF_GLM_V52_MODEL_ID,
    )
    // STILL RECOGNISED, which is the difference between pausing and deleting:
    // every released CLI and Desktop holds this id, and an id the server does
    // not know can only be refused, never coerced (#1801).
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).toContain(
      FREEBUFF_GLM_V52_MODEL_ID,
    )
    expect(isFreebuffSessionModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(true)
    expect(isFreebuffPausedFreeModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(true)
    // And metered by NO pool. This row is `premium: true`, so leaving it in the
    // web catalog while dropping it from the reward pool would have let it fall
    // through to the shared daily premium pool that every full-access account
    // holds — handing out for free a model that used to cost referrals.
    expect(isFreebuffWebPremiumModelId(FREEBUFF_GLM_V52_MODEL_ID)).toBe(false)
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(FREEBUFF_GLM_V52_MODEL_ID)
  })

  test('formats the close time in the user local timezone while deployment is open', () => {
    expect(
      getFreebuffDeploymentAvailabilityLabel(new Date('2026-01-05T18:00:00Z'), {
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('until 5:00 PM')
  })

  test('formats the next open time in the user local timezone while deployment is closed', () => {
    expect(
      getFreebuffDeploymentAvailabilityLabel(new Date('2026-01-05T12:00:00Z'), {
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('opens 6:00 AM')
  })

  test('includes the weekday when the next opening is on a later local day', () => {
    expect(
      getFreebuffDeploymentAvailabilityLabel(new Date('2026-01-11T03:00:00Z'), {
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('opens Sun 6:00 AM')
  })

  test('tracks deployment hours correctly across the open and close boundaries', () => {
    expect(isFreebuffDeploymentHours(new Date('2026-01-05T13:59:00Z'))).toBe(
      false,
    )
    expect(isFreebuffDeploymentHours(new Date('2026-01-05T14:00:00Z'))).toBe(
      true,
    )
    expect(isFreebuffDeploymentHours(new Date('2026-01-06T00:59:00Z'))).toBe(
      true,
    )
    expect(isFreebuffDeploymentHours(new Date('2026-01-06T01:00:00Z'))).toBe(
      false,
    )
    expect(isFreebuffDeploymentHours(new Date('2026-01-10T20:00:00Z'))).toBe(
      true,
    )
  })
})

describe('limited-offer models (Claude Fable 5)', () => {
  test('is deliberately absent from every client picker catalog', () => {
    // The whole mechanism rests on this: no client may render Fable from its
    // own catalog, because only the server knows whether the wave still has
    // sessions. A client that has never been told about the offer must look
    // exactly like it does today.
    expect(FREEBUFF_MODELS.map((m) => m.id)).not.toContain(
      FREEBUFF_FABLE_5_MODEL_ID,
    )
    expect(isFreebuffModelId(FREEBUFF_FABLE_5_MODEL_ID)).toBe(false)
    expect(FREEBUFF_WEB_ALL_MODELS.map((m) => m.id)).not.toContain(
      FREEBUFF_FABLE_5_MODEL_ID,
    )
    expect(
      getFreebuffModelsForAccessTier('full').map((m) => m.id),
    ).not.toContain(FREEBUFF_FABLE_5_MODEL_ID)
  })

  test('is still a model the session and chat layers accept', () => {
    // Same shape as referral GLM: out of the picker catalog, in the supported
    // catalog, so admission, the chat gate and the display-name lookup all
    // resolve it.
    expect(isSupportedFreebuffModelId(FREEBUFF_FABLE_5_MODEL_ID)).toBe(true)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_FABLE_5_MODEL_ID,
        'full',
      ),
    ).toBe(true)
    expect(getFreebuffModel(FREEBUFF_FABLE_5_MODEL_ID).displayName).toBe(
      'Claude Fable 5',
    )
  })

  test('an explicit pick survives resolution instead of silently downgrading', () => {
    // resolveFreebuffModelForAccessTier runs on every explicit CLI pick. Before
    // the offer models were passed through, pressing Enter on the Fable row
    // would have started a DeepSeek session with no explanation.
    expect(
      resolveFreebuffModelForAccessTier(FREEBUFF_FABLE_5_MODEL_ID, 'full'),
    ).toBe(FREEBUFF_FABLE_5_MODEL_ID)
  })

  test('limited-region users cannot reach it', () => {
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_FABLE_5_MODEL_ID,
        'limited',
      ),
    ).toBe(false)
    expect(
      resolveFreebuffSessionModelForAccessTier(
        FREEBUFF_FABLE_5_MODEL_ID,
        'limited',
      ),
    ).toBe(LIMITED_FREEBUFF_MODEL_ID)
  })

  test('traces are collected, which is the point of running the wave at all', () => {
    expect(isFreebuffTracedModelId(FREEBUFF_FABLE_5_MODEL_ID)).toBe(true)
    const fable = SUPPORTED_FREEBUFF_MODELS.find(
      (m) => m.id === FREEBUFF_FABLE_5_MODEL_ID,
    )
    expect((fable as { warning?: string } | undefined)?.warning).toBe(
      'May use data for AI training',
    )
  })

  test('is metered by its own pool, never the shared daily premium one', () => {
    // It is marked `premium: true` for styling and to keep it out of the free
    // Standard pool, but joining FREEBUFF_PREMIUM_MODEL_IDS would put trial
    // sessions on the quota M3 and DeepSeek Pro share.
    expect(isFreebuffPremiumModelId(FREEBUFF_FABLE_5_MODEL_ID)).toBe(false)
    expect(isFreebuffWebPremiumModelId(FREEBUFF_FABLE_5_MODEL_ID)).toBe(false)
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(FREEBUFF_FABLE_5_MODEL_ID)
    expect(isFreebuffLimitedOfferModelId(FREEBUFF_FABLE_5_MODEL_ID)).toBe(true)
  })

  test('the offer predicate tolerates dated provider snapshots', () => {
    expect(
      isFreebuffLimitedOfferModelId(`${FREEBUFF_FABLE_5_MODEL_ID}-20260815`),
    ).toBe(true)
    expect(
      isFreebuffLimitedOfferModelId(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
    ).toBe(false)
    expect(isFreebuffLimitedOfferModelId(null)).toBe(false)
  })
})

describe('Meta Muse Spark 1.3 Contributor', () => {
  const ID = FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID

  test('is withdrawn: recognised, paused, and in no picker', () => {
    // Withdrawn 2026-09-07, three days after it was listed. Not busy and not
    // flapping — GONE: probed that day, all four Meta keys answered `404
    // model_not_found` on 5 of 5 attempts each, while 1.2 answered 5 of 5 on
    // the same keys in the same minute. 2,838 sessions a day were still being
    // admitted on it and every one was served on DeepSeek V4 Flash by the
    // fallback, which is a promise broken on every turn however well the
    // fallback works.
    expect(isFreebuffPausedFreeModelId(ID)).toBe(true)
    expect(FREEBUFF_MODELS.map((model) => model.id)).not.toContain(ID)
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).not.toContain(ID)
    // RECOGNISED, though: every released CLI and Desktop holds this id and
    // will keep sending it. An id the server does not know can only be
    // refused, and a refusal is the retry loop of #1801; listed in
    // SUPPORTED_FREEBUFF_MODELS it is coerced instead.
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).toContain(ID)
    expect(isSupportedFreebuffModelId(ID)).toBe(true)
  })

})

describe('Meta Muse Spark 1.2 Contributor', () => {
  const ID = FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID

  test('is the offered Muse Spark row, everywhere', () => {
    // It was retired to a draining row on 2026-09-02 in favour of 1.3, and it
    // came back on 2026-09-07 when 1.3 turned out to be gone at Meta — `404
    // model_not_found` on all four keys, 5 of 5 each, while this one answered
    // 5 of 5 on the same keys in the same minute.
    expect(FREEBUFF_WEB_MODELS.map((model) => model.id)).toContain(ID)
    expect(isFreebuffSessionModelId(ID)).toBe(true)
    expect(isFreebuffWebPremiumModelId(ID)).toBe(true)
    expect(FREEBUFF_STANDARD_MODEL_IDS).not.toContain(ID)
    // Offered by every picker now, not hidden behind the retirement list.
    expect(isFreebuffWebSelectableModelId(ID)).toBe(true)
    expect(FREEBUFF_WEB_RETIRED_PICKER_MODEL_IDS).not.toContain(ID)
    expect(FREEBUFF_MODELS.map((model) => model.id)).toContain(ID)
    expect(SUPPORTED_FREEBUFF_MODELS.map((model) => model.id)).toContain(ID)
    expect(isSupportedFreebuffModelId(ID)).toBe(true)
  })

  test('a saved 1.2 pick is no longer pushed anywhere', () => {
    // It used to point at 1.3, which was the only route from a browser that
    // remembered 1.2 to the row that replaced it. 1.3 was withdrawn on
    // 2026-09-07 (`404 model_not_found` on every key), so the arrow went with
    // it: superseding a pick onto a model that cannot answer is worse than
    // leaving it where it is.
    const webSelectable = FREEBUFF_WEB_MODELS.map((model) => model.id).filter(
      (id) => isFreebuffWebSelectableModelId(id),
    )
    expect(migrateSupersededFreebuffModelPreference(ID, webSelectable)).toBeNull()
    expect(getFreebuffModelSupersededBy(ID, webSelectable)).toBeUndefined()
    // A surface that cannot show 1.3 is not told to switch to it.
    expect(
      migrateSupersededFreebuffModelPreference(ID, [
        FREEBUFF_KIMI_K3_ECO_MODEL_ID,
      ]),
    ).toBeNull()
    // 1.3 itself is current.
    expect(
      getFreebuffModelSupersededBy(
        FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
        webSelectable,
      ),
    ).toBeUndefined()
  })
})

describe('Muse Spark rate-limit fallback', () => {
  test('reroutes only to a model the caller is already entitled to', () => {
    // THE invariant: a rate limit must not become a way to reach a model the
    // caller had not earned — the shape of the retired crof/glm-5.2 route, which
    // handed out a referral-earned model for nothing.
    //
    // Until 2026-08-24 this was spelled "the fallback is in the shared daily
    // premium pool", which was true because the fallback is Flash and Flash was
    // premium. Flash is unmetered now, and that satisfies the invariant MORE
    // strongly rather than breaking it: every full-access caller can already run
    // an unmetered row, so a reroute onto one cannot reach anything unearned.
    // What is asserted is therefore entitlement — premium pool OR unmetered —
    // and, separately, that the fallback is never a referral-EARNED row, which
    // is the direction the guard actually protects.
    expect(
      isFreebuffWebPremiumModelId(MUSE_SPARK_FALLBACK_MODEL_ID) ||
        FREEBUFF_STANDARD_MODEL_IDS.includes(MUSE_SPARK_FALLBACK_MODEL_ID),
    ).toBe(true)
    // Only the ids still OFFERED have to be metered by a pool: a withdrawn
    // row (1.3 since 2026-09-07) is served to nobody, so it belongs to no
    // pool and asserting otherwise would pin the wrong invariant.
    for (const id of FREEBUFF_MUSE_SPARK_MODEL_IDS) {
      if (isFreebuffPausedFreeModelId(id)) continue
      expect(isFreebuffWebPremiumModelId(id)).toBe(true)
    }
    // Never the earned-GLM pool — the one direction that would hand out access.
    expect(isFreebuffRewardModelId(MUSE_SPARK_FALLBACK_MODEL_ID)).toBe(false)
    expect(FREEBUFF_REWARD_MODEL_IDS).not.toContain(
      MUSE_SPARK_FALLBACK_MODEL_ID,
    )
    // And it must be a real, selectable model on every surface Muse Spark is
    // offered on — Web today, and the CLI/Desktop (whose sessions can only run
    // SUPPORTED_ ids) once the row widens — rather than a dangling id.
    expect(isFreebuffWebModelId(MUSE_SPARK_FALLBACK_MODEL_ID)).toBe(true)
    expect(isSupportedFreebuffModelId(MUSE_SPARK_FALLBACK_MODEL_ID)).toBe(true)
    expect(FREEBUFF_MUSE_SPARK_MODEL_IDS).not.toContain(
      MUSE_SPARK_FALLBACK_MODEL_ID,
    )
  })

  test('the picker promises exactly what the server does', () => {
    // The tooltip is a promise about behavior; drift between the two is how a
    // UI starts lying. Both read the same constant, and the threshold the copy
    // implies ("too long") is the one the server actually applies.
    // Read off the catalog rather than through `getFreebuffWebModel`, which
    // resolves a withdrawn id to the fallback ROW and would assert MiMo's copy
    // here. 1.3 left the pickers on 2026-09-07; its row survives so the id
    // stays recognisable, and its copy still has to describe what the server
    // does for anyone who reaches it.
    const model = SUPPORTED_FREEBUFF_MODELS.find(
      (candidate) => candidate.id === FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
    )!
    // The tagline carries all three facts on its own — rate limited, queues,
    // can answer as another model — because the CLI and Desktop pickers render
    // NO tooltip.
    expect(model.tagline).toBe('Queues, then falls back')
    expect(model.taglineTooltip).toBe(MUSE_SPARK_FALLBACK_NOTICE)
    // The copy must NAME the model the server actually reroutes to — pinning it
    // to the catalog rather than to a literal is what catches a fallback that
    // moves (as it did on 2026-08-12, Luna → V4 Pro) while its tooltip does not.
    // Matched undated: this tooltip promises a behavior rather than pointing at
    // a picker row, so it does not carry a build date the way the supersedes
    // notices do.
    expect(MUSE_SPARK_FALLBACK_NOTICE).toContain(
      getFreebuffWebModel(MUSE_SPARK_FALLBACK_MODEL_ID).displayName.replace(
        /\s+\d{2}\/\d{2}$/,
        '',
      ),
    )
    // New to the browser pickers as of 2026-09-02.
    expect(model.isNew).toBe(true)
    // A wait worth explaining, not one worth hiding — and the same number the
    // provider uses for its silent window, so the two cannot disagree about
    // what "too long" means.
    expect(MUSE_SPARK_FALLBACK_AFTER_MS).toBe(15_000)
  })
})

describe('the unavailability window matches the reason for the closure', () => {
  /**
   * Both refusal sites gate on isFreebuffSessionModelAvailable, which covers
   * `deployment_hours` AND `off_peak_only`, and both hardcoded the
   * deployment-hours label. So V4 Flash -- then closed for DeepSeek's peak
   * pricing -- told users it was "available 9am ET-5pm PT every day": a
   * different window, for a different reason, in two timezones at once.
   *
   * ## Why most of this block is gone
   *
   * Every assertion here needed a model that was actually peak-closed, and
   * Flash was the only one. Its closure was removed on 2026-08-28 (the traffic
   * it displaced onto Luna cost more than the peak card it avoided), so NO
   * model carries `off_peak_only` and the branch these tests covered is
   * unreachable from the catalog.
   *
   * Deleted rather than kept alive against an invented model. A fixture-only
   * model would have pinned the formatter's output while proving nothing about
   * whether any real row can reach it -- and the original bug was precisely a
   * real row reaching the WRONG branch, which no synthetic case would have
   * caught.
   *
   * What survives is the pair that still has live subjects: the fallback for an
   * unrecognised closure, and the guarantee that a reopened row advertises
   * nothing. If `off_peak_only` is ever used again, restore the deleted
   * assertions with it -- they are in git history at this commit, and the
   * formatter they covered is untouched.
   */
  const peak = new Date('2026-08-25T08:00:00Z')

  test('no model is peak-closed, so no row can quote a peak window', () => {
    // The invariant that replaces the deleted block. If a model is ever given
    // `off_peak_only` again this fails, which is the prompt to restore the
    // formatter assertions rather than discover them missing later.
    expect(
      freebuffModelUnavailableWindow(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, peak),
    ).not.toContain('again at')
  })

  /**
   * No model carries `deployment_hours` today -- the catalog is `always` only
   * -- so the staffing label is reachable from the LIMITED-OFFER branch and not
   * from this one. The resolver still returns it as the default rather than
   * inventing a window for a closure it does not recognise, which is why this
   * asserts the DEFAULT rather than a model that would have to be invented to
   * test it.
   */
  test('an unrecognised closure falls back to the staffing label, not a guess', () => {
    expect(freebuffModelUnavailableWindow('mimo/mimo-v2.5', peak)).toBe(
      FREEBUFF_DEPLOYMENT_HOURS_LABEL,
    )
  })
})
