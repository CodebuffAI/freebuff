import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS,
  FREEBUFF_WEB_LIMITED_MODEL_IDS,
  LIMITED_FREEBUFF_MODEL_ID,
  LIMITED_FREEBUFF_MODEL_IDS,
  getFreebuffModelsForAccessTier,
  isFreebuffSessionModelAllowedForAccessTier,
  isFreebuffWebModelAllowedForLimitedTier,
  isFreebuffRewardModelId,
  isFreebuffWebModelId,
  resolveFreebuffSessionModelForAccessTier,
  resolveFreebuffWebModelForLimitedTier,
} from '../freebuff-models'
import {
  FREEBUFF_SUBSCRIPTION_MODEL_IDS,
  FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS,
} from '../freebuff-subscriptions'

/**
 * A limited-region account is held to a catalog that contains none of the
 * models a plan meters — EXCEPT the earned reward row. Before this, a
 * subscriber there paid and received nothing at all: every plan model failed
 * admission with session_model_mismatch.
 *
 * THE REWARD ROW IS THE ONE CARVE-OUT, and it has to be. Since 2026-08-31 the
 * reward model is GLM 5.3 Flash, which is also a plan model, and a limited-tier
 * user may reach it against a bounty grant with no plan at all
 * (isRewardModelRedeemableAtLimitedTier). The allowlist deliberately says yes
 * there so an unfunded caller lands on `rate_limited` (limit 0) rather than
 * `session_model_mismatch` — the POOL is the gate, not the catalog. The
 * carve-out is therefore asserted here rather than worked around, because if it
 * ever widened past this one id the plan would stop being worth paying for.
 *
 * A plan model can also be an ordinary free row of the limited catalog (Flash
 * is), so the assertions distinguish "free in this tier" from "plan-only".
 */
/**
 * Free at limited access ON WEB, which since 2026-09-04 is a WIDER set than
 * the CLI/Desktop limited catalog (`LIMITED_FREEBUFF_MODEL_IDS`): the Web
 * catalog is every free row except Luna. Read from the web list rather than
 * the CLI one because that is the list session admission actually consults.
 */
const freeAtLimitedTier = (model: string): boolean =>
  (FREEBUFF_WEB_LIMITED_MODEL_IDS as readonly string[]).includes(model)

describe('paid plans at limited access', () => {
  test('the limited catalog still excludes every plan-only model when unpaid', () => {
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      // The free limited CATALOG excludes every plan model that the tier does
      // not already hand out, reward row included.
      expect(FREEBUFF_WEB_LIMITED_MODEL_IDS.includes(model)).toBe(
        freeAtLimitedTier(model),
      )
      expect(isFreebuffSessionModelAllowedForAccessTier(model, 'limited')).toBe(
        // The reward row is NAMEABLE without a plan so a bounty grant can fund
        // it; its pool reports 0 for everyone else. See the docblock above.
        isFreebuffRewardModelId(model) || freeAtLimitedTier(model),
      )
    }
    // Widening the overlap is a product decision that has to come here, and
    // on 2026-09-04 it was made: GLM 5.3 Flash joined the free Web limited
    // catalog. Luna is what keeps a plan worth paying for at this tier, so it
    // must NOT appear in this list.
    expect(FREEBUFF_SUBSCRIPTION_MODEL_IDS.filter(freeAtLimitedTier)).toEqual([
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4-flash',
    ])
    expect(FREEBUFF_SUBSCRIPTION_MODEL_IDS.filter(freeAtLimitedTier)).not.toContain(
      'openai/gpt-5.6-luna',
    )
  })

  test('a paid plan unlocks exactly the models it meters', () => {
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      expect(
        isFreebuffSessionModelAllowedForAccessTier(model, 'limited', true),
      ).toBe(true)
    }
  })

  test('paying does not unlock anything the plan does not cover', () => {
    // The god-only bait ids are the case that matters: a plan must never be a
    // way into a model nobody sells.
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        'openai/gpt-5.6-luna-es',
        'limited',
        true,
      ),
    ).toBe(false)
  })

  test('full access is unaffected by the flag either way', () => {
    for (const paid of [false, true]) {
      expect(
        isFreebuffSessionModelAllowedForAccessTier(
          FREEBUFF_SUBSCRIPTION_MODEL_IDS[0]!,
          'full',
          paid,
        ),
      ).toBe(true)
    }
  })

  test('Luna is free at full access and plan-locked only at limited access', () => {
    expect(FREEBUFF_SUBSCRIPTION_PRO_MODEL_IDS).not.toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    expect(FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS).toContain(
      FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
    )
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
        'full',
      ),
    ).toBe(true)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
        'limited',
      ),
    ).toBe(false)
    expect(
      isFreebuffSessionModelAllowedForAccessTier(
        FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
        'limited',
        true,
      ),
    ).toBe(true)
  })

  test('every plan model is admissible at limited access with a plan', () => {
    // The two lists CANNOT drift any more: both the plan set and the predicate
    // read FREEBUFF_PLAN_METERED_CATALOG_MODEL_IDS, since 2026-09-04. This
    // survives the de-duplication because it asserts something the shared
    // constant does not — that every id on it actually clears the limited-tier
    // gate for a subscriber, which is a property of the gate rather than of
    // the list. It failed on exactly that when Gemini 3.8 Flash was added to
    // the plan and not to the then-duplicated predicate.
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      expect(
        isFreebuffSessionModelAllowedForAccessTier(model, 'limited', true),
      ).toBe(true)
    }
    // Pinned so that adding a row to a plan is a decision somebody states
    // here, not a diff that passes quietly.
    expect(FREEBUFF_SUBSCRIPTION_MODEL_IDS).toHaveLength(5)
  })

  test('a limited-tier plan-only row is never free at limited access', () => {
    // This set is intentionally broader than the global Pro set: Luna is free
    // at full access and still plan-locked here. Assert over the actual tier
    // boundary so changing either policy cannot silently widen this catalog.
    for (const model of FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS) {
      expect(freeAtLimitedTier(model)).toBe(false)
      expect(isFreebuffSessionModelAllowedForAccessTier(model, 'limited')).toBe(
        false,
      )
      // ...but a plan still reaches it, or the paywall sells a shut door.
      expect(
        isFreebuffSessionModelAllowedForAccessTier(model, 'limited', true),
      ).toBe(true)
    }
    expect(FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS.length).toBeGreaterThan(0)
  })

  test('every plan model resolves in the Web catalog', () => {
    // The plans page renders the plan lineup via getFreebuffWebModel, which
    // FALLS BACK to MiMo 2.5 for an id the Web catalog lacks — it would
    // advertise the one model its own copy says a plan escapes, and nothing
    // would error. The page filters such ids out; this is what makes the
    // drift loud instead of silently shrinking that panel.
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      expect(isFreebuffWebModelId(model, { includeGodOnly: true })).toBe(true)
    }
  })
})

