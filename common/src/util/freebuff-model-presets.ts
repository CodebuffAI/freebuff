import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
  freebuffModelIdMatches,
  type FreebuffAccessTier,
} from '../constants/freebuff-models'
import type { ReasoningEffort } from '../constants/reasoning-effort'
import type { FreebuffFreebucksInfo } from '../types/freebuff-session'

export interface FreebuffModelPreset {
  id: 'efficient' | 'balanced' | 'powerful'
  label: string
  modelId: string
  reasoningEffort: ReasoningEffort | null
  /** A thinking level of the one listed model (`thinkingLevelPresets`). */
  thinkingLevel?: true
}

/** IDs are the client's selectable IDs: catalog keys stay opaque. */
export interface FreebuffPresetModel {
  id: string
  compiledId?: string
  displayName: string
  price?: number
  available?: boolean
  efforts?: readonly ReasoningEffort[]
  defaultEffort?: ReasoningEffort
}

/**
 * MiMo v2.6 Flash Slow's catalog key (`defaultCatalogKey('fbc/mimo-slow')`):
 * a catalog-only row, so it has no public id and is found by its opaque key,
 * as in freebuff-picker-sections.ts. Pinned to its id by the web catalog tests.
 */
export const FREEBUFF_MIMO_SLOW_CATALOG_KEY = 'm-61c26317cc'

/** Recommendations only. Catalog visibility, purchase consent and admission
 * remain owned by the existing model-selection path.
 *
 * Full access (product, 2026-10-16): DeepSeek V4.1 Flash at low effort (GPT-6
 * Luna until 2026-10-30, when it left the first view of the picker), at high
 * effort (the Luminal lane), and at max effort (since 2026-10-17; MiMo 2.6 Pro
 * before).
 * The first stop is no longer a cheap model, so it reads Fast rather than
 * Efficient; limited ladders keep Efficient.
 *
 * A limited-access subscriber, or one holding 100 Freebucks, gets MiMo v2.6 Flash Slow
 * (MiMo where it is not listed, as on Web), Flash at high effort and Muse Spark
 * 1.3. Muse Spark is a paid-only row, so without a plan that stop is the
 * ordinary paywall, never an entitlement. Any other limited account gets the
 * free ladder below, built on the server's recommendation for it
 * (`recommendedModelId`, MiMo v2.6 Flash Slow since 2026-10-14) where the catalog sends
 * one, else MiMo.
 *
 * A catalog that lists one model with a reasoning ladder gets that model's
 * thinking levels instead, at any tier. */
