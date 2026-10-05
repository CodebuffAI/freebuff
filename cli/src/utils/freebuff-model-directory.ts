/**
 * Every question the CLI asks about a Freebuff model, behind one seam.
 *
 * Two implementations, and exactly one is live at a time:
 *
 * - `compiledFreebuffModelDirectory`: the compiled catalog and plain model
 *   ids, delegating to the same `freebuff-models` functions the CLI called
 *   before the server catalog existed. Fallback mode (an older server, the
 *   network) is this object, so it must stay a pure pass-through.
 * - `catalogFreebuffModelDirectory(catalog)`: the server catalog
 *   (docs/freebuff-model-catalog.md). Every "model id" it hands out or accepts
 *   is a catalog KEY, because that is what a catalog-aware session response
 *   carries wherever it used to carry a model id. A legacy id still resolves,
 *   through the row's `legacyDigests`, so a pick or a relaunch record written
 *   before the catalog lands on its row.
 *
 * Keys and model ids never collide (keys carry no `/` and are opaque), which
 * is what lets a store hold either kind in one field across a mode switch.
 *
 * Nothing here selects a model on the wire. The HANDLE does that, and it is
 * looked up at send time (`freebuffCatalogHandleFor`), never stored.
 */
import {
  FALLBACK_FREEBUFF_MODEL_ID,
  FREEBUFF_DEFAULT_CONTEXT_WINDOW,
  FREEBUFF_LIMITED_OFFER_MODEL_IDS,
  FREEBUFF_MODEL_CONTEXT_WINDOWS,
  FREEBUFF_REWARD_MODEL_ID,
  freebuffWithdrawnModelMessage,
  getFreebuffModel,
  getFreebuffModelDefaultEffort,
  getFreebuffModelEfforts,
  getFreebuffModelSupersededBy,
  getFreebuffModelUnavailableLabel,
  getFreebuffModelsForAccessTier,
  getRecommendedFreebuffModelId,
  isFreebuffLimitedOfferModelId,
  isFreebuffModelAvailable,
  isFreebuffModelId,
  isFreebuffPremiumModelId,
  isFreebuffRewardModelId,
  isSupportedFreebuffModelId,
  resolveFreebuffModelForAccessTier,
  resolveSupportedFreebuffModel,
  SUPPORTED_FREEBUFF_MODELS,
} from '@codebuff/common/constants/freebuff-models'
import {
  findFreebuffCatalogRowForLegacyId,
  freebuffLegacyModelDigest,
  listableFreebuffCatalogRows,
} from '@codebuff/common/types/freebuff-model-catalog'
import { freebuffPlanRequired } from '@codebuff/common/util/freebuff-model-selection'

import type {
  FreebuffAccessTier,
  FreebuffModelOption,
} from '@codebuff/common/constants/freebuff-models'
import type { ReasoningEffort } from '@codebuff/common/constants/reasoning-effort'
import type {
  FreebuffCatalogBadge,
  FreebuffCatalogRow,
  FreebuffModelCatalog,
} from '@codebuff/common/types/freebuff-model-catalog'
import type { FreebuffFreebucksInfo } from '@codebuff/common/types/freebuff-session'

export interface FreebuffModelDirectory {
  /** The catalog this directory answers from; null in fallback mode. */
  readonly catalog: FreebuffModelCatalog | null
  /** The picker's rows for this viewer, in list order (before any price sort). */
  pickerModels(
    accessTier: FreebuffAccessTier | null | undefined,
    hasPaidSubscription: boolean,
  ): readonly FreebuffModelOption[]
  /** The row for an id (or key); an unknown one gets a best-effort row, as
   *  `getFreebuffModel` does, so display code never has to null-check. */
  get(id: string): FreebuffModelOption
  /** A model this client can name at all (`isSupportedFreebuffModelId`). */
  isKnown(id: string | null | undefined): boolean
  /** A model the picker offers (`isFreebuffModelId`). */
  isPickerModel(id: string | null | undefined): boolean
  /** The catalog row behind an id or key; always undefined in fallback mode. */
  row(id: string | null | undefined): FreebuffCatalogRow | undefined
  efforts(id: string | null | undefined): readonly ReasoningEffort[] | null
  defaultEffort(id: string | null | undefined): ReasoningEffort | null
  isAvailable(id: string, now: Date): boolean
  unavailableLabel(id: string, now: Date): string | undefined
  isPremium(id: string | null | undefined): boolean
  isReward(id: string | null | undefined): boolean
  isLimitedOffer(id: string | null | undefined): boolean
  /** What the referral banner's earned-session action starts. */
  readonly rewardModelId: string
  /** The always-joinable row a pick steps down to. */
  readonly fallbackModelId: string
  recommendedModelId(
    accessTier: FreebuffAccessTier | null | undefined,
    options?: { premiumExhausted?: boolean },
  ): string
  supersededBy(
    id: string,
    visibleIds: readonly string[],
  ): FreebuffModelOption['supersededBy'] | undefined
  /** Whether the picker draws this row locked (paid plan required). */
  planRequired(
    id: string,
    hasPaidSubscription: boolean,
    freebucks: FreebuffFreebucksInfo | null | undefined,
    /** Fallback mode only: the resolved access tier, read when the server
     *  sent no verdict (see `freebuffPlanRequired`). */
    accessTier?: FreebuffAccessTier | null,
  ): boolean
  /** The pill set a row carries. Fallback mode draws its compiled flags
   *  itself and gets none here. */
  badges(id: string): readonly FreebuffCatalogBadge[]
  contextWindow(id: string | null | undefined): number
  /** What an arbitrary stored value selects (`resolveSupportedFreebuffModel`). */
  resolveSelection(id: string | null | undefined): string
  /** What an explicit pick sends to admission for this viewer. */
  resolveForAccessTier(
    id: string,
    accessTier: FreebuffAccessTier | null | undefined,
    hasPaidSubscription: boolean,
  ): string
  withdrawnMessage(id: string): string
  /** Where a locked row's press goes; undefined means the CLI's own page. */
  readonly plansUrl: string | undefined
}

