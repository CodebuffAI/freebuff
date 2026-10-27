import type {
  HostedBrowserDataRequest,
  HostedBrowserDataResponses,
} from './browser-data'

/** The hosted renderer receives selectors and capabilities, never native credentials. */
export const HOSTED_WORKSPACE_PROTOCOL_VERSION = 1 as const
export const HOSTED_WORKSPACE_API_ORIGIN =
  'https://staging-2-api.freebuffweb.site'
export const HOSTED_WORKSPACE_ORIGIN = 'https://staging-2-auth.freebuffweb.site'
/** Exact reviewed pairs: a staging session must never cross into another environment. */
export const HOSTED_WORKSPACE_ENVIRONMENTS = [
  { apiOrigin: HOSTED_WORKSPACE_API_ORIGIN, authOrigin: HOSTED_WORKSPACE_ORIGIN },
  { apiOrigin: 'https://staging-api.freebuff.com', authOrigin: 'https://staging-auth.freebuff.com' },
  { apiOrigin: 'https://www.codebuff.com', authOrigin: 'https://freebuff.com' },
] as const


export type HostedRuntimeProgress = {
  phase: 'preparing' | 'downloading' | 'landing'
  receivedBytes: number
  totalBytes: number | null
}

export type HostedWorkspaceConnection = {
  /** A per-chat checkout does not change the project’s default runtime. */
  threadId?: string
  projectId: string
  projectName: string
  sessionId: string
  bindingId: string
  phase: 'connecting' | 'connected' | 'reconnecting' | 'stopped'
  executionEnabled: boolean
}

export type HostedWorkspaceStatus = {
  /** Local installation receipt, not an account or browser preference. */
  projectSetupCompleted?: boolean
  accountId: string | null
  enabled: boolean
  connections: HostedWorkspaceConnection[]
  /** Previously enrolled projects remain local while their computer is disconnected. */
  localProjects?: Array<{
    projectId: string
    projectName: string
    reconnectStatus?: 'connecting' | 'retrying' | 'needs-approval'
    reconnectMessage?: string
  }>
}

export type HostedWindowState = {
  fullScreen: boolean
  maximized: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type HostedBrowserScope = {
  projectId: string
  threadId: string
  /** Legacy chats use native-issued selectors and never enter Cloud history. */
  source?: 'local-history'
}
export type HostedBrowserViewSettings = {
  zoom: number
  colorScheme: 'system' | 'light' | 'dark'
  viewport: { width: number; height: number } | null
}
export type HostedBrowserTab = {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
  profileId?: string
  incognito?: boolean
  zoom?: number
  colorScheme?: HostedBrowserViewSettings['colorScheme']
  viewport?: HostedBrowserViewSettings['viewport']
  recording?: boolean
  /** Agent requests to reveal its tab; monotonic within this native browser lifetime. */
  reveal?: number
}
export type HostedBrowserSnapshot = {
  tabs: HostedBrowserTab[]
  activeTabId: string | null
  profiles?: Array<{ id: string; name: string }>
  defaults?: HostedBrowserViewSettings & { profileId: string }
  history?: Array<{ url: string; title: string }>
}
export type HostedBrowserAction =
  | { action: 'open'; url?: string; profileId?: string; incognito?: boolean }
  | { action: 'close'; tabId: string }
  | { action: 'select'; tabId: string }
  | { action: 'navigate'; tabId: string; to: string }
  | ({
      action: 'configure'
      tabId: string
    } & Partial<HostedBrowserViewSettings>)
  | { action: 'save-defaults'; tabId: string }
  | { action: 'profile-add'; name: string }
  | { action: 'profile-delete'; profileId: string }
  | {
      action: 'native'
      tabId: string
      command:
        | 'stop'
        | 'hardReload'
        | 'devtools'
        | 'clearCookies'
        | 'clearCache'
        | 'popout'
        | 'recordingStart'
        | 'recordingStop'
        | 'recordingStatus'
    }

export type HostedBrowserLayout = HostedBrowserScope & {
  tabId: string
  /** CSS pixels in the hosted page; null detaches the view without stopping its agent. */
  bounds: { x: number; y: number; width: number; height: number } | null
}

export type HostedTerminalFrame =
  | { type: 'ready'; generation: string; resumeSupported?: true }
  | { type: 'data'; data: string }
  | { type: 'replay-end' }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }

/** Selectors only: the native broker supplies the account, directory and PTY scope. */
export type HostedTerminalRequest = HostedBrowserScope & {
  sessionId: string
} & (
    | { operation: 'attach'; cols?: number; rows?: number; resumeGeneration?: string }
    | { operation: 'read'; viewerId: string }
    | { operation: 'detach'; viewerId: string }
    | { operation: 'input'; viewerId: string; generation: string; data: string }
    | {
        operation: 'resize'
        viewerId: string
        generation: string
        cols: number
        rows: number
      }
    | { operation: 'close' }
  )
export type HostedTerminalResponse = {
  viewerId?: string
  frames?: HostedTerminalFrame[]
  closed?: boolean
}

export type HostedWorkspaceMenuCommand = 'new-tab' | 'close-tab' | 'reopen-tab' | 'open-project' | 'settings' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