/**
 * Allowing a model and RESOLVING it are separate questions, and the second one
 * is what the first shipped without.
 *
 * Admission resolves the pick before it binds a session row, so with the flag
 * missing here a limited subscriber's Luna pick was rewritten to MiMo, the row
 * was bound to MiMo, and the chat gate's own substitution then ran the turn as
 * MiMo — against a request that the widened `isFreebuff...AllowedForAccessTier`
 * had just approved. Nothing refused, nothing logged, and the user watched the
 * model they had paid for answer as the free one.
 */
describe('a plan model survives resolution, not just the allowlist', () => {
  test('unpaid limited access still coerces every plan-only model to MiMo', () => {
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      expect(resolveFreebuffSessionModelForAccessTier(model, 'limited')).toBe(
        // The reward row survives coercion without a plan, so a grant-funded
        // session is launchable from any region; the pool decides whether it
        // is joinable. A row the tier hands out for free survives too, being
        // simply allowed. Everything else is rewritten to the free default.
        isFreebuffRewardModelId(model) || freeAtLimitedTier(model)
          ? model
          : LIMITED_FREEBUFF_MODEL_ID,
      )
    }
  })

  test('a paid plan keeps the pick intact', () => {
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      expect(
        resolveFreebuffSessionModelForAccessTier(model, 'limited', {
          hasPaidSubscription: true,
        }),
      ).toBe(model)
    }
  })

  test('the Web picker offers and keeps plan rows for a subscriber', () => {
    for (const model of FREEBUFF_SUBSCRIPTION_MODEL_IDS) {
      // The picker's own allowlist — the one whose coercion effect reset a
      // subscriber's selection back to MiMo on the next render.
      expect(isFreebuffWebModelAllowedForLimitedTier(model)).toBe(
        isFreebuffRewardModelId(model) || freeAtLimitedTier(model),
      )
      expect(isFreebuffWebModelAllowedForLimitedTier(model, true)).toBe(true)
      expect(resolveFreebuffWebModelForLimitedTier(model, true)).toBe(model)
      expect(resolveFreebuffWebModelForLimitedTier(model)).toBe(
        isFreebuffRewardModelId(model) || freeAtLimitedTier(model)
          ? model
          : LIMITED_FREEBUFF_MODEL_ID,
      )
    }
  })

  test('the CLI/Desktop tier catalog gains the plan rows and keeps the free ones', () => {
    const free = getFreebuffModelsForAccessTier('limited').map((m) => m.id)
    const paid = getFreebuffModelsForAccessTier('limited', true).map(
      (m) => m.id,
    )
    // The free limited rows are untouched: a plan TOPS UP the free pools, so
    // what the account can still run for free has to stay on offer.
    for (const id of free) expect(paid).toContain(id)
    expect(paid.slice(0, free.length)).toEqual(free)
    // And it gained at least one row it could not pick before.
    expect(paid.length).toBeGreaterThan(free.length)
    for (const id of paid) {
      expect(
        isFreebuffSessionModelAllowedForAccessTier(id, 'limited', true),
      ).toBe(true)
    }
  })

  test('full access is untouched by the widened catalog', () => {
    expect(
      getFreebuffModelsForAccessTier('full', true).map((m) => m.id),
    ).toEqual(getFreebuffModelsForAccessTier('full').map((m) => m.id))
  })
})
