import type { ReasoningEffort } from '../constants/reasoning-effort'
import type { FreebuffModelCatalog } from '../types/freebuff-model-catalog'
import type { WorkspacePreferencesPatch } from './workspace-preferences'

/** Additive hosted-Desktop capability. IDs here are local selectors, never cloud chat IDs. */
export type LocalConversationScope = { projectId: string; threadId: string }
export type LocalConversationProject = {
  id: string
  name: string
  /** Shared project identity, derived by native from the account/backend/project. */
  cloudProjectId?: string | null
  noFolder?: boolean
}
export type LocalConversationWorkspace = {
  tabs: Array<{
    id: string
    projectId: string | null
    threadId: string
    title: string
    localScope?: LocalConversationScope
    draft?: string
    /** Fingerprint of the native text, used only to reconcile later native edits. */
    draftRevision?: string
  }>
  activeId: string | null
  preferences?: WorkspacePreferencesPatch
}
export type LocalConversationThread = {
  id: string
  title: string
  draft?: boolean
  running: boolean
  archived: boolean
  canContinue: boolean
  harness: string
  mode: 'build' | 'plan'
}
export type LocalConversationAttachment = {
  id: string
  name: string
  kind: string
}
export type LocalConversationQuestion = {
  id: string
  kind: 'questions' | 'plan-approval'
  plan?: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}
export type LocalConversationModels = {
  harness: 'codebuff' | 'claude-code' | 'codex'
  model: string
  effort: ReasoningEffort | null
  /** Native catalog and CLI discovery; never credentials or filesystem paths. */
  catalog: FreebuffModelCatalog | null
  cliModels: Array<{
    id: string
    label: string
    tagline: string
    efforts: readonly ReasoningEffort[]
  }>
  providerLabel?: string
}
export type LocalConversationRuntime = {
  location: 'local' | 'worktree'
  choices: Array<'local' | 'worktree' | 'cloud'>
  locked: boolean
}
export type LocalConversationSnapshot = {
  /** An explicitly imported chat; redirects a stale local tab after a lost response. */
  cloud?: { threadId: string; projectId: string | null }
  runtime?: LocalConversationRuntime
  /** Absent on older Desktop bridges. */
  models?: LocalConversationModels
  thread: LocalConversationThread
  /** Desktop parts are interpreted by the shared transcript renderer, in memory only. */
  messages: Array<{
    seq?: number
    /** Durable input/run identity for reconciling a mirrored Cloud prompt. */
    inputId?: string
    role: 'user' | 'assistant'
    parts: unknown[]
    attachments?: LocalConversationAttachment[]
  }>
  history: {
    firstSeq: number | null
    lastSeq: number | null
    hasOlder: boolean
    hasNewer: boolean
  }
  questions: LocalConversationQuestion[]
  elevations: Array<{ id: string; command: string; reason: string }>
  queued: Array<{ id: string; text: string }>
}
export type LocalConversationRequest =
  | { operation: 'projects'; offset?: number }
  | { operation: 'workspace' }
  | { operation: 'save-workspace'; tabs: string[]; activeId: string | null }
  | { operation: 'threads'; projectId: string; offset?: number }
  | { operation: 'search'; projectId: string; query: string }
  | (LocalConversationScope &
      (
        | { operation: 'read'; before?: number; after?: number }
        | { operation: 'migrate'; priority?: boolean; retry?: boolean }
        | { operation: 'attachment'; attachmentId: string }
      ))
export type LocalConversationResponses = {
  workspace: LocalConversationWorkspace | null
  'save-workspace': { ok: true }
  projects: { projects: LocalConversationProject[]; nextOffset: number | null }
  threads: { threads: LocalConversationThread[]; nextOffset: number | null }
  search: { threadIds: string[]; indexing: boolean }
  migrate: { cloud?: { threadId: string; projectId: string | null }; error?: string; retryable?: false }
  read: LocalConversationSnapshot
  attachment: { dataUrl: string }
}
export type LocalConversationsHost = {
  /** Authenticate the native account/profile before automatically exposing its local history. */
  authorize(): Promise<boolean>
  request<T extends LocalConversationRequest>(
    input: T,
  ): Promise<LocalConversationResponses[T['operation']]>
}
