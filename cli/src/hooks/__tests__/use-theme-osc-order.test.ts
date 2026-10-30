/**
 * Theme resolution ordering for the fast-first-paint startup.
 *
 * The OSC probe used to block the first frame (index.tsx awaited
 * detectTerminalTheme() ahead of the renderer). It now runs in the
 * background and the first frame resolves from synchronous evidence
 * (COLORFGBG / TERM_BACKGROUND), with the terminal's answer applied on
 * arrival through applyOscDetectedTheme() — the same update path the file
 * watchers and SIGUSR2 use. These tests hold the user-visible contract:
 *
 *   1. The env evidence is on the store from the FIRST render — nothing
 *      waits for the probe.
 *   2. The answer arriving BEFORE the theme code is live takes effect via
 *      the initial detectSystemTheme() (same detector order as the awaited
 *      startup), so the settled theme matches the old ordering whenever the
 *      terminal answered the query.
 *   3. The answer arriving AFTER the store initialized drives the reactive
 *      update exactly like a system theme change — and a settle that agrees
 *      with the current theme is a no-op (identity-preserved), matching the
 *      theme-store's update guard.
 *
 * The store is a module-level singleton and bun runs every test file in the
 * directory in ONE process — another file may already have initialized it
 * under different env, and initializeThemeStore() is then a no-op. So:
 *   - The "what the first frame resolves" contract is asserted on
 *     detectSystemTheme() (pure recompute, exactly what the store's initial
 *     build calls), not on the store's possibly-foreign initial value.
 *   - The "answer lands on a live store" contract first drives the store to
 *     a known name through its own setter, then applies the OSC answer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

// Dynamic-import after ensureCliTestEnv so the config dir is already pointed
// at scratch when the theme modules evaluate. NOTE: `useThemeStore` must be
// read as a namespace property, never destructured — initializeThemeStore()
// REASSIGNS the exported `let` from a throwing stub to the zustand store,
// and a destructured const keeps the stub.
const useTheme = await import('../use-theme')
const { initializeThemeStore, detectSystemTheme } = useTheme
const themeSystem = await import('../../utils/theme-system')
const { applyOscDetectedTheme, getOscDetectedTheme, setOscDetectedTheme } =
  themeSystem
const { chatThemes } = themeSystem

const originalEnv = { ...process.env }
let oscSlotOriginal: 'dark' | 'light' | null | undefined

const clearThemeEnv = () => {
  for (const key of [
    'TERM_BACKGROUND',
    'COLORFGBG',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'XTERM_VERSION',
    'OPEN_TUI_THEME',
    'OPENTUI_THEME',
    // IDE markers: detectIDETheme outranks the OSC/evidence slot, so a
    // leaked vscode/cursor/jetbrains marker from another test file would
    // route detection through the IDE branch instead of the one under test.
    'TERM_PROGRAM_VERSION',
    'VSCODE_THEME_KIND',
    'VSCODE_COLOR_THEME_KIND',
    'VSCODE_GIT_IPC_HANDLE',
    'VSCODE_PID',
    'VSCODE_CWD',
    'VSCODE_NLS_CONFIG',
    'CURSOR_PORT',
    'CURSOR',
    'TERMINAL_EMULATOR',
    'JETBRAINS_REMOTE_RUN',
    'IDEA_INITIAL_DIRECTORY',
    'IDE_CONFIG_DIR',
    'JB_IDE_CONFIG_DIR',
  ]) {
    delete process.env[key]
  }
  // Generic, non-whitelisted value so terminalSupportsOSC() falls to its
  // stdin-isTTY check (false under CI) and no per-terminal fallback engages.
  process.env.TERM = 'fb-test-vt'
}

beforeEach(() => {
  oscSlotOriginal ??= getOscDetectedTheme()
  process.env = { ...originalEnv }
  clearThemeEnv()
  setOscDetectedTheme(null)
})

afterEach(() => {
  process.env = originalEnv
  setOscDetectedTheme(oscSlotOriginal ?? null)
  // Neutral end state for later test files in this process: recompute the
  // singleton's theme under the restored env (no-op name is skipped by the
  // store's own guard).
  initializeThemeStore()
  useTheme.useThemeStore.getState().setThemeName(detectSystemTheme())
})

describe('theme resolution ordering with a background OSC probe', () => {
  test('env evidence resolves synchronously for the first frame', () => {
    // The store's initial build calls detectSystemTheme(); assert the same
    // resolution directly so the test is independent of which file first
    // initialized the singleton.
    process.env.COLORFGBG = '0;15'
    expect(detectSystemTheme()).toBe('light')

    process.env.TERM_BACKGROUND = 'dark'
    expect(detectSystemTheme()).toBe('dark')
  })

  test('late OSC answer applies through the live re-theme path', () => {
    process.env.COLORFGBG = '0;15'
    initializeThemeStore()
    // Drive the store to the state the first frame would hold, through the
    // store's own setter (immune to which file initialized the singleton).
    useTheme.useThemeStore.getState().setThemeName('light')

    // The terminal's answer lands after the first paint.
    applyOscDetectedTheme('dark')

    expect(useTheme.useThemeStore.getState().theme.name).toBe('dark')
    // Same theme shape a watcher/SIGUSR2 re-theme would produce.
    expect(useTheme.useThemeStore.getState().theme.primary).toBe(chatThemes.dark.primary)
  })

  test('early OSC answer (pre-store) is picked up by the initial resolve', () => {
    // Simulates the probe settling before initializeApp ran: only the slot
    // is set, so the initial detectSystemTheme() must read it — the same
    // detector order the awaited startup resolved with.
    setOscDetectedTheme('dark')
    process.env.COLORFGBG = '0;15'

    expect(detectSystemTheme()).toBe('dark')
  })

  test('an OSC answer that agrees with the store is an identity-preserving no-op', () => {
    process.env.TERM_BACKGROUND = 'dark'
    initializeThemeStore()
    useTheme.useThemeStore.getState().setThemeName('dark')

    const before = useTheme.useThemeStore.getState().theme
    applyOscDetectedTheme('dark')
    expect(useTheme.useThemeStore.getState().theme).toBe(before)
  })

  test('env evidence applies when the probe never answers', () => {
    // Swallowed-query terminals (the +2s case) settle on the evidence.
    process.env.COLORFGBG = '15;0'
    expect(detectSystemTheme()).toBe('dark')
  })
})