export type HostedNativeAgent = {
  harness: 'claude-code' | 'codex'
  installed: boolean
  signedIn?: boolean
  pending?: boolean
  needsUpdate?: boolean
  canInstall: boolean
  models: Array<{ id: string; label: string; tagline: string; efforts?: readonly ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra')[] }>
}
export type HostedNativeAgentsRequest = {
  operation: 'status' | 'recheck' | 'install'
  harness?: 'claude-code' | 'codex'
}

export type HostedWorkspaceHost = {
  nativeAgents?(input: HostedNativeAgentsRequest): Promise<{ agents: HostedNativeAgent[] }>
  /** Answers only a native-issued quit request; never grants a generic IPC capability. */
  quit?: {
    onRequest(listener: (id: number) => void): () => void
    answer(id: number, accepted: boolean): void
  }
  /** Native owns the full approval prompt; commands and directories never enter hosted IPC. */
  elevations?: {
    review(): Promise<void>
  }
  /** Mirrors cloud-managed local work for the native quit confirmation. */
  activity?: {
    report(busy: boolean): Promise<void>
  }
  /** Open a reviewed HTTP(S) authorization link in the system browser. */
  openExternal?(url: string): Promise<void>
  shortcuts?: {
    setBindings(bindings: Record<string, string | null>): Promise<void>
    setRecording(recording: boolean): Promise<void>
    onCommand(listener: (command: HostedWorkspaceMenuCommand) => void): () => void
  }
  appearance?: {
    snapshot(): Promise<{
      accountId: string
      installationId: string
      preferences: unknown
    }>
    wallpaper(source: string): Promise<{ source: string }>
  }

  localConversations?: import('./local-conversations').LocalConversationsHost
  /** This native build understands source-qualified legacy browser/terminal scopes. */
  localHistoryPanels?: true
  files?: import('./hosted-files').HostedFilesHost
  git?: import('./hosted-git').HostedGitHost
  protocolVersion: typeof HOSTED_WORKSPACE_PROTOCOL_VERSION
  platform: string
  launchId?: string
  appVersion: string
  customTitleBar?: boolean
  /** The native window stays hidden until the authenticated workspace has rendered. */
  ready?(): Promise<void>
  /** Discover native run locations or explicitly change a chat’s sandbox. */
  runtime?(scope: {
    projectId: string
    threadId?: string
    location?: 'local' | 'worktree' | 'cloud'
  }): Promise<{
    location: 'local' | 'worktree' | 'cloud'
    choices: Array<'local' | 'worktree' | 'cloud'>
    progress?: HostedRuntimeProgress
  }>
  /** Persist a device-backed cloud chat before a person opens its native panels. */
  prepareLocalChat?(scope: HostedBrowserScope): Promise<HostedBrowserScope>
  terminal?: {
    request(input: HostedTerminalRequest): Promise<HostedTerminalResponse>
  }
  window?: {
    state(): Promise<HostedWindowState>
    action(
      action: 'minimize' | 'maximize' | 'close' | 'back' | 'forward',
    ): Promise<void>
    onState(listener: (state: HostedWindowState) => void): () => void
  }
  browser?: {
    data?<T extends HostedBrowserDataRequest>(
      input: HostedBrowserScope & { tabId: string; request: T },
    ): Promise<HostedBrowserDataResponses[T['action']]>
    snapshot(scope: HostedBrowserScope): Promise<HostedBrowserSnapshot>
    action(
      request: HostedBrowserScope & { action: HostedBrowserAction },
    ): Promise<HostedBrowserSnapshot>
    layout(request: HostedBrowserLayout): Promise<void>
    onChanged?(
      listener: (
        scope: HostedBrowserScope,
        snapshot: HostedBrowserSnapshot,
      ) => void,
    ): () => void
    onFocusAddress?(
      listener: (scope: HostedBrowserScope, tabId: string) => void,
    ): () => void
  }
  /** Save first-project completion on this Desktop installation only. */
  completeProjectSetup?(): Promise<void>
  /** A selected project may connect its known local folder; no other folder is enrolled. */
  status(projectId?: string): Promise<HostedWorkspaceStatus>
  openLocalProject(): Promise<HostedWorkspaceConnection | null>
  disconnect(sessionId: string): Promise<void>
  /** Clears native credentials and the hosted browser session together. */
  signOut?(): Promise<void>
  returnToDesktop(): Promise<void>
}

/** Capability detection is presentation only; native IPC checks its sender/account. */
export function hostedWorkspaceHost(
  value: unknown,
): HostedWorkspaceHost | null {
  if (!value || typeof value !== 'object') return null
  const host = value as Partial<HostedWorkspaceHost>
  return host.protocolVersion === HOSTED_WORKSPACE_PROTOCOL_VERSION &&
    typeof host.platform === 'string' &&
    typeof host.appVersion === 'string' &&
    ['status', 'openLocalProject', 'disconnect', 'returnToDesktop'].every(
      (name) => typeof host[name as keyof HostedWorkspaceHost] === 'function',
    )
    ? (host as HostedWorkspaceHost)
    : null
}
