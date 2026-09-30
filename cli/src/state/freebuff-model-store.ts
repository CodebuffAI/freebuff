import {
  DEFAULT_FREEBUFF_MODEL_ID,
  resolveAvailableFreebuffModel,
} from '@codebuff/common/constants/freebuff-models'
import { create } from 'zustand'

import { getFreebuffModelDirectory } from './freebuff-catalog-store'
import {
  loadFreebuffCatalogReasoningEfforts,
  loadFreebuffModelPreference,
  loadFreebuffReasoningEfforts,
  saveFreebuffCatalogReasoningEffort,
  saveFreebuffModelKeyPreference,
  saveFreebuffModelPreference,
  saveFreebuffReasoningEffort,
} from '../utils/settings'

import type { ReasoningEffort } from '@codebuff/common/constants/reasoning-effort'

/**
 * Holds the user's currently-selected freebuff model. Initialized from the
 * persisted settings file so freebuff defaults to whatever model the user
 * last picked.
 *
 * `setSelectedModel` is in-memory only — it does NOT persist. Persistence
 * happens on an explicit model pick (`selectFreebuffChatModel`, or the legacy
 * `startFreebuffSession` picker path), so
 * server-driven auto-flips (`model_locked`, `model_unavailable`, takeover)
 * can update the in-memory selection without overwriting the user's saved
 * preference. The latter previously caused users to get permanently flipped
 * to the fallback model after a single auto-fallback.
 *
 * Components on the landing screen read this to highlight the current row in
 * the model picker; the session hook reads it to decide which model to start.
 *
 * Reasoning effort is the opposite: `setReasoningEffort` DOES persist, because
 * every write to it is an explicit user act (the model picker). There is no
 * server-driven effort flip to protect against — the server clamps rather than
 * telling the client what it chose.
 *
 * In catalog mode (docs/freebuff-model-catalog.md) `selectedModel` holds a
 * catalog KEY rather than a model id, the same value the session response
 * carries there. Keys and ids never collide, so both kinds share this field
 * and the effort map; the directory decides what a value means.
 */
interface FreebuffModelStore {
  selectedModel: string
  setSelectedModel: (model: string) => void
  /** Per-model effort overrides. A model absent from this map runs its catalog
   *  default; see saveFreebuffReasoningEffort for why absence is the "default"
   *  state rather than a stored null. */
  reasoningEffortByModel: Record<string, ReasoningEffort>
  setReasoningEffort: (
    model: string,
    effort: ReasoningEffort | undefined,
  ) => void
}

export const useFreebuffModelStore = create<FreebuffModelStore>((set) => ({
  selectedModel: resolveAvailableFreebuffModel(
    loadFreebuffModelPreference() ?? DEFAULT_FREEBUFF_MODEL_ID,
  ),
  setSelectedModel: (model) =>
    set({ selectedModel: getFreebuffModelDirectory().resolveSelection(model) }),
  reasoningEffortByModel: {
    ...loadFreebuffReasoningEfforts(),
    ...loadFreebuffCatalogReasoningEfforts(),
  },
  setReasoningEffort: (model, effort) => {
    if (getFreebuffModelDirectory().row(model)?.key === model) {
      saveFreebuffCatalogReasoningEffort(model, effort)
    } else {
      saveFreebuffReasoningEffort(model, effort)
    }
    set((state) => {
      const next = { ...state.reasoningEffortByModel }
      if (effort === undefined) {
        delete next[model]
      } else {
        next[model] = effort
      }
      return { reasoningEffortByModel: next }
    })
  },
}))

/** Imperative read for non-React callers (the session hook's tick loop and
 *  the chat-completions metadata builder). */
export function getSelectedFreebuffModel(): string {
  return useFreebuffModelStore.getState().selectedModel
}

/**
 * The user's effort override for a model, or null when they have none.
 *
 * Re-checked against the model's CURRENT ladder on every read rather than
 * trusted from the map. A rung can leave a catalog row between the save and
 * this read (a client update, a model re-tuned), and sending a rung the model
 * no longer offers is worse than sending nothing: the server would clamp it
 * down to something the user never picked, while sending nothing lands on the
 * model's own default — the same place a fresh user lands.
 */
export function getFreebuffReasoningEffortForModel(
  model: string,
): ReasoningEffort | null {
  const directory = getFreebuffModelDirectory()
  const efforts = useFreebuffModelStore.getState().reasoningEffortByModel
  const saved = efforts[model] ?? legacyEffortForCatalogKey(model, efforts)
  if (!saved) return null
  return directory.efforts(model)?.includes(saved) ? saved : null
}

/**
 * A catalog row with no effort of its own inherits the one saved for the
 * compiled model it replaces, so a user's pick survives the move to the
 * catalog. Read-only: the first explicit choice on the row is what persists.
 */
function legacyEffortForCatalogKey(
  key: string,
  efforts: Record<string, ReasoningEffort>,
): ReasoningEffort | undefined {
  const directory = getFreebuffModelDirectory()
  if (directory.row(key)?.key !== key) return undefined
  for (const [id, effort] of Object.entries(efforts)) {
    if (id !== key && directory.row(id)?.key === key) return effort
  }
  return undefined
}

/**
 * Persist an explicit pick so the next launch opens on it: the row key in
 * catalog mode, the model id in fallback mode (which also clears the saved
 * key; see `saveFreebuffModelPreference`).
 */
export function persistFreebuffModelPick(model: string): void {
  if (getFreebuffModelDirectory().row(model)?.key === model) {
    saveFreebuffModelKeyPreference(model)
  } else {
    saveFreebuffModelPreference(model)
  }
}

/** What a turn on this model will ACTUALLY run at, override or not — the value
 *  the pickers display. Null when the model exposes no ladder. */
export function getEffectiveFreebuffReasoningEffort(
  model: string,
): ReasoningEffort | null {
  return (
    getFreebuffReasoningEffortForModel(model) ??
    getFreebuffModelDirectory().defaultEffort(model)
  )
}

/** The override for whichever model is selected right now. Sent verbatim as
 *  `freebuff_reasoning_effort`; null means "send nothing". */
export function getSelectedFreebuffReasoningEffort(): ReasoningEffort | null {
  return getFreebuffReasoningEffortForModel(getSelectedFreebuffModel())
}
