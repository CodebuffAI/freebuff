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
}
export type CloudHistoryChat = {
  deviceExecution?: import('./device-execution').DeviceExecutionTarget | null
  mission?: import('./mission').CloudMission | null
  id: string
  projectId: string | null
  title: string
  archivedAt: string | null
  /** Continue locally (COD-878): when the chat moved to a computer, or null. Absent from older servers. */
  handedBackAt?: string | null
  /** Archived Cloud files must land on this computer before another run. */
  localRestoreRequired?: boolean
  metadataRevision: number
  phase: string
  updatedAt: string
  lastActiveAt: string
  latestRun: CloudHistoryRun | null
}
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
    update?: CloudHistoryChatUpdate | CloudHistoryProjectUpdate,
    search?: string,
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
        method: update ? 'PATCH' : 'GET',
        body: update ? JSON.stringify(update) : undefined,
        headers: update
          ? {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            }
          : token
            ? { Authorization: `Bearer ${token}` }
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
