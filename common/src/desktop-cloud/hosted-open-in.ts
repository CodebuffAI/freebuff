import type { HostedBrowserScope } from './hosted-workspace'

export type HostedOpenEditorId = 'vscode' | 'cursor' | 'zed'
export type HostedOpenTargetId = HostedOpenEditorId | 'terminal' | 'file-manager' | 'copy-path'

/** An app Desktop found on this computer (freebuff-desktop/electron/open-in.cjs). */
export type HostedOpenTarget = {
  id: HostedOpenTargetId
  label: string
  kind: 'editor' | 'terminal' | 'system'
}

/** Selectors only. Native resolves the project's or chat's folder and never returns it. */
export type HostedOpenInRequest =
  | { projectId: string; targetId: HostedOpenTargetId }
  | (HostedBrowserScope & { targetId: HostedOpenTargetId; path?: string; line?: number })

export type HostedOpenInResult = { ok: true; fallback: boolean } | { ok: false; error: string }

export type HostedOpenInHost = {
  targets(): Promise<HostedOpenTarget[]>
  open(input: HostedOpenInRequest): Promise<HostedOpenInResult>
}
