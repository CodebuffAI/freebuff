/**
 * Theme Hooks
 *
 * Simple hooks for accessing theme from zustand store
 */

import { create } from 'zustand'

import { getCliEnv } from '../utils/env'
import {
  detectBgColorEvidence,
  themeFromBgColor,
} from '../utils/terminal-color-detection'
import { themeConfig, buildTheme } from '../utils/theme-config'
import {
  chatThemes,
  cloneChatTheme,
  detectIDETheme,
  detectPlatformTheme,
  detectTerminalOverrides,
  getOscDetectedTheme,
  initializeThemeWatcher,
  setThemeResolver,
  setupFileWatchers,
} from '../utils/theme-system'

import type { ChatTheme, ThemeName } from '../types/theme-system'
import type { StoreApi, UseBoundStore } from 'zustand'

type ThemeStore = {
  theme: ChatTheme
  setThemeName: (name: ThemeName) => void
}

export let useThemeStore: UseBoundStore<StoreApi<ThemeStore>> = (() => {
  throw new Error('useThemeStore not initialized')
}) as any
let themeStoreInitialized = false

type ThemeDetector = {
  description: string
  detect: () => ThemeName | null
}

const THEME_PRIORITY: ThemeDetector[] = [
  {
    description: 'Terminal override (e.g., OPENAI_THEME)',
    detect: detectTerminalOverrides,
  },
  {
    description: 'IDE configuration (VS Code, JetBrains, Zed)',
    detect: detectIDETheme,
  },
  {
    // Until the terminal's OSC reply lands (startup now probes in the
    // background so the first frame is not blocked on it), resolve from the
    // synchronous evidence: COLORFGBG/TERM_BACKGROUND ahead of the env, then
    // the per-terminal fallbacks. Once the reply lands it is recorded here
    // and applied through the same watcher refresh path. Final state matches
    // the old startup-order whenever the terminal answered the query.
    description: 'OSC terminal colors',
    detect: () => {
      const oscTheme = getOscDetectedTheme()
      if (oscTheme) return oscTheme
      const envBg = detectBgColorEvidence()
      return envBg ? themeFromBgColor(envBg) : null
    },
  },
  {
    description: 'Operating system theme',
    detect: detectPlatformTheme,
  },
]

export const detectSystemTheme = (): ThemeName => {
  const env = getCliEnv()
  const envPreference = env.OPEN_TUI_THEME ?? env.OPENTUI_THEME
  const normalizedEnv = envPreference?.toLowerCase()

  if (normalizedEnv === 'dark' || normalizedEnv === 'light') {
    return normalizedEnv
  }

  const preferredTheme = (): ThemeName => {
    for (const detector of THEME_PRIORITY) {
      const result = detector.detect()
      if (result) {
        return result
      }
    }
    return 'dark'
  }

  const resolved = preferredTheme()

  if (normalizedEnv === 'opposite') {
    return resolved === 'dark' ? 'light' : 'dark'
  }

  return resolved
}

export function initializeThemeStore() {
  if (themeStoreInitialized) {
    return
  }
  themeStoreInitialized = true

  setThemeResolver(detectSystemTheme)
  setupFileWatchers()

  const initialThemeName = detectSystemTheme()
  const initialTheme = buildTheme(
    cloneChatTheme(chatThemes[initialThemeName]),
    initialThemeName,
    themeConfig.customColors,
    themeConfig.plugins,
  )

  useThemeStore = create<ThemeStore>((set, get) => ({
    theme: initialTheme,

    setThemeName: (name: ThemeName) => {
      const currentTheme = get().theme
      
      // Skip if theme name hasn't changed
      if (currentTheme.name === name) {
        return
      }

      const baseTheme = cloneChatTheme(chatThemes[name])
      const theme = buildTheme(
        baseTheme,
        name,
        themeConfig.customColors,
        themeConfig.plugins,
      )
      set({ theme })
    },
  }))

  // Set up the theme watcher for reactive updates when system theme changes
  initializeThemeWatcher((name: ThemeName) => {
    useThemeStore.getState().setThemeName(name)
  })

  // Note: OSC detection runs in the background from index.tsx (started
  // before OpenTUI attaches its stdin listener, so the reply is not parsed
  // as keystrokes); when the answer lands, applyOscDetectedTheme() records
  // it and drives the same update path the file watchers and SIGUSR2 use.
}

export const useTheme = (): ChatTheme => {
  return useThemeStore((state) => state.theme)
}