export function getFreebuffModelPresets({
  accessTier,
  isSubscriber = false,
  balance = 0,
  pricing,
  models,
  recommendedModelId,
}: {
  accessTier?: FreebuffAccessTier | null
  isSubscriber?: boolean
  balance?: number
  pricing?: Pick<FreebuffFreebucksInfo, 'prices'> | null
  models?: readonly FreebuffPresetModel[]
  /** The catalog's recommended row for this viewer (a catalog key). With
   *  `models`, used only while it is listed and available. */
  recommendedModelId?: string | null
} = {}): readonly FreebuffModelPreset[] {
  const only = models?.length === 1 ? models[0] : undefined
  if (only?.efforts && only.efforts.length > 1)
    return thinkingLevelPresets(only, only.efforts)

  const limited = accessTier === 'limited'
  const premium = isSubscriber || balance >= 100
  const rowFor = (id: string) =>
    models?.find((row) => freebuffModelIdMatches(row.compiledId ?? row.id, id))
  const preset = (
    id: FreebuffModelPreset['id'],
    label: string,
    modelId: string,
    reasoningEffort: ReasoningEffort | null,
  ): FreebuffModelPreset => {
    // If a catalog withdraws a recommendation, keep the control usable with
    // the closest listed fallback. A listed but locked row still goes through
    // the ordinary paywall; recommendations never grant model access.
    const row =
      rowFor(modelId) ??
      (modelId !== FREEBUFF_MIMO_V25_MODEL_ID
        ? rowFor(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
        : undefined) ??
      rowFor(FREEBUFF_MIMO_V25_MODEL_ID)
    const resolvedId = row?.compiledId ?? row?.id ?? modelId
    return {
      id,
      label,
      modelId: row?.id ?? modelId,
      reasoningEffort: freebuffModelIdMatches(resolvedId, modelId)
        ? reasoningEffort
        : freebuffModelIdMatches(resolvedId, FREEBUFF_MIMO_V25_MODEL_ID)
          ? null
          : 'high',
    }
  }

  if (!limited)
    return [
      preset('efficient', 'Fast', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'low'),
      preset('balanced', 'Balanced', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'high'),
      preset('powerful', 'Powerful', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'max'),
    ]

  if (premium) {
    // MiMo v2.6 Flash Slow leads where it is listed and open (product, 2026-10-14).
    const slow = models?.find(
      (row) =>
        row.id === FREEBUFF_MIMO_SLOW_CATALOG_KEY && row.available !== false,
    )
    return [
      slow
        ? {
            id: 'efficient' as const,
            label: 'Efficient',
            modelId: FREEBUFF_MIMO_SLOW_CATALOG_KEY,
            reasoningEffort: null,
          }
        : preset('efficient', 'Efficient', FREEBUFF_MIMO_V25_MODEL_ID, null),
      preset('balanced', 'Balanced', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'high'),
      preset(
        'powerful',
        'Powerful',
        FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
        FREEBUFF_MUSE_SPARK_REASONING_EFFORT,
      ),
    ]
  }

  // Only a live, open, explicitly zero-priced row qualifies. Display names
  // identify catalog-only candidates without publishing their upstream IDs.
  const free = [/^glyph\b/i, /^solar mini\b/i, /^solar pro\b/i]
    .map((name) =>
      models?.find(
        (row) =>
          row.available !== false &&
          name.test(row.displayName) &&
          (row.price ?? pricing?.prices[row.id]) === 0,
      ),
    )
    .find((row) => row !== undefined)
  // The base of this ladder: the server's pick for the viewer when it is one
  // they can start, else MiMo.
  const recommended: Pick<FreebuffPresetModel, 'id' | 'defaultEffort'> | undefined = !recommendedModelId
    ? undefined
    : models
      ? models.find(
          (row) => row.id === recommendedModelId && row.available !== false,
        )
      : { id: recommendedModelId }
  const base = (
    id: FreebuffModelPreset['id'],
    label: string,
  ): FreebuffModelPreset =>
    recommended
      ? {
          id,
          label,
          modelId: recommended.id,
          reasoningEffort: recommended.defaultEffort ?? null,
        }
      : preset(id, label, FREEBUFF_MIMO_V25_MODEL_ID, null)
  return [
    free
      ? {
          id: 'efficient',
          label: 'Efficient',
          modelId: free.id,
          reasoningEffort: free.defaultEffort ?? free.efforts?.[0] ?? null,
        }
      : base('efficient', 'Efficient'),
    base('balanced', 'Balanced'),
    preset('powerful', 'Powerful', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'high'),
  ]
}

/**
 * One model's thinking levels as the stops: its lowest rung (Fast), its
 * default (Default, the Balanced stop new chats start on) and its highest
 * (Max). "Fast" rather than "Low": a quick answer is a reason to choose it,
 * where "low" sounds like less. DeepSeek V4.1 Flash's ladder is exactly
 * low / high / max.
 */
const THINKING_LEVEL_LABELS: Record<FreebuffModelPreset['id'], string> = {
  efficient: 'Fast',
  balanced: 'Default',
  powerful: 'Max',
}

function thinkingLevelPresets(
  row: FreebuffPresetModel,
  efforts: readonly ReasoningEffort[],
): readonly FreebuffModelPreset[] {
  const balanced =
    row.defaultEffort && efforts.includes(row.defaultEffort)
      ? row.defaultEffort
      : efforts[efforts.length - 1]!
  const stops = [
    ...new Set([efforts[0]!, balanced, efforts[efforts.length - 1]!]),
  ]
  return stops.map((effort): FreebuffModelPreset => {
    const id =
      effort === balanced
        ? 'balanced'
        : efforts.indexOf(effort) < efforts.indexOf(balanced)
          ? 'efficient'
          : 'powerful'
    return {
      id,
      label: THINKING_LEVEL_LABELS[id],
      modelId: row.id,
      reasoningEffort: effort,
      thinkingLevel: true,
    }
  })
}

/** A manual effort override is custom too: never hide it behind a category. */
export function matchingFreebuffModelPreset(
  presets: readonly FreebuffModelPreset[],
  modelId: string | null | undefined,
  effort: ReasoningEffort | null | undefined,
): FreebuffModelPreset | undefined {
  // If no free promotion is available, the base row fills both lower stops. Prefer
  // Balanced, the default, instead of making a new chat appear downgraded.
  const matches = (preset: FreebuffModelPreset) =>
    !!modelId &&
    freebuffModelIdMatches(modelId, preset.modelId) &&
    (effort ?? null) === preset.reasoningEffort
  return (
    presets.find((preset) => preset.id === 'balanced' && matches(preset)) ??
    presets.find(matches)
  )
}
