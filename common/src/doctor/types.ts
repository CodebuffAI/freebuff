/**
 * Freebuff's own diagnostics ("Diagnose" in Desktop Settings, `freebuff doctor` in the CLI).
 *
 * Browser-safe: this file and `report.ts` carry no Node imports, so the hosted Settings page can
 * format a report Desktop produced. The checks themselves live under `node/` (shared) and in each
 * product (Desktop's profile, folder approvals and chat databases; the CLI's install and PATH).
 *
 * A finding never carries file contents, prompts, chat text or credentials. Paths, the user name
 * and emails are redacted unless the user opts in (`redact.ts`).
 */

export type DoctorSeverity = 'error' | 'warning' | 'info' | 'ok'

export type DoctorArea =
  | 'profile'
  | 'folders'
  | 'chats'
  | 'worktrees'
  | 'git'
  | 'disk'
  | 'processes'
  | 'logs'
  | 'crashes'
  | 'interface'
  | 'network'
  | 'clock'
  | 'install'
  | 'state'
  | 'auth'
  | 'environment'
  | 'system'

/**
 * A repair the product can apply, one at a time and only after the user confirms it. `ref` is an
 * opaque handle minted by the scan that found the problem: the page never sends a path back.
 */
export type DoctorRepairKind =
  | 'clear-display-caches'
  | 'reset-zoom'
  | 'relink-worktree'
  | 'trust-git-folder'

export type DoctorRepair = {
  kind: DoctorRepairKind
  ref?: string
  /** What the button says. */
  label: string
  /** What confirming does, shown before it runs. */
  confirm: string
  /** Shown beside the confirmation when the repair carries a risk (trusting a folder in git). */
  warning?: string
}

export type DoctorFinding = {
  /** Stable, fixed vocabulary (`profile.state-corrupt`): the report's join key, never user text. */
  id: string
  severity: DoctorSeverity
  area: DoctorArea
  title: string
  /** Plain language: what is wrong and why it matters. */
  detail: string
  /** What to do, in order. */
  steps: string[]
  /** A page that explains more (ours or the vendor's), never a community FAQ. */
  learnMore?: string
  repair?: DoctorRepair
}

export type DoctorCheckRun = {
  id: string
  ms: number
  outcome: 'done' | 'timeout' | 'failed' | 'skipped'
}

export type DoctorReport = {
  version: 1
  product: 'desktop' | 'cli'
  generatedAt: string
  durationMs: number
  appVersion: string | null
  platform: string
  arch: string
  options: { deep: boolean; includePaths: boolean }
  findings: DoctorFinding[]
  checks: DoctorCheckRun[]
}

export type DoctorRepairResult = {
  ok: boolean
  message: string
  /** Present when the repair can be undone: pass it back to undo. */
  undoRef?: string
}

const SEVERITY_ORDER: Record<DoctorSeverity, number> = { error: 0, warning: 1, info: 2, ok: 3 }

export function compareFindings(a: DoctorFinding, b: DoctorFinding) {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.area.localeCompare(b.area) || a.id.localeCompare(b.id)
}

export function finding(
  id: string,
  severity: DoctorSeverity,
  area: DoctorArea,
  title: string,
  detail: string,
  steps: string[] = [],
  extra: Pick<DoctorFinding, 'learnMore' | 'repair'> = {},
): DoctorFinding {
  return { id, severity, area, title, detail, steps, ...extra }
}
