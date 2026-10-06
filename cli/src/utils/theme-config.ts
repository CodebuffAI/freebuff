/**
 * Theme Configuration System
 *
 * Provides plugin system and customization support for themes
 */

import type { ChatTheme } from '../types/theme-system'

/**
 * Plugin interface for extending theme system
 * Plugins can modify themes at runtime
 */
export interface ThemePlugin {
  /** Unique plugin name */
  name: string
  /**
   * Apply plugin modifications to a theme
   * @param theme - The base theme
   * @param mode - The detected light/dark mode
   * @returns Partial theme to merge
   */
  apply: (
    theme: ChatTheme,
    mode: 'dark' | 'light',
  ) => Partial<ChatTheme>
}

/**
 * Main theme configuration interface
 */
export interface ThemeConfig {
  /** Global color overrides applied to themes */
  customColors?: Partial<ChatTheme>
  /** Registered plugins for theme extensions */
  plugins?: ThemePlugin[]
}

/**
 * Default theme configuration
 */
export const defaultThemeConfig: ThemeConfig = {
  customColors: {},
  plugins: [],
}

/**
 * Active theme configuration
 * Can be modified at runtime for customization
 */
export let themeConfig: ThemeConfig = defaultThemeConfig

/**
 * Resolve 'default' color values to fallback colors
 * Components should never see 'default' - it's resolved during theme building
 */
const resolveThemeColors = (theme: ChatTheme, mode: 'dark' | 'light'): void => {
  const defaultFallback = mode === 'dark' ? '#ffffff' : '#000000'

  const resolve = (value: string, fallback: string = defaultFallback): string => {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'default' || normalized.length === 0) {
        return fallback
      }
      return value
    }
    return fallback
  }

  // Resolve all ThemeColor properties to actual colors
  theme.foreground = resolve(theme.foreground)
  theme.muted = resolve(theme.muted)
  theme.inputFg = resolve(theme.inputFg)
  theme.inputFocusedFg = resolve(theme.inputFocusedFg)
}

/**
 * Build a complete theme by applying custom colors and plugins
 * All 'default' color values are resolved to actual colors
 * @param baseTheme - The base theme to start from
 * @param mode - Current theme mode (dark or light)
 * @param customColors - Optional custom color overrides
 * @param plugins - Optional theme plugins to apply
 * @returns Complete theme with all customizations applied
 */
export const buildTheme = (
  baseTheme: ChatTheme,
  mode: 'dark' | 'light',
  customColors?: Partial<ChatTheme>,
  plugins?: ThemePlugin[],
): ChatTheme => {
  // Start with cloned base theme (cloning handled by caller)
  const theme = { ...baseTheme }

  // Layer 1: Apply global custom colors
  if (customColors) {
    Object.assign(theme, customColors)
  }

  // Layer 2: Apply plugins
  if (plugins) {
    for (const plugin of plugins) {
      const pluginOverrides = plugin.apply(theme, mode)
      Object.assign(theme, pluginOverrides)
    }
  }

  // Final step: Resolve all 'default' values to actual colors
  resolveThemeColors(theme, mode)
  theme.name = mode

  return theme
}