export const compiledFreebuffModelDirectory: FreebuffModelDirectory = {
  catalog: null,
  pickerModels: (accessTier, hasPaidSubscription) =>
    getFreebuffModelsForAccessTier(accessTier, hasPaidSubscription),
  get: (id) => getFreebuffModel(id),
  isKnown: (id) => isSupportedFreebuffModelId(id),
  isPickerModel: (id) => isFreebuffModelId(id),
  row: () => undefined,
  efforts: (id) => getFreebuffModelEfforts(id),
  defaultEffort: (id) => getFreebuffModelDefaultEffort(id),
  isAvailable: (id, now) => isFreebuffModelAvailable(id, now),
  unavailableLabel: (id, now) => getFreebuffModelUnavailableLabel(id, now),
  isPremium: (id) => isFreebuffPremiumModelId(id),
  isReward: (id) => isFreebuffRewardModelId(id),
  isLimitedOffer: (id) => isFreebuffLimitedOfferModelId(id),
  rewardModelId: FREEBUFF_REWARD_MODEL_ID,
  fallbackModelId: FALLBACK_FREEBUFF_MODEL_ID,
  recommendedModelId: (accessTier, options) =>
    getRecommendedFreebuffModelId(accessTier, options),
  supersededBy: (id, visibleIds) => getFreebuffModelSupersededBy(id, visibleIds),
  planRequired: (id, hasPaidSubscription, freebucks, accessTier) =>
    freebuffPlanRequired(id, hasPaidSubscription, freebucks, accessTier),
  badges: () => [],
  contextWindow: (id) =>
    (id ? FREEBUFF_MODEL_CONTEXT_WINDOWS[id] : undefined) ??
    FREEBUFF_DEFAULT_CONTEXT_WINDOW,
  resolveSelection: (id) => resolveSupportedFreebuffModel(id),
  resolveForAccessTier: (id, accessTier, hasPaidSubscription) =>
    resolveFreebuffModelForAccessTier(id, accessTier, hasPaidSubscription),
  withdrawnMessage: (id) => freebuffWithdrawnModelMessage(id),
  plansUrl: undefined,
}

/**
 * A catalog row in the shape the picker already draws. `id` is the KEY.
 *
 * The compiled presentation flags (`isNew`, `experimental`, `promotional`,
 * ...) stay unset on purpose: a catalog row says all of that through its
 * `badges`, which the picker draws generically, so a new kind of pill needs
 * no client release. Availability is always `always`: a row the server does
 * not want joined is one it does not list, or lists `locked`.
 */
const COMPILED_ID_BY_DIGEST = new Map(
  SUPPORTED_FREEBUFF_MODELS.map((model) => [
    freebuffLegacyModelDigest(model.id),
    model.id,
  ]),
)

/** The compiled model id a catalog row replaces, by its legacy digests;
 *  undefined for a catalog-only row. */
export function compiledFreebuffModelIdOfRow(
  row: FreebuffCatalogRow,
): string | undefined {
  for (const digest of row.legacyDigests ?? []) {
    const id = COMPILED_ID_BY_DIGEST.get(digest)
    if (id) return id
  }
  return undefined
}

