/**
 * Process environment helper for dependency injection.
 *
 * This module provides a typed interface to process.env values that aren't
 * part of our validated schemas (ClientEnv/ServerEnv). These are runtime
 * environment variables like SHELL, HOME, TERM, etc.
 *
 * Usage:
 * - Import `getBaseEnv` for base OS-level vars only
 * - Import `getProcessEnv` for the full ProcessEnv (base + extensions)
 * - In tests, use `@codebuff/common/testing-env-process`
 */

import type { BaseEnv, ProcessEnv } from './types/contracts/env'

/**
 * Get base environment values (OS-level vars only).
 * This is the foundation that package-specific helpers should spread into.
 */
export const getBaseEnv = (): BaseEnv => ({
  SHELL: process.env.SHELL,
  COMSPEC: process.env.COMSPEC,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TERM: process.env.TERM,
  TERM_PROGRAM: process.env.TERM_PROGRAM,
  TERM_BACKGROUND: process.env.TERM_BACKGROUND,
  TERMINAL_EMULATOR: process.env.TERMINAL_EMULATOR,
  COLORFGBG: process.env.COLORFGBG,
  NODE_ENV: process.env.NODE_ENV,
  NODE_PATH: process.env.NODE_PATH,
  PATH: process.env.PATH,
})

/**
 * Get full process environment values (base + all extensions).
 * Returns a snapshot of the current process.env values for the ProcessEnv type.
 */
export const getProcessEnv = (): ProcessEnv => ({
  ...getBaseEnv(),

  // Terminal-specific
  KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
  SIXEL_SUPPORT: process.env.SIXEL_SUPPORT,
  ZED_NODE_ENV: process.env.ZED_NODE_ENV,

  // VS Code family detection
  VSCODE_THEME_KIND: process.env.VSCODE_THEME_KIND,
  VSCODE_COLOR_THEME_KIND: process.env.VSCODE_COLOR_THEME_KIND,
  VSCODE_GIT_IPC_HANDLE: process.env.VSCODE_GIT_IPC_HANDLE,
  VSCODE_PID: process.env.VSCODE_PID,
  VSCODE_CWD: process.env.VSCODE_CWD,
  VSCODE_NLS_CONFIG: process.env.VSCODE_NLS_CONFIG,

  // Cursor editor detection
  CURSOR_PORT: process.env.CURSOR_PORT,
  CURSOR: process.env.CURSOR,

  // JetBrains IDE detection
  JETBRAINS_REMOTE_RUN: process.env.JETBRAINS_REMOTE_RUN,
  IDEA_INITIAL_DIRECTORY: process.env.IDEA_INITIAL_DIRECTORY,
  IDE_CONFIG_DIR: process.env.IDE_CONFIG_DIR,
  JB_IDE_CONFIG_DIR: process.env.JB_IDE_CONFIG_DIR,

  // Editor preferences
  VISUAL: process.env.VISUAL,
  EDITOR: process.env.EDITOR,
  CODEBUFF_CLI_EDITOR: process.env.CODEBUFF_CLI_EDITOR,
  CODEBUFF_EDITOR: process.env.CODEBUFF_EDITOR,

  // Theme preferences
  OPEN_TUI_THEME: process.env.OPEN_TUI_THEME,
  OPENTUI_THEME: process.env.OPENTUI_THEME,

  // Codebuff CLI-specific
  CODEBUFF_IS_BINARY: process.env.CODEBUFF_IS_BINARY,
  CODEBUFF_CLI_VERSION: process.env.CODEBUFF_CLI_VERSION,
  CODEBUFF_CLI_TARGET: process.env.CODEBUFF_CLI_TARGET,
  CODEBUFF_RG_PATH: process.env.CODEBUFF_RG_PATH,
  CODEBUFF_WASM_DIR: process.env.CODEBUFF_WASM_DIR,
  CODEBUFF_TRUSTED_AGENT_PUBLISHERS:
    process.env.CODEBUFF_TRUSTED_AGENT_PUBLISHERS,

  // Build/CI flags
  VERBOSE: process.env.VERBOSE,
  OVERRIDE_TARGET: process.env.OVERRIDE_TARGET,
  OVERRIDE_PLATFORM: process.env.OVERRIDE_PLATFORM,
  OVERRIDE_ARCH: process.env.OVERRIDE_ARCH,
})

/**
 * Default process env instance.
 * Use this for production code, inject mocks in tests.
 */
export const processEnv: ProcessEnv = getProcessEnv()
