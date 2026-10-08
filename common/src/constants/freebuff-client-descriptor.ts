/**
 * Wire names for the CLI's client descriptors: a terminal-environment summary
 * sent as a header on session and ad requests, and per-prompt input counts sent
 * in `codebuff_metadata`.
 *
 * Both are compact `v1;key=value;...` strings of counts and fixed bucket names.
 * They never carry prompt text, paths, process names or other free text.
 */

export const FREEBUFF_CLIENT_ENV_HEADER = 'x-freebuff-env'

/** `codebuff_metadata` key carrying the same environment descriptor. */
export const FREEBUFF_CLIENT_ENV_METADATA_KEY = 'freebuff_client_env'

/** `codebuff_metadata` key carrying the input counts for the prompt that
 *  started the run. */
export const FREEBUFF_INPUT_PROFILE_METADATA_KEY = 'freebuff_input_profile'

export const FREEBUFF_CLIENT_DESCRIPTOR_VERSION = 'v1'

/** `TERM_PROGRAM`, reduced to a fixed list. `none` = unset, `other` = a value
 *  not on the list. */
export const TERMINAL_PROGRAM_BUCKETS = [
  'none',
  'other',
  'apple_terminal',
  'iterm',
  'vscode',
  'ghostty',
  'wezterm',
  'warp',
  'hyper',
  'tmux',
  'zed',
  'tabby',
  'rio',
  'mintty',
  'jetbrains',
  'kitty',
  'alacritty',
] as const
export type TerminalProgramBucket = (typeof TERMINAL_PROGRAM_BUCKETS)[number]

/** The cloud IDE the CLI runs in, from its own environment (`cde`). The
 *  server reads anything but `none` as a datacenter exit for the account's
 *  home tier (hosting-home.ts); a claim that can only tighten. */
export const CLOUD_IDE_BUCKETS = [
  'none',
  'codespaces',
  'gitpod',
  'cloudshell',
  'coder',
] as const
export type CloudIdeBucket = (typeof CLOUD_IDE_BUCKETS)[number]

/** An ancestor process, reduced to its kind. `unknown` = the lookup failed or
 *  had not finished; `na` = not looked up on this platform. */
export const PROCESS_KIND_BUCKETS = [
  'shell',
  'terminal',
  'editor',
  'mux',
  'sshd',
  'node',
  'python',
  'bun',
  'other',
  'unknown',
  'na',
] as const
export type ProcessKindBucket = (typeof PROCESS_KIND_BUCKETS)[number]
