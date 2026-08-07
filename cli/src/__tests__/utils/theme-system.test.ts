import { describe, expect, test } from 'bun:test'

import { extractVSCodeTheme } from '../../utils/theme-system'

describe('cli/utils/theme-system', () => {
  describe('extractVSCodeTheme', () => {
    test('uses explicit VS Code color theme when auto-detect is disabled', () => {
      const theme = extractVSCodeTheme(`
        {
          "window.autoDetectColorScheme": false,
          "workbench.colorTheme": "Default Light Modern"
        }
      `)

      expect(theme).toBe('light')
    })

    test('defers to platform detection when VS Code syncs with OS theme', () => {
      const theme = extractVSCodeTheme(`
        {
          "window.autoDetectColorScheme": true,
          "workbench.preferredDarkColorTheme": "Default Dark Modern",
          "workbench.preferredLightColorTheme": "Default Light Modern"
        }
      `)

      expect(theme).toBeNull()
    })
  })
})
