import { isRetryableStatusCode, getErrorStatusCode } from '@codebuff/sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { Chat } from './chat'
import { ChatHistoryScreen } from './components/chat-history-screen'
import { UndoHistoryScreen } from './components/undo-history-screen'
import { ChatRuntimeProvider } from './contexts/chat-runtime-context'
import { FreebuffSupersededScreen } from './components/freebuff-superseded-screen'
import { LoginModal } from './components/login-modal'
import { ProjectPickerScreen } from './components/project-picker-screen'
import { FreebuffLandingScreen } from './components/freebuff-landing-screen'
import { useAuthQuery } from './hooks/use-auth-query'
import { useAuthState } from './hooks/use-auth-state'
import { useFreebuffSession } from './hooks/use-freebuff-session'
import { useTerminalFocus } from './hooks/use-terminal-focus'
import { getCurrentChatId, getProjectRoot, startNewChat } from './project-files'
import { useChatHistoryStore } from './state/chat-history-store'
import { useUndoHistoryStore } from './state/undo-history-store'
import { redoToRecord, undoToRecord } from './state/undo-store'
import { stopActiveRun } from './utils/active-run'
import { useChatStore } from './state/chat-store'
import { getSystemMessage } from './utils/message-history'
import type { TopBannerType } from './types/store'
import { IS_FREEBUFF } from './utils/constants'
import { findGitRoot } from './utils/git'

import type { MultilineInputHandle } from './components/multiline-input'
import type { AgentMode } from './utils/constants'
import type { AuthStatus } from './utils/status-indicator-state'
import type { FileTreeNode } from '@codebuff/common/util/file'

interface AppProps {
  initialPrompt: string | null
  agentId?: string
  requireAuth: boolean | null
  hasInvalidCredentials: boolean
  fileTree: FileTreeNode[]
  continueChat: boolean
  continueChatId?: string
  initialMode?: AgentMode
  showProjectPicker: boolean
  onProjectChange: (projectPath: string) => void
}

