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

/** Recommendations only. Catalog visibility, purchase consent and admission
 * remain owned by the existing model-selection path.
 *
 * Every account with premium access gets the same three stops, whatever its
 * country: MiMo, DeepSeek V4 Flash at high effort (the Luminal lane), and Muse
 * Spark 1.3. Muse Spark is a paid-only row, so for a free account that stop is
 * the ordinary paywall, never an entitlement. A limited-region account that is
 * neither a subscriber nor holds 100 Freebucks gets the free ladder below. */
export function getFreebuffModelPresets({
  accessTier,
  isSubscriber = false,
  balance = 0,
  pricing,
  models,
}: {
  accessTier?: FreebuffAccessTier | null
  isSubscriber?: boolean
  balance?: number
  pricing?: Pick<FreebuffFreebucksInfo, 'prices'> | null
  models?: readonly FreebuffPresetModel[]
} = {}): readonly FreebuffModelPreset[] {
  const limited = accessTier === 'limited'
  const premium = !limited || isSubscriber || balance >= 100
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

  if (premium) {
    return [
      preset('efficient', 'Efficient', FREEBUFF_MIMO_V25_MODEL_ID, null),
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
  return [
    free
      ? {
          id: 'efficient',
          label: 'Efficient',
          modelId: free.id,
          reasoningEffort: free.defaultEffort ?? free.efforts?.[0] ?? null,
        }
      : preset('efficient', 'Efficient', FREEBUFF_MIMO_V25_MODEL_ID, null),
    preset('balanced', 'Balanced', FREEBUFF_MIMO_V25_MODEL_ID, null),
    preset('powerful', 'Powerful', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'high'),
  ]
}

/** A manual effort override is custom too: never hide it behind a category. */
export function matchingFreebuffModelPreset(
  presets: readonly FreebuffModelPreset[],
  modelId: string | null | undefined,
  effort: ReasoningEffort | null | undefined,
): FreebuffModelPreset | undefined {
  // If no free promotion is available, MiMo fills both lower stops. Prefer
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