export function freebuffCatalogRowModelOption(
  row: FreebuffCatalogRow,
): FreebuffModelOption {
  return {
    id: row.key,
    displayName: row.displayName,
    tagline: row.tagline,
    ...(row.taglineTooltip ? { taglineTooltip: row.taglineTooltip } : {}),
    availability: 'always',
    ...(row.warning ? { warning: row.warning } : {}),
    dataUse: row.dataUse,
    premium: row.premium,
    multimodal: row.multimodal,
    // Display only (the server owns the wire effort), so the option's
    // narrower provider-scale union is widened rather than a rung dropped.
    ...(row.reasoningEffort || row.defaultEffort
      ? {
          reasoningEffort: (row.reasoningEffort ??
            row.defaultEffort) as FreebuffModelOption['reasoningEffort'],
        }
      : {}),
    ...(row.efforts?.length ? { efforts: row.efforts } : {}),
    ...(row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
  }
}

export function catalogFreebuffModelDirectory(
  catalog: FreebuffModelCatalog,
  now: number = Date.now(),
): FreebuffModelDirectory {
  // A row scheduled to open later does not exist for this client until it
  // opens: it
  // is never listed, selected, mapped onto, or sent. Every lookup below reads
  // these rows only, so no path through the directory can reach one.
  const listable = { rows: listableFreebuffCatalogRows(catalog, now) }
  const rowsByKey = new Map(listable.rows.map((row) => [row.key, row]))
  const options = new Map(
    listable.rows.map((row) => [row.key, freebuffCatalogRowModelOption(row)]),
  )
  /** The row an id or key names: a key directly, a legacy id by digest. */
  const rowFor = (id: string | null | undefined) =>
    id
      ? (rowsByKey.get(id) ?? findFreebuffCatalogRowForLegacyId(listable, id))
      : undefined
  const keyForLegacy = (legacyId: string) =>
    findFreebuffCatalogRowForLegacyId(listable, legacyId)?.key
  const recommendedKey = (() => {
    if (catalog.recommendedKey && rowsByKey.has(catalog.recommendedKey))
      return catalog.recommendedKey
    return (
      listable.rows.find((row) => row.access === 'open')?.key ??
      listable.rows[0]?.key ??
      FALLBACK_FREEBUFF_MODEL_ID
    )
  })()
  const fallbackKey =
    catalog.fallbackKey && rowsByKey.has(catalog.fallbackKey)
      ? catalog.fallbackKey
      : recommendedKey
  const rewardKey = keyForLegacy(FREEBUFF_REWARD_MODEL_ID)
  const limitedOfferKeys = new Set(
    FREEBUFF_LIMITED_OFFER_MODEL_IDS.flatMap((id) => {
      const key = keyForLegacy(id)
      return key ? [key] : []
    }),
  )
  const displayNameOf = (id: string) =>
    rowFor(id)?.displayName ?? getFreebuffModel(id).displayName

  return {
    catalog,
    pickerModels: () => [...options.values()],
    get: (id) => {
      const row = rowFor(id)
      // An id no row names (a session admitted before the catalog arrived)
      // still gets its compiled name rather than a blank.
      return row ? options.get(row.key)! : getFreebuffModel(id)
    },
    isKnown: (id) => rowFor(id) !== undefined,
    isPickerModel: (id) => rowFor(id) !== undefined,
    row: rowFor,
    efforts: (id) => {
      const efforts = rowFor(id)?.efforts
      return efforts && efforts.length > 0 ? efforts : null
    },
    defaultEffort: (id) => {
      const row = rowFor(id)
      if (!row?.efforts?.length) return null
      // Same rule as the compiled ladder: no stated default means the top.
      return row.defaultEffort ?? row.efforts[row.efforts.length - 1]!
    },
    isAvailable: (id) => rowFor(id) !== undefined,
    unavailableLabel: () => undefined,
    isPremium: (id) => rowFor(id)?.premium ?? false,
    isReward: (id) =>
      rewardKey !== undefined && rowFor(id)?.key === rewardKey,
    isLimitedOffer: (id) => {
      const key = rowFor(id)?.key
      return key !== undefined && limitedOfferKeys.has(key)
    },
    rewardModelId: rewardKey ?? FREEBUFF_REWARD_MODEL_ID,
    fallbackModelId: fallbackKey,
    // The server already resolved the recommendation for THIS viewer; a
    // spent pool is handled by the picker stepping down to a joinable row.
    recommendedModelId: () => recommendedKey,
    // Supersession is a compiled concept. The catalog says it with a badge or
    // a warning, which the row already carries.
    supersededBy: () => undefined,
    // The server's per-viewer verdict, already folded into `access`.
    planRequired: (id) => rowFor(id)?.access === 'locked',
    badges: (id) => rowFor(id)?.badges ?? [],
    contextWindow: (id) =>
      rowFor(id)?.contextWindow ?? FREEBUFF_DEFAULT_CONTEXT_WINDOW,
    resolveSelection: (id) => rowFor(id)?.key ?? recommendedKey,
    // The rows are already this viewer's; nothing else is admissible.
    resolveForAccessTier: (id) => rowFor(id)?.key ?? recommendedKey,
    withdrawnMessage: (id) =>
      `${displayNameOf(id)} is no longer available in Freebuff. We recommend using ${displayNameOf(recommendedKey)} instead.`,
    plansUrl: catalog.plansUrl,
  }
}

/** The handle a key is sent as, from the catalog held right now. A row that
 *  has not opened yet has no handle this client will send. */
export function freebuffCatalogHandleFor(
  catalog: FreebuffModelCatalog | null,
  key: string,
  now: number = Date.now(),
): string | undefined {
  if (!catalog) return undefined
  return listableFreebuffCatalogRows(catalog, now).find((row) => row.key === key)
    ?.handle
}
