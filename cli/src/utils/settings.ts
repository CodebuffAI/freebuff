import fs from 'fs'
import path from 'path'

import {
  DEFAULT_FREEBUFF_MODEL_ID,
  FREEBUFF_MODELS,
  PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID,
  getFreebuffModelEfforts,
  isFreebuffModelId,
  migrateSupersededFreebuffModelPreference,
} from '@codebuff/common/constants/freebuff-models'
import { isReasoningEffort } from '@codebuff/common/constants/reasoning-effort'
import {
  migrateSavedDefaultModel,
  type SavedModelStore,
} from '@codebuff/common/util/freebuff-default-model-migration'

import { getConfigDir } from './auth'
import { AGENT_MODES } from './constants'
import { logger } from './logger'

import type { AgentMode } from './constants'
import type { ReasoningEffort } from '@codebuff/common/constants/reasoning-effort'

const DEFAULT_SETTINGS: Settings = {
  mode: 'DEFAULT' as const,
  adsEnabled: true,
}

// Note: The old FREE mode has been renamed back to LITE; migrate on load.

/**
 * Settings schema - add new settings here as the product evolves
 */
export interface Settings {
  mode?: AgentMode
  adsEnabled?: boolean
  /** Last model the user picked in the freebuff model selector. Restored on
   *  next freebuff launch so users land in the queue for their preferred
   *  model without re-picking. Persisted as the canonical model id. */
  freebuffModel?: string
  /** Which default flip `freebuffModel` has been migrated through — see
   *  FREEBUFF_DEFAULT_MODEL_MIGRATION_ID. */
  freebuffModelDefaultMigration?: string
  /** Reasoning effort the user picked per model, keyed by canonical model id.
   *  Per-model rather than a single value because the ladders differ: DeepSeek
   *  V4 offers low/high/max while Luna offers low..max, so one shared value
   *  would silently become a different rung on every model switch. A model
   *  absent from this map runs its catalog default, which is also what the
   *  server does when the client sends nothing. */
  freebuffReasoningEfforts?: Record<string, ReasoningEffort>
  /** The run-scoped BYOK connection selected in this CLI. Credentials remain
   * in the OS keychain or an explicitly named environment variable. */
  byokConnection?: {
    id: string
    revision: number
    provider?: 'openrouter' | 'openai-compatible'
    model?: string
  }
  /** @deprecated Use server-side fallbackToALaCarte setting instead */
  alwaysUseALaCarte?: boolean
  /** @deprecated Use server-side fallbackToALaCarte setting instead */
  fallbackToALaCarte?: boolean
  /** Set once the user has submitted their first prompt. Used to gate the
   *  first-time onboarding suggested prompts so they only show to brand-new
   *  users and quietly retire afterwards. */
  hasSubmittedFirstPrompt?: boolean
  /** When the one-time Freebucks introduction was shown (ISO). Set the
   *  moment it renders, not when it is dismissed, so "once" holds however
   *  the launch ends. */
  freebucksIntroSeenAt?: string
}

/**
 * Get the settings file path
 */
export const getSettingsPath = (): string => {
  return path.join(getConfigDir(), 'settings.json')
}

/**
 * Ensure the config directory exists, creating it if necessary
 */
const ensureConfigDirExists = (): void => {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
}

/**
 * Load all settings from file system
 * @returns The saved settings object, with defaults for missing values
 */
export const loadSettings = (): Settings => {
  const settingsPath = getSettingsPath()

  if (!fs.existsSync(settingsPath)) {
    ensureConfigDirExists()
    // Create default settings file
    fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2))
    return DEFAULT_SETTINGS
  }

  try {
    const settingsFile = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(settingsFile)
    return validateSettings(parsed)
  } catch (error) {
    logger.debug(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error reading settings',
    )
    return {}
  }
}

/**
 * Validate and sanitize settings from file
 */
