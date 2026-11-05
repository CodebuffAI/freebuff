/** Shared history and attachment contract for the Postgres-backed Cloud service. */
export type CloudHistoryPage<T> = { items: T[]; nextCursor: string | null }
export type CloudHistoryProject = {
  /** A durable local target; absence means a hosted project. Never inferred from presence. */
  deviceExecution?: import('./device-execution').DeviceExecutionTarget | null
  id: string
  name: string
  createdAt: string
  github?: import('./github').GitHubRepository | null
  /** The starter selected at project creation; absent from older servers. */
  template?: import('../templates/selected').SelectedTemplate | null
  /**
   * When the user removed it from their project list, or null. A removed project is left out of
   * `listProjects` until someone prompts in it again. Absent from older servers.
   */
  removedAt?: string | null
  /**
   * Which workspace the project belongs to (workspace-mode.ts). Set at creation; absent or null
   * from older servers and for every project created before modes existed, both meaning Code.
   */
  mode?: import('./workspace-mode').WorkspaceMode | null
}
export type CloudHistoryRun = {
  id: string
  chatId: string
  status: string
  model: string | null
  /** Claude Code or Codex ran this turn (`./agents`); absent for the Freebuff agent and older servers. */
  agent?: import('./agents').CloudCliAgent | null
  agentMode: 'plan' | 'build'
  effort: string | null
  promptPreview: string
  createdAt: string
  finishedAt: string | null
  error: string | null
  /** Since when this turn has been waiting for the computer it runs on to wake or reconnect;
   * null when it is not. Absent from older servers. */
  waitingForDeviceSince?: string | null
  /** A queued turn's sibling chat running in the same folder, which it usually waits for;
   * null when there is none. `title` is null for an untitled chat. Absent from older servers. */
  waitingForChat?: { id: string; title: string | null } | null
}
/** A chat's `title` while it has neither a title nor a first run to name it (history-store.ts). */
export const UNTITLED_CLOUD_CHAT_TITLE = 'Cloud chat'
export type CloudHistoryChat = {
  deviceExecution?: import('./device-execution').DeviceExecutionTarget | null
  mission?: import('./mission').CloudMission | null
  /** The chat this one was forked from (the sidebar nests it there), or null. Absent from older servers. */
  forkedFrom?: string | null
  id: string
  projectId: string | null
  title: string
  archivedAt: string | null
  /** Continue locally (COD-878): when the chat moved to a computer, or null. Absent from older servers. */
  handedBackAt?: string | null
  /** Cloud cannot bring this archived chat's files back, but Desktop can land their export. */
  localRestoreRequired?: boolean
  metadataRevision: number
  phase: string
  updatedAt: string
  lastActiveAt: string
  latestRun: CloudHistoryRun | null
  /** The sidebar "finished" dot, shared by every device. Absent from older servers. */
  attention?: CloudHistoryAttention
  /**
   * The chat's session claim, the attachment's `instanceId`: a Desktop purchase this chat
   * holds names it as `holderInstanceId`. Empty when it has none. Absent from older servers.
   */
  instanceId?: string
}
/**
 * Each settled run raises `revision`; opening the chat on any device acknowledges through it.
 * Both only increase, so a stale read or a retried acknowledgement never undoes a newer one.
 */
export type CloudHistoryAttention = {
  revision: number
  acknowledgedRevision: number
  reason: 'finished' | 'failed' | 'stopped' | null
  at: string | null
}
export type CloudHistoryAttentionAck = { throughRevision: number }
/** Attaching observes the existing session; it never admits or purchases one. */
export type CloudHistoryAttachment = {
  chat: CloudHistoryChat
  instanceId: string
  session: {
    model: string
    admittedAt: string
    expiresAt: string | null
  } | null
}
export type CloudHistoryChatUpdate = {
  expectedRevision: number
  title?: string
  archived?: boolean
}
/**
 * Fork a chat on the computer it runs on: a new chat with its transcript, attachments and agent
 * session, holding no Freebuff session of its own until it is sent to. `chatId` is the new chat's
 * id, minted by the client and reused on a retry so the fork is created once.
 */
export type CloudHistoryChatFork = { chatId: string }
/**
 * Roll a Freebuff chat back to before one of its messages: that run and every later one leave the
 * conversation, and the agent forgets them. Files those turns changed are not restored.
 */
export type CloudHistoryChatRollback = { runId: string }
export type CloudHistoryChatRolledBack = {
  chat: CloudHistoryChat
  /** `cut`: the agent's memory now ends before the message; `note`: it was told to disregard them. */
  mode: 'cut' | 'note' | 'unchanged'
}
/**
 * Last write wins: a project name has no revision to compare. Removing keeps its chats and files;
 * `removed: false` puts it back in the list.
 */
export type CloudHistoryProjectUpdate =
  | { name: string; removed?: boolean }
  | { name?: string; removed: boolean }
/**
 * A server-internal run event marking that the run's SDK traces are stored in
 * R2 rather than as `trace` events. Never returned by the history API or the
 * live poll.
 */
export const TRACES_IN_R2_KIND = 'traces_r2'
export type CloudHistoryEvent = {
  /** Decimal string: Postgres bigint IDs can exceed JavaScript's safe integer. */
  id: string
  runId: string
  kind: string
  payload: unknown
  createdAt: string
}
export type CloudHistoryEvents = CloudHistoryPage<CloudHistoryEvent> & {
  /** Resume after the last returned event, even when nextCursor is null. */
  endCursor: string | null
}
export type CloudHistoryOptions = {
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}

