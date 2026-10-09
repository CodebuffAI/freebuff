/**
 * Environment variable contract types for dependency injection.
 *
 * ARCHITECTURE:
 * =============
 * Base types (defined here in common) that packages extend:
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      BASE TYPES (common)                        │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  BaseProcessEnv  - OS/runtime vars (SHELL, HOME, TERM, etc.)   │
 * │  BaseCiEnv       - CI vars (CI, GITHUB_ACTIONS, etc.)          │
 * │  ClientEnv       - Public vars (NEXT_PUBLIC_*) from env-schema │
 * └─────────────────────────────────────────────────────────────────┘
 *                               │
 *                     extends   │
 *                               ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    PACKAGE-SPECIFIC ENVS                        │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  CLI:    CliProcessEnv = BaseProcessEnv & { CLI-specific }     │
 * │  SDK:    SdkProcessEnv = BaseProcessEnv & { SDK-specific }     │
 * │  Server: ServerEnv = ClientEnv & { server secrets }            │
 * │  Evals:  EvalsCiEnv = BaseCiEnv & { eval-specific }             │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Each package imports the base types and extends them with package-specific vars.
 */

import type { ClientEnv } from '../../env-schema'

// Re-export the env types for convenience
export type { ClientEnv } from '../../env-schema'

// =============================================================================
// BASE TYPES - Extended by packages
// =============================================================================

/**
 * Base CI environment variables.
 * Used in CI/CD pipelines across all packages.
 */
export type BaseCiEnv = {
  CI?: string
  GITHUB_ACTIONS?: string
  RENDER?: string
  IS_PULL_REQUEST?: string
}

/**
 * Base runtime environment variables.
 * These are OS-level env vars common across all packages.
 */
export type BaseEnv = {
  // Shell detection
  SHELL?: string
  COMSPEC?: string // Windows command processor

  // Home directory
  HOME?: string
  USERPROFILE?: string // Windows home
  APPDATA?: string // Windows app data
  XDG_CONFIG_HOME?: string // Linux config home

  // Terminal detection
  TERM?: string
  TERM_PROGRAM?: string
  TERM_BACKGROUND?: string
  TERMINAL_EMULATOR?: string
  COLORFGBG?: string

  // Node/runtime
  NODE_ENV?: string
  NODE_PATH?: string
  PATH?: string
}

// =============================================================================
// EXTENDED TYPES - For packages that need more than base
// =============================================================================

/**
 * Extended CI env with Codebuff-specific CI vars.
 * Used by agent-runtime and server code.
 */
export type CiEnv = BaseCiEnv & {
  CODEBUFF_GITHUB_TOKEN?: string
  CODEBUFF_API_KEY?: string
  EVAL_RESULTS_EMAIL?: string
}

/**
 * Extended process env with terminal/IDE detection.
 * This is the full ProcessEnv used by CLI and SDK.
 * Packages can import this or create their own extensions of BaseProcessEnv.
 */
export type ProcessEnv = BaseEnv & {
  // Terminal-specific
  KITTY_WINDOW_ID?: string
  SIXEL_SUPPORT?: string
  ZED_NODE_ENV?: string

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
  CODEBUFF_WASM_DIR?: string
  // Comma-separated registry publishers whose agents may run executable
  // handleSteps on this machine (see sdk/src/agent-publisher-trust.ts)
  CODEBUFF_TRUSTED_AGENT_PUBLISHERS?: string

  // Build/CI flags
  VERBOSE?: string
  OVERRIDE_TARGET?: string
  OVERRIDE_PLATFORM?: string
  OVERRIDE_ARCH?: string
}