const validateSettings = (parsed: unknown): Settings => {
  if (typeof parsed !== 'object' || parsed === null) {
    return {}
  }

  const settings: Settings = {}
  const obj = parsed as Record<string, unknown>

  // Validate mode; migrate the previously-saved 'FREE' value to 'LITE'.
  if (typeof obj.mode === 'string') {
    const normalized = obj.mode === 'FREE' ? 'LITE' : obj.mode
    if (AGENT_MODES.includes(normalized as AgentMode)) {
      settings.mode = normalized as AgentMode
    }
  }

  // Validate adsEnabled
  if (typeof obj.adsEnabled === 'boolean') {
    settings.adsEnabled = obj.adsEnabled
  }

  // Validate freebuffModel against the current picker catalog. Server support
  // may intentionally outlive client visibility during a staged model
  // retirement, but an updated client must not restore a retired selection.
  if (
    typeof obj.freebuffModel === 'string' &&
    isFreebuffModelId(obj.freebuffModel)
  ) {
    settings.freebuffModel = obj.freebuffModel
  }

  // Steer off a model that has since been superseded (MiniMax M3, MiMo 2.5 →
  // V4 Flash) on EVERY load, so each new freebuff session starts
  // on the better model instead of a pick made before it existed. Picking a
  // superseded model still works for the session you are in; it just stops
  // being what the next launch opens on.
  const replacement = migrateSupersededFreebuffModelPreference(
    settings.freebuffModel,
    FREEBUFF_MODELS.map((model) => model.id),
  )
  if (replacement) settings.freebuffModel = replacement
  if (typeof obj.freebuffModelDefaultMigration === 'string') {
    settings.freebuffModelDefaultMigration = obj.freebuffModelDefaultMigration
  }

  // Validate saved efforts against BOTH the effort vocabulary and each model's
  // own ladder. A rung dropped from a catalog row (or a model that stopped
  // offering a choice at all) must not survive in the file and get sent as a
  // request the server would only have to clamp.
  if (obj.freebuffReasoningEfforts && typeof obj.freebuffReasoningEfforts === 'object') {
    const efforts: Record<string, ReasoningEffort> = {}
    for (const [modelId, effort] of Object.entries(
      obj.freebuffReasoningEfforts as Record<string, unknown>,
    )) {
      if (!isReasoningEffort(effort)) continue
      if (!getFreebuffModelEfforts(modelId)?.includes(effort)) continue
      efforts[modelId] = effort
    }
    if (Object.keys(efforts).length > 0) {
      settings.freebuffReasoningEfforts = efforts
    }
  }

  const byokConnection = obj.byokConnection as Record<string, unknown> | null
  if (
    byokConnection &&
    typeof byokConnection === 'object' &&
    typeof byokConnection.id === 'string' &&
    typeof byokConnection.revision === 'number' &&
    Number.isSafeInteger(byokConnection.revision) &&
    byokConnection.revision > 0
  ) {
    settings.byokConnection = {
      id: byokConnection.id,
      revision: byokConnection.revision,
      ...(byokConnection.provider === 'openrouter' ||
      byokConnection.provider === 'openai-compatible'
        ? { provider: byokConnection.provider }
        : {}),
      ...(typeof byokConnection.model === 'string' && byokConnection.model
        ? { model: byokConnection.model }
        : {}),
    }
  }

  // Validate alwaysUseALaCarte (legacy)
  if (typeof obj.alwaysUseALaCarte === 'boolean') {
    settings.alwaysUseALaCarte = obj.alwaysUseALaCarte
  }

  // Validate fallbackToALaCarte (legacy)
  if (typeof obj.fallbackToALaCarte === 'boolean') {
    settings.fallbackToALaCarte = obj.fallbackToALaCarte
  }

  // Validate hasSubmittedFirstPrompt
  if (typeof obj.hasSubmittedFirstPrompt === 'boolean') {
    settings.hasSubmittedFirstPrompt = obj.hasSubmittedFirstPrompt
  }

  // The loader is an ALLOWLIST — a key not copied here is dropped on every
  // load and silently rewritten on the next save. That is how the intro's
  // "shown once" mark lasted exactly one launch (2026-09-05).
  if (typeof obj.freebucksIntroSeenAt === 'string') {
    settings.freebucksIntroSeenAt = obj.freebucksIntroSeenAt
  }

  return settings
}