export const App = ({
  initialPrompt,
  agentId,
  requireAuth,
  hasInvalidCredentials,
  fileTree,
  continueChat,
  continueChatId,
  initialMode,
  showProjectPicker,
  onProjectChange,
}: AppProps) => {
  const inputRef = useRef<MultilineInputHandle | null>(null)
  const initialPromptConsumedRef = useRef(false)
  const consumeInitialPrompt = useCallback(() => {
    if (!initialPrompt || initialPromptConsumedRef.current) {
      return null
    }
    initialPromptConsumedRef.current = true
    return initialPrompt
  }, [initialPrompt])
  const {
    setInputFocused,
    setIsFocusSupported,
    resetChatStore,
    activeTopBanner,
    setActiveTopBanner,
    closeTopBanner,
    chatSessionId,
  } = useChatStore(
    useShallow((store) => ({
      setInputFocused: store.setInputFocused,
      setIsFocusSupported: store.setIsFocusSupported,
      resetChatStore: store.reset,
      activeTopBanner: store.activeTopBanner,
      setActiveTopBanner: store.setActiveTopBanner,
      closeTopBanner: store.closeTopBanner,
      chatSessionId: store.chatSessionId,
    })),
  )

  // Wrap in useCallback to prevent re-subscribing on every render
  const handleSupportDetected = useCallback(() => {
    setIsFocusSupported(true)
  }, [setIsFocusSupported])

  // Enable terminal focus detection to stop cursor blinking when window loses focus
  // Cursor starts visible but not blinking; blinking enabled once terminal support confirmed
  useTerminalFocus({
    onFocusChange: setInputFocused,
    onSupportDetected: handleSupportDetected,
  })

  // Get auth query for network status tracking
  const authQuery = useAuthQuery()

  const {
    isAuthenticated,
    setIsAuthenticated,
    setUser,
    handleLoginSuccess,
    logoutMutation,
  } = useAuthState({
    requireAuth,
    inputRef,
    setInputFocused,
    resetChatStore,
  })

  const projectRoot = getProjectRoot()
  const gitRoot = useMemo(
    () => findGitRoot({ cwd: projectRoot }),
    [projectRoot],
  )
  const showGitRootBanner = Boolean(gitRoot && gitRoot !== projectRoot)
  const [gitRootBannerDismissed, setGitRootBannerDismissed] = useState(false)
  const prevTopBannerRef = useRef<TopBannerType | null>(null)

  useEffect(() => {
    setGitRootBannerDismissed(false)
  }, [projectRoot])

  useEffect(() => {
    const prevBanner = prevTopBannerRef.current
    if (
      prevBanner === 'gitRoot' &&
      activeTopBanner === null &&
      showGitRootBanner
    ) {
      setGitRootBannerDismissed(true)
    }
    prevTopBannerRef.current = activeTopBanner
  }, [activeTopBanner, showGitRootBanner])

  useEffect(() => {
    if (!showGitRootBanner) {
      if (activeTopBanner === 'gitRoot') {
        closeTopBanner()
      }
      return
    }
    if (!gitRootBannerDismissed && activeTopBanner === null) {
      setActiveTopBanner('gitRoot')
    }
  }, [
    activeTopBanner,
    closeTopBanner,
    gitRootBannerDismissed,
    setActiveTopBanner,
    showGitRootBanner,
  ])

  const handleSwitchToGitRoot = useCallback(() => {
    if (gitRoot) {
      onProjectChange(gitRoot)
    }
  }, [gitRoot, onProjectChange])

  // Chat history state from store
  const { showChatHistory, closeChatHistory } = useChatHistoryStore()

  const {
    showUndoHistory,
    closeUndoHistory,
    showRedoHistory,
    closeRedoHistory,
  } = useUndoHistoryStore()

  // State to track which chat to resume (set when user selects from history)
  const [resumeChatId, setResumeChatId] = useState<string | null>(null)

  const handleResumeChat = useCallback(
    (chatId: string) => {
      // Abort any in-flight run BEFORE resetting the store and switching
      // chats: an orphaned run would keep checkpointing, and its writes could
      // land in the resumed chat's directory, overwriting that transcript.
      stopActiveRun('history-resume')
      closeChatHistory()
      // Reset chat store to clear previous messages before loading the selected chat
      resetChatStore()
      setResumeChatId(chatId)
    },
    [closeChatHistory, resetChatStore],
  )

  const handleNewChat = useCallback(() => {
    stopActiveRun('new-chat')
    closeChatHistory()
    resetChatStore()
    // Rotate the chat id so the new conversation saves to its own directory
    // instead of overwriting the current (possibly resumed) chat's history
    startNewChat()
    setResumeChatId(null)
  }, [closeChatHistory, resetChatStore])

  // Undo/redo pickers: revert (or restore) the selected record against the
  // project, then surface the result as a system message in the current chat.
  const handleUndoSelect = useCallback(
    async (recordId: string) => {
      stopActiveRun('undo-history')
      closeUndoHistory()
      try {
        const message =
          (await undoToRecord(getCurrentChatId(), projectRoot, recordId)) ??
          'Could not undo — the snapshot store is unavailable.'
        useChatStore.getState().setMessages((prev) => [
          ...prev,
          getSystemMessage(message, { commandResult: 'undo' }),
        ])
      } catch (error) {
        useChatStore.getState().setMessages((prev) => [
          ...prev,
          getSystemMessage('Could not undo the selected change.', {
            commandResult: 'undo',
          }),
        ])
      }
      setInputFocused(true)
    },
    [closeUndoHistory, projectRoot, setInputFocused],
  )

  const handleRedoSelect = useCallback(
    async (recordId: string) => {
      stopActiveRun('redo-history')
      closeRedoHistory()
      try {
        const message =
          (await redoToRecord(getCurrentChatId(), projectRoot, recordId)) ??
          'Could not redo — the snapshot store is unavailable.'
        useChatStore.getState().setMessages((prev) => [
          ...prev,
          getSystemMessage(message, { commandResult: 'redo' }),
        ])
      } catch (error) {
        useChatStore.getState().setMessages((prev) => [
          ...prev,
          getSystemMessage('Could not redo the selected change.', {
            commandResult: 'redo',
          }),
        ])
      }
      setInputFocused(true)
    },
    [closeRedoHistory, projectRoot, setInputFocused],
  )

  const handleCancelUndoHistory = useCallback(() => {
    closeUndoHistory()
    setInputFocused(true)
  }, [closeUndoHistory, setInputFocused])

  const handleCancelRedoHistory = useCallback(() => {
    closeRedoHistory()
    setInputFocused(true)
  }, [closeRedoHistory, setInputFocused])

  // Determine effective continueChat values
  const effectiveContinueChat = continueChat || resumeChatId !== null
  const effectiveContinueChatId = resumeChatId ?? continueChatId

  // Derive auth reachability + retrying state from authQuery error
  const authError = authQuery.error
  const authErrorStatusCode = authError
    ? getErrorStatusCode(authError)
    : undefined

  let authStatus: AuthStatus = 'ok'
  if (authQuery.isError && authErrorStatusCode !== undefined) {
    if (isRetryableStatusCode(authErrorStatusCode)) {
      // Retryable errors (408 timeout, 429 rate limit, 5xx server errors)
      authStatus = 'retrying'
    } else if (authErrorStatusCode >= 500) {
      // Non-retryable server errors (unlikely but possible future codes)
      authStatus = 'unreachable'
    }
    // 4xx client errors (401, 403, etc.) keep 'ok' - network is fine, just auth failed
  }

  // Render project picker FIRST when at home directory or outside a project.
  // This deliberately precedes the login/auth and free-session gates so the
  // user always gets to pick a working directory before anything else — auth
  // failures or a banned freebuff session would otherwise replace the
  // picker mid-flash and look like being kicked out of the app.
  if (showProjectPicker) {
    return (
      <ProjectPickerScreen
        onSelectProject={onProjectChange}
        initialPath={projectRoot}
      />
    )
  }

  // Render login modal when not authenticated AND auth service is reachable
  // Don't show login modal during network outages OR while retrying
  if (
    requireAuth !== null &&
    isAuthenticated === false &&
    authStatus === 'ok'
  ) {
    return (
      <LoginModal
        onLoginSuccess={handleLoginSuccess}
        hasInvalidCredentials={hasInvalidCredentials}
      />
    )
  }

  // Reset the runtime only when the active chat identity changes. View-only
  // routes such as history and session gates keep the same key.
  return (
    <AuthedSurface
      runtimeKey={chatSessionId}
      consumeInitialPrompt={consumeInitialPrompt}
      agentId={agentId}
      fileTree={fileTree}
      inputRef={inputRef}
      setIsAuthenticated={setIsAuthenticated}
      setUser={setUser}
      logoutMutation={logoutMutation}
      continueChat={effectiveContinueChat}
      continueChatId={effectiveContinueChatId}
      authStatus={authStatus}
      initialMode={initialMode}
      gitRoot={gitRoot}
      onSwitchToGitRoot={handleSwitchToGitRoot}
      showChatHistory={showChatHistory}
      onSelectChat={handleResumeChat}
      onCancelChatHistory={closeChatHistory}
      onNewChat={handleNewChat}
      showUndoHistory={showUndoHistory}
      onUndoSelect={handleUndoSelect}
      onCancelUndoHistory={handleCancelUndoHistory}
      showRedoHistory={showRedoHistory}
      onRedoSelect={handleRedoSelect}
      onCancelRedoHistory={handleCancelRedoHistory}
    />
  )
}

