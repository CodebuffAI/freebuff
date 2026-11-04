/**
 * The two faces of the Freebuff workspace (web and hosted Desktop).
 *
 * `code` is the coding-agent product: local and cloud projects, terminals,
 * split panes, GitHub, templates, Sites controls and the full model catalog.
 *
 * `chat` is the cloud-only product for people who are not developers: plain
 * chats, simple cloud projects started from scratch (with the files the user
 * drops in), a one-row composer, a Files/Browser-only right panel and one
 * model name ("Freebuff 1.5") whose slider stops stand for the three presets.
 *
 * A chat belongs to a mode through its project: a cloud chat without a
 * project is a Chat-mode chat (Code mode has no standalone chats any more),
 * a project's chats take the project's mode, and a chat bound to one of the
 * user's computers (device execution) is always Code mode. A project's mode
 * is set once, at creation, and lives in the server-owned part of its
 * settings (`settings->>'mode'`); absent means `code`, which is what every
 * project created before modes existed is.
 */
export type WorkspaceMode = 'code' | 'chat'

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ['code', 'chat']

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'code'

export const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  code: 'Code',
  chat: 'Chat',
}

/**
 * What the Chat-mode composer calls the model. Switching the slider changes
 * the preset (and so the model and effort underneath), never this name.
 */
export const CHAT_MODE_MODEL_LABEL = 'Freebuff 1.5'

/**
 * Where a Chat-mode project's uploaded files live inside each chat's workspace
 * (`/workspace/files/…`), so the agent's ordinary file tools and the Files
 * panel both see them.
 */
export const PROJECT_FILES_DIR = 'files'

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === 'code' || value === 'chat'
}

/** A project's mode; anything unrecognised (older servers) is Code. */
export function projectWorkspaceMode(
  project: { mode?: string | null } | null | undefined,
): WorkspaceMode {
  return project?.mode === 'chat' ? 'chat' : 'code'
}

/**
 * The mode a chat (or an unsent draft) belongs to, given its project. A
 * projectless chat is Chat mode; a device-bound chat is Code mode whatever
 * its project says.
 */
export function chatWorkspaceMode(
  chat: { projectId: string | null; deviceExecution?: unknown },
  project: { mode?: string | null; deviceExecution?: unknown } | null | undefined,
): WorkspaceMode {
  if (chat.deviceExecution) return 'code'
  if (chat.projectId === null) return 'chat'
  if (project?.deviceExecution) return 'code'
  return projectWorkspaceMode(project)
}