/**
 * Save settings to file system (merges with existing settings)
 */
export const saveSettings = (newSettings: Partial<Settings>): void => {
  const settingsPath = getSettingsPath()

  try {
    ensureConfigDirExists()

    // Load existing settings and merge
    const existingSettings = loadSettings()
    const mergedSettings = { ...existingSettings, ...newSettings }

    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2))
  } catch (error) {
    logger.debug(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving settings',
    )
  }
}

/**
 * Load the saved agent mode preference
 * @returns The saved mode, or 'DEFAULT' if not found or invalid
 */
export const loadModePreference = (): AgentMode => {
  const settings = loadSettings()
  return settings.mode ?? 'DEFAULT'
}

/**
 * Save the agent mode preference
 */
export const saveModePreference = (mode: AgentMode): void => {
  saveSettings({ mode })
}

/** The settings file, as the store the shared default migration runs over. */
const settingsModelStore: SavedModelStore = {
  readPick: () => loadSettings().freebuffModel,
  writePick: (freebuffModel) => saveSettings({ freebuffModel }),
  readStamp: () => loadSettings().freebuffModelDefaultMigration,
  writeStamp: (freebuffModelDefaultMigration) =>
    saveSettings({ freebuffModelDefaultMigration }),
}

/**
 * Load the saved freebuff model preference, through the one-time default
 * migration (migrateSavedDefaultModel). Returns undefined if none is saved —
 * callers should fall back to DEFAULT_FREEBUFF_MODEL_ID.
 */
export const loadFreebuffModelPreference = (): string | undefined =>
  migrateSavedDefaultModel(settingsModelStore, {
    previous: PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID,
    current: DEFAULT_FREEBUFF_MODEL_ID,
  }) ?? undefined

/**
 * Save an ordinary freebuff picker preference so the next launch defaults to
 * it. Referral-only and retired session models are deliberately not
 * rememberable: they may be valid for the current session without being
 * selectable on the next landing screen.
 */
export const saveFreebuffModelPreference = (model: string): void => {
  if (!isFreebuffModelId(model)) return
  saveSettings({ freebuffModel: model })
}

/**
 * Load every saved per-model reasoning effort. Already validated against the
 * current catalog by `loadSettings`.
 */
export const loadFreebuffReasoningEfforts = (): Record<
  string,
  ReasoningEffort
> => {
  return loadSettings().freebuffReasoningEfforts ?? {}
}

/**
 * Persist (or clear) the reasoning effort for one model.
 *
 * Passing `undefined` REMOVES the entry rather than storing a null, so "back to
 * the model default" and "never chose" are the same state on disk — the client
 * then sends no effort at all and the catalog default applies, exactly as it
 * does for a user who never touched the control.
 */
export const saveFreebuffReasoningEffort = (
  model: string,
  effort: ReasoningEffort | undefined,
): void => {
  const existing = loadSettings().freebuffReasoningEfforts ?? {}
  const next = { ...existing }
  if (effort === undefined) {
    delete next[model]
  } else {
    next[model] = effort
  }
  saveSettings({ freebuffReasoningEfforts: next })
}

/**
 * Whether the user has ever submitted a prompt. False only for brand-new
 * users, who get the onboarding suggested prompts on an empty chat.
 */
export const hasSubmittedFirstPrompt = (): boolean => {
  return loadSettings().hasSubmittedFirstPrompt === true
}

/**
 * Mark that the user has submitted their first prompt, retiring the onboarding
 * suggested prompts on future launches. Idempotent.
 */
export const markFirstPromptSubmitted = (): void => {
  if (loadSettings().hasSubmittedFirstPrompt === true) return
  saveSettings({ hasSubmittedFirstPrompt: true })
}

export const hasSeenFreebucksIntro = (): boolean =>
  Boolean(loadSettings().freebucksIntroSeenAt)

export const markFreebucksIntroSeen = (): void => {
  saveSettings({ freebucksIntroSeenAt: new Date().toISOString() })
}