interface AuthedSurfaceProps {
  runtimeKey: string
  consumeInitialPrompt: () => string | null
  agentId?: string
  fileTree: FileTreeNode[]
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  setIsAuthenticated: React.Dispatch<React.SetStateAction<boolean | null>>
  setUser: React.Dispatch<
    React.SetStateAction<import('./utils/auth').User | null>
  >
  logoutMutation: ReturnType<typeof useAuthState>['logoutMutation']
  continueChat: boolean
  continueChatId: string | undefined
  authStatus: AuthStatus
  initialMode: AgentMode | undefined
  gitRoot: string | null | undefined
  onSwitchToGitRoot: () => void
  showChatHistory: boolean
  onSelectChat: (chatId: string) => void
  onCancelChatHistory: () => void
  onNewChat: () => void
  showUndoHistory: boolean
  onUndoSelect: (recordId: string) => void
  onCancelUndoHistory: () => void
  showRedoHistory: boolean
  onRedoSelect: (recordId: string) => void
  onCancelRedoHistory: () => void
}

/**
 * Rendered only after auth is confirmed. Owns the freebuff session gate
 * so `useFreebuffSession` runs exactly once per authed session (not before
 * we have a token).
 */
const AuthedSurface = (props: AuthedSurfaceProps) => {
  const { session, failure: sessionFailure } = useFreebuffSession()

  return (
    <ChatRuntimeProvider
      key={props.runtimeKey}
      agentId={props.agentId}
      inputRef={props.inputRef}
      continueChat={props.continueChat}
      continueChatId={props.continueChatId}
    >
      <AuthedSurfaceRoutes
        {...props}
        session={session}
        sessionFailure={sessionFailure}
      />
    </ChatRuntimeProvider>
  )
}

