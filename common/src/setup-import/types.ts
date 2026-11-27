import type { AccountSkillsSnapshot } from '../desktop-cloud/project-settings'
import type { HookAddInput } from '../desktop-cloud/hooks-host'

export type CloudSkill = AccountSkillsSnapshot['settings']['skills'][number]
export type SetupImportHook = HookAddInput
export type SetupImportMcp =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  | { type: 'http'; url: string; headers: Record<string, string> }
export type SetupImportSource = 'claude' | 'codex' | 'cursor'
export type SetupImportKind =
  | 'skill'
  | 'command'
  | 'instructions'
  | 'mcp'
  | 'hook'
export type SetupImportOptions = {
  home?: string
  claudeDir?: string
  codexDir?: string
  cursorDir?: string
}

export type SetupImportItem = {
  id: string
  source: SetupImportSource
  kind: SetupImportKind
  displayName: string
  status: 'available' | 'unsupported'
  reason?: string
}
export type SetupImportOutcome =
  | 'imported'
  | 'unchanged'
  | 'conflict'
  | 'unsupported'
  | 'failed'
  | 'declined'
export type SetupImportResult = {
  id: string
  status: SetupImportOutcome | 'stale'
  reason?: string
}
export interface SetupImportSinks {
  skill(skill: CloudSkill, item: SetupImportItem): Promise<SetupImportOutcome>
  instructions(text: string, item: SetupImportItem): Promise<SetupImportOutcome>
  hook(
    hook: SetupImportHook,
    item: SetupImportItem,
  ): Promise<SetupImportOutcome>
  mcp(
    name: string,
    config: SetupImportMcp,
    item: SetupImportItem,
  ): Promise<SetupImportOutcome>
}

// Payloads and source paths stay inside the local process. Only SetupImportItem crosses IPC.
export type LocalCandidate =
  | { kind: 'skill' | 'command'; value: CloudSkill }
  | { kind: 'instructions'; value: string }
  | { kind: 'hook'; value: SetupImportHook }
  | { kind: 'mcp'; name: string; value: SetupImportMcp }
