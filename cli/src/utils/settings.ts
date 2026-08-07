import fs from 'fs'
import path from 'path'

import {
  FREEBUFF_MODELS,
  isFreebuffModelId,
  migrateSupersededFreebuffModelPreference,
} from '@codebuff/common/constants/freebuff-models'

import { getConfigDir } from './auth'
import { AGENT_MODES } from './constants'
import { logger } from './logger'

import type { AgentMode } from './constants'

const DEFAULT_SETTINGS: Settings = {
  mode: 'DEFAULT' as const,
  adsEnabled: true,
  undo: true,
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
  /** @deprecated Use server-side fallbackToALaCarte setting instead */
  alwaysUseALaCarte?: boolean
  /** @deprecated Use server-side fallbackToALaCarte setting instead */
  fallbackToALaCarte?: boolean
  /** Set once the user has submitted their first prompt. Used to gate the
   *  first-time onboarding suggested prompts so they only show to brand-new
   *  users and quietly retire afterwards. */
  hasSubmittedFirstPrompt?: boolean
  /** Whether /undo and /redo are enabled. Defaults to true. */
  undo?: boolean
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

  // Steer off a model that has since been superseded (DeepSeek V4 Pro, MiniMax
  // M3, MiMo 2.5 → V4 Flash) on EVERY load, so each new freebuff session starts
  // on the better model instead of a pick made before it existed. Picking a
  // superseded model still works for the session you are in; it just stops
  // being what the next launch opens on.
  const replacement = migrateSupersededFreebuffModelPreference(
    settings.freebuffModel,
    FREEBUFF_MODELS.map((model) => model.id),
  )
  if (replacement) settings.freebuffModel = replacement

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

  // Validate undo toggle
  if (typeof obj.undo === 'boolean') {
    settings.undo = obj.undo
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

/**
 * Load the saved freebuff model preference. Returns undefined if none is
 * saved yet — callers should fall back to DEFAULT_FREEBUFF_MODEL_ID.
 */
export const loadFreebuffModelPreference = (): string | undefined => {
  return loadSettings().freebuffModel
}

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

/**
 * Whether /undo and /redo are enabled. Defaults to true.
 */
export const isUndoEnabled = (): boolean => loadSettings().undo !== false

/**
 * Enable or disable /undo and /redo.
 */
export const setUndoEnabled = (enabled: boolean): void => {
  saveSettings({ undo: enabled })
}
