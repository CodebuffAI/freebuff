/**
 * CLI-specific environment variable types.
 *
 * Extends base types from common with CLI-specific vars for:
 * - Terminal/IDE detection
 * - Editor preferences
 * - Binary build configuration
 */

import type { BaseEnv, ClientEnv } from '@codebuff/common/types/contracts/env'

/**
 * CLI-specific env vars for terminal/IDE detection and editor preferences.
 */
export type CliEnv = BaseEnv & {
  // Windows system paths
  SystemRoot?: string

  // Terminal detection (for tmux/screen passthrough)
  TERM?: string
  TMUX?: string
  STY?: string

  // SSH/remote session detection
  SSH_CLIENT?: string
  SSH_TTY?: string
  SSH_CONNECTION?: string
  CODESPACES?: string

  // Display server detection (Linux headless check)
  DISPLAY?: string
  WAYLAND_DISPLAY?: string

  // Terminal-specific
  KITTY_WINDOW_ID?: string
  SIXEL_SUPPORT?: string
  ZED_NODE_ENV?: string
  ZED_TERM?: string
  ZED_SHELL?: string
  COLORTERM?: string

  // VS Code family detection
  VSCODE_THEME_KIND?: string
  VSCODE_COLOR_THEME_KIND?: string
  VSCODE_GIT_IPC_HANDLE?: string
  VSCODE_PID?: string
  VSCODE_CWD?: string
  VSCODE_NLS_CONFIG?: string

  // Cursor editor detection
  CURSOR_PORT?: string
  CURSOR?: string

  // JetBrains IDE detection
  JETBRAINS_REMOTE_RUN?: string
  IDEA_INITIAL_DIRECTORY?: string
  IDE_CONFIG_DIR?: string
  JB_IDE_CONFIG_DIR?: string

  // Editor preferences
  VISUAL?: string
  EDITOR?: string
  CODEBUFF_CLI_EDITOR?: string
  CODEBUFF_EDITOR?: string

  // Theme preferences
  OPEN_TUI_THEME?: string
  OPENTUI_THEME?: string

  // Codebuff CLI-specific (set during binary build)
  CODEBUFF_IS_BINARY?: string
  CODEBUFF_CLI_VERSION?: string
  CODEBUFF_CLI_TARGET?: string
  CODEBUFF_RG_PATH?: string
  CODEBUFF_SCROLL_MULTIPLIER?: string
  CODEBUFF_PERF_TEST?: string
  CODEBUFF_TRACE?: string
  CODEBUFF_LAUNCHER_PID?: string
  // Toggle for mirroring CLI logs to the server's /api/logs sink (Axiom).
  CODEBUFF_SHIP_LOGS?: string
  // Set to 1/true to suppress the terminal-reset watchdog on machines where
  // the PowerShell process shape conflicts with endpoint-security policy.
  CODEBUFF_NO_TERMINAL_WATCHDOG?: string
  FREEBUFF_MODE?: string
  /** Absolute per-process override for isolated CLI settings and transcripts. */
  FREEBUFF_CONFIG_DIR?: string
}

/**
 * Full CLI env deps combining client env and CLI env.
 */
export type CliEnvDeps = {
  clientEnv: ClientEnv
  env: CliEnv
}

/**
 * Function type for getting CLI env values.
 */
export type GetCliEnvFn = () => CliEnv
