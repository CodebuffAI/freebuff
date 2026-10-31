/** TypeScript mirrors of the Rust structs exposed over IPC. Keep in sync
 *  with `src-tauri/src/commands.rs` and `src-tauri/src/state.rs`. */

export type Tier = 'free' | 'pro'
export type ProviderKind = 'openai' | 'anthropic' | 'openaicompatible'

export interface ProviderCfg {
  kind: ProviderKind
  base_url: string
  api_key: string
  model: string
}

export interface Mode {
  id: string
  name: string
  prompt: string
  app_match: string | null
}

export interface Snippet {
  id: string
  trigger: string
  replacement: string
}

export interface VocabEntry {
  spoken: string
  written: string
}

export interface Settings {
  hotkey: string
  language: string | null
  selected_model: string
  mode_id: string | null
  provider: ProviderCfg | null
  modes: Mode[]
  snippets: Snippet[]
  vocabulary: VocabEntry[]
  worker_url: string
}

export interface UsageView {
  used_seconds: number
  /** `null` on Pro — unlimited. */
  limit_seconds: number | null
  day: string
}

export interface ModelView {
  id: string
  name: string
  size_bytes: number
  tier: Tier
  downloaded: boolean
  progress: number | null
}

export interface EntitlementView {
  tier: Tier
  activated: boolean
  /** Masked license code, e.g. `txn_01m4…038q`. */
  code_masked: string | null
  /** Full license code (Paddle transaction id) for moving to another machine. */
  license_code: string | null
  expires_at: number | null
}

export interface StateView {
  settings: Settings
  entitlement: EntitlementView
  usage: UsageView
  device_id: string
  models: ModelView[]
  bridge_port: number
}

/** Result of `check_for_update` (see `src-tauri/src/updates.rs`). */
export interface UpdateView {
  available: boolean
  version: string
  notes: string | null
}

/** `dictation` event payload emitted by `hotkey.rs`. */
export type DictationPhase =
  'listening' | 'processing' | 'done' | 'error' | 'blocked'

export interface DictationEvent {
  phase: DictationPhase
  text?: string
  error?: string
  prompt?: string
  used_seconds?: number
  remaining_seconds?: number
}