export class CloudHistoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CloudHistoryError'
  }
}

/**
 * Sent by every bearer client that can open a chat running on a computer
 * (`deviceExecution`). Desktop 0.0.192 and older sent no such header and can
 * only open hosted chats, so the chat list omits device chats for a direct
 * bearer request without it (`web/src/server/desktop-cloud/history-api.ts`).
 */
export const CLOUD_HISTORY_DEVICE_CHATS_HEADER = 'x-freebuff-device-chats'

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  [CLOUD_HISTORY_DEVICE_CHATS_HEADER]: '1',
})

/** Cookie auth on the same origin, or the existing Desktop session bearer. */
export function createCloudHistoryClient(
  options: {
    baseUrl?: string
    getToken?: () => string | null | Promise<string | null>
    fetch?: (url: string, init?: RequestInit) => Promise<Response>
  } = {},
) {
  const base = (options.baseUrl ?? '/api/v1/cloud/history').replace(/\/$/, '')
  async function get<T>(
    path: string,
    page: CloudHistoryOptions = {},
    projectId?: string,
    update?: CloudHistoryChatUpdate | CloudHistoryProjectUpdate | CloudHistoryChatFork | CloudHistoryChatRollback | CloudHistoryAttentionAck,
    search?: string,
    method: 'GET' | 'PATCH' | 'POST' = update ? 'PATCH' : 'GET',
  ): Promise<T> {
    const query = new URLSearchParams()
    if (search) query.set('search', search)
    if (page.cursor != null) query.set('cursor', page.cursor)
    if (page.limit !== undefined) query.set('limit', String(page.limit))
    if (projectId !== undefined) query.set('projectId', projectId)
    const token = await options.getToken?.()
    const res = await (options.fetch ?? fetch)(
      `${base}/${path}${query.size ? `?${query}` : ''}`,
      {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: page.signal,
        method,
        body: update ? JSON.stringify(update) : undefined,
        headers: update
          ? {
              'Content-Type': 'application/json',
              ...(token ? bearer(token) : {}),
            }
          : token
            ? bearer(token)
            : undefined,
      },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new CloudHistoryError(
        res.status,
        body?.error ?? 'Cloud history unavailable',
      )
    }
    return res.json() as Promise<T>
  }
  const id = encodeURIComponent
  return {
    listProjects: (page?: CloudHistoryOptions) =>
      get<CloudHistoryPage<CloudHistoryProject>>('projects', page),
    getProject: (projectId: string, signal?: AbortSignal) =>
      get<CloudHistoryProject>(`projects/${id(projectId)}`, { signal }),
    updateProject: (
      projectId: string,
      update: CloudHistoryProjectUpdate,
      signal?: AbortSignal,
    ) =>
      get<CloudHistoryProject>(
        `projects/${id(projectId)}`,
        { signal },
        undefined,
        update,
      ),
    listChats: (page: CloudHistoryOptions & { projectId?: string; search?: string } = {}) =>
      get<CloudHistoryPage<CloudHistoryChat>>('chats', page, page.projectId, undefined, page.search),
    getChat: (chatId: string, signal?: AbortSignal) =>
      get<CloudHistoryChat>(`chats/${id(chatId)}`, { signal }),
    forkChat: (chatId: string, fork: CloudHistoryChatFork, signal?: AbortSignal) =>
      get<CloudHistoryChat>(`chats/${id(chatId)}/fork`, { signal }, undefined, fork, undefined, 'POST'),
    rollbackChat: (chatId: string, rollback: CloudHistoryChatRollback, signal?: AbortSignal) =>
      get<CloudHistoryChatRolledBack>(`chats/${id(chatId)}/rollback`, { signal }, undefined, rollback, undefined, 'POST'),
    getAttachment: (chatId: string, signal?: AbortSignal) =>
      get<CloudHistoryAttachment>(`chats/${id(chatId)}/attachment`, { signal }),
    updateChat: (
      chatId: string,
      update: CloudHistoryChatUpdate,
      signal?: AbortSignal,
    ) =>
      get<CloudHistoryChat>(
        `chats/${id(chatId)}`,
        { signal },
        undefined,
        update,
      ),
    acknowledgeAttention: (
      chatId: string,
      throughRevision: number,
      signal?: AbortSignal,
    ) =>
      get<CloudHistoryChat>(
        `chats/${id(chatId)}/attention`,
        { signal },
        undefined,
        { throughRevision },
      ),
    listRuns: (chatId: string, page?: CloudHistoryOptions) =>
      get<CloudHistoryPage<CloudHistoryRun>>(`chats/${id(chatId)}/runs`, page),
    getRun: (runId: string, signal?: AbortSignal) =>
      get<CloudHistoryRun>(`runs/${id(runId)}`, { signal }),
    listEvents: (runId: string, page?: CloudHistoryOptions) =>
      get<CloudHistoryEvents>(`runs/${id(runId)}/events`, page),
    listTraces: (runId: string, page?: CloudHistoryOptions) =>
      get<CloudHistoryEvents>(`runs/${id(runId)}/traces`, page),
    /** Whether this account may use Freebuff Projects (admins and an allowlist). */
    getProjectsAccess: (signal?: AbortSignal) =>
      get<{ allowed: boolean }>('projects-access', { signal }),
  }
}