const AuthedSurfaceRoutes = ({
  consumeInitialPrompt,
  fileTree,
  inputRef,
  setIsAuthenticated,
  setUser,
  logoutMutation,
  authStatus,
  initialMode,
  gitRoot,
  onSwitchToGitRoot,
  showChatHistory,
  onSelectChat,
  onCancelChatHistory,
  onNewChat,
  showUndoHistory,
  onUndoSelect,
  onCancelUndoHistory,
  showRedoHistory,
  onRedoSelect,
  onCancelRedoHistory,
  session,
  sessionFailure,
}: AuthedSurfaceProps & {
  session: ReturnType<typeof useFreebuffSession>['session']
  sessionFailure: ReturnType<typeof useFreebuffSession>['failure']
}) => {
  // Terminal state: a 409 from the gate means another CLI rotated our
  // instance id. Show a dedicated screen and stop polling — don't fall back
  // into the pre-chat screen, which would look like normal startup progress.
  if (IS_FREEBUFF && session?.status === 'superseded') {
    return <FreebuffSupersededScreen />
  }

  // Route every non-admitted state through the pre-chat screen:
  //   null     → initial GET in flight (brief)
  //   'none'   → no seat yet; show model-picker landing
  //   'country_blocked' → terminal region-gate message
  //   'banned' → terminal account-banned message
  //   'rate_limited' → hit shared session quota; terminal for this run
  //   'spend_limited' → daily provider-spend budget; return after reset
  //   'ip_capped' → too many distinct users active on this egress IP
  //   'takeover_prompt' → another local CLI already holds this account
  //
  // 'ended' deliberately falls through to <Chat>: the agent may still be
  // finishing work under the server-side grace period, and the chat surface
  // itself swaps the input box for the session-ended banner.
  if (
    IS_FREEBUFF &&
    (session === null ||
      session.status === 'none' ||
      session.status === 'country_blocked' ||
      session.status === 'banned' ||
      session.status === 'rate_limited' ||
      session.status === 'spend_limited' ||
      session.status === 'ip_capped' ||
      session.status === 'takeover_prompt')
  ) {
    return <FreebuffLandingScreen session={session} failure={sessionFailure} />
  }

  // Chat history renders inside AuthedSurface so the freebuff session stays
  // mounted while the user browses history. Unmounting this surface would
  // DELETE the session row and drop the user back onto the landing screen on
  // return.
  if (showChatHistory) {
    return (
      <ChatHistoryScreen
        onSelectChat={onSelectChat}
        onCancel={onCancelChatHistory}
        onNewChat={onNewChat}
      />
    )
  }

  if (showUndoHistory) {
    return (
      <UndoHistoryScreen
        mode="undo"
        onSelect={onUndoSelect}
        onCancel={onCancelUndoHistory}
      />
    )
  }

  if (showRedoHistory) {
    return (
      <UndoHistoryScreen
        mode="redo"
        onSelect={onRedoSelect}
        onCancel={onCancelRedoHistory}
      />
    )
  }

  return (
    <Chat
      consumeInitialPrompt={consumeInitialPrompt}
      fileTree={fileTree}
      inputRef={inputRef}
      setIsAuthenticated={setIsAuthenticated}
      setUser={setUser}
      logoutMutation={logoutMutation}
      authStatus={authStatus}
      initialMode={initialMode}
      gitRoot={gitRoot}
      onSwitchToGitRoot={onSwitchToGitRoot}
      freebuffSession={session}
    />
  )
}
