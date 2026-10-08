import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  freebuffModelIdMatches,
  type FreebuffAccessTier,
} from '../constants/freebuff-models'
import { isDeepSeekExpensiveWindow } from '../constants/freebuff-peak-hours'
import type { ReasoningEffort } from '../constants/reasoning-effort'
import type { FreebuffFreebucksInfo } from '../types/freebuff-session'
import { offPeakPriceAt } from './freebuff-price-changes'

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
 * remain owned by the existing model-selection path. */
export function getFreebuffModelPresets({
  accessTier,
  countryCode,
  isSubscriber = false,
  balance = 0,
  pricing,
  models,
  now = Date.now(),
}: {
  accessTier?: FreebuffAccessTier | null
  countryCode?: string | null
  isSubscriber?: boolean
  balance?: number
  pricing?: Pick<FreebuffFreebucksInfo, 'prices' | 'offPeak'> | null
  models?: readonly FreebuffPresetModel[]
  now?: number
} = {}): readonly FreebuffModelPreset[] {
  const limited = accessTier === 'limited'
  // No account yet uses the US preview. A known account with no country
  // follows its access tier, rather than inferring geography from a timezone.
  const fastEligible =
    accessTier == null ||
    (!limited && (countryCode?.toUpperCase() === 'US' || isSubscriber)) ||
    balance >= 100
  const premium = !limited || isSubscriber || balance >= 100
  const rowFor = (id: string) =>
    models?.find((row) => freebuffModelIdMatches(row.compiledId ?? row.id, id))
  const fastRow = rowFor(FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID)
  const fastOffer =
    pricing?.offPeak?.[
      fastRow?.id ?? FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID
    ] ?? pricing?.offPeak?.[FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID]
  const offPeak = fastOffer
    ? offPeakPriceAt(fastOffer, now).price === fastOffer.price
    : !isDeepSeekExpensiveWindow(new Date(now))
  const flash =
    fastEligible && offPeak
      ? FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID
      : FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
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
      preset('balanced', 'Balanced', flash, 'high'),
      preset('powerful', 'Powerful', FREEBUFF_GPT_6_LUNA_MODEL_ID, 'xhigh'),
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
