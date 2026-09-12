import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { runTerminalCommand } from '@codebuff/sdk'


import {
  dispatchSkillPrompt,
  findCommand,
  sendOrQueuePrompt,
  type RouterParams,
  type CommandResult,
} from './command-registry'
import {
  isSlashCommand,
  parseCommandInput,
} from './router-utils'
import { buildInterviewPrompt, buildPlanPrompt, buildReviewPrompt } from './prompt-builders'
import { getProjectRoot } from '../project-files'
import { useChatStore } from '../state/chat-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import { trackEvent } from '../utils/analytics'
import {
  buildBashHistoryMessages,
  createRunTerminalToolResult,
} from '../utils/bash-messages'
import { showClipboardMessage } from '../utils/clipboard'
import { IS_FREEBUFF } from '../utils/constants'
import { getSystemProcessEnv } from '../utils/env'
import { terminalCommandBroker } from '../utils/terminal-command-broker'
import { getSystemMessage, getUserMessage } from '../utils/message-history'
import { getSkillByName } from '../utils/skill-registry'
import { pushSteeringMessage } from '../utils/steering-buffer'
import {
  capturePendingAttachments,
  hasProcessingFiles,
  hasProcessingImages,
  validateAndAddImage,
} from '../utils/pending-attachments'

/**
 * Run a bash command with automatic ghost/direct mode selection.
 * Uses ghost mode when streaming or chain in progress, otherwise adds directly to chat history.
 */
export function runBashCommand(command: string) {
  const {
    streamingAgents,
    isChainInProgress,
    setMessages,
    addPendingBashMessage,
    updatePendingBashMessage,
  } = useChatStore.getState()

  const ghost = streamingAgents.size > 0 || isChainInProgress
  const id = crypto.randomUUID()
  const commandCwd = process.cwd()
  const startTime = Date.now()

  if (ghost) {
    // Ghost mode: add to pending messages
    addPendingBashMessage({
      id,
      command,
      stdout: '',
      stderr: '',
      exitCode: 0,
      isRunning: true,
      startTime: Date.now(),
      cwd: commandCwd,
    })
  } else {
    // Direct mode: add to chat history with placeholder output (user + assistant)
    const { assistantMessage } = buildBashHistoryMessages({
      command,
      cwd: commandCwd,
      toolCallId: id,
      output: '...',
    })
    setMessages((prev) => [...prev, assistantMessage])
  }

  runTerminalCommand({
    command,
    process_type: 'SYNC',
    cwd: commandCwd,
    timeout_seconds: -1,
    env: getSystemProcessEnv(),
    terminalCommandBroker,
  })
    .then(([{ value }]) => {
      const stdout = 'stdout' in value ? value.stdout || '' : ''
      const stderr = 'stderr' in value ? value.stderr || '' : ''
      const exitCode = 'exitCode' in value ? value.exitCode ?? 0 : 0

      // Track terminal command completion
      const durationMs = Date.now() - startTime
      trackEvent(AnalyticsEvent.TERMINAL_COMMAND_COMPLETED, {
        command: command.split(' ')[0], // Just the command name, not args
        exitCode,
        success: exitCode === 0,
        ghost,
        durationMs,
        hasStdout: stdout.length > 0,
        hasStderr: stderr.length > 0,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      })

      if (ghost) {
        updatePendingBashMessage(id, {
          stdout,
          stderr,
          exitCode,
          isRunning: false,
        })
      } else {
        const toolResultOutput = createRunTerminalToolResult({
          command,
          cwd: commandCwd,
          stdout: stdout || null,
          stderr: stderr || null,
          exitCode,
        })
        const outputJson = JSON.stringify(toolResultOutput)

        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.blocks) return msg
            let didUpdate = false
            const blocks = msg.blocks.map((block) => {
              if ('toolCallId' in block && block.toolCallId === id) {
                didUpdate = true
                return { ...block, output: outputJson }
              }
              return block
            })
            return didUpdate ? { ...msg, blocks, isComplete: true } : msg
          }),
        )

        // Also add to pending bash messages so the next user message includes this context for the LLM
        // Mark as already added to history to avoid duplicate UI entries
        addPendingBashMessage({
          id,
          command,
          stdout,
          stderr,
          exitCode,
          isRunning: false,
          cwd: commandCwd,
          addedToHistory: true,
        })
      }
    })
    .catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      // Track terminal command completion with error
      const durationMs = Date.now() - startTime
      trackEvent(AnalyticsEvent.TERMINAL_COMMAND_COMPLETED, {
        command: command.split(' ')[0], // Just the command name, not args
        exitCode: 1,
        success: false,
        ghost,
        durationMs,
        hasStdout: false,
        hasStderr: true,
        stdoutLength: 0,
        stderrLength: errorMessage.length,
        isException: true,
      })

      if (ghost) {
        updatePendingBashMessage(id, {
          stdout: '',
          stderr: errorMessage,
          exitCode: 1,
          isRunning: false,
        })
      } else {
        const errorToolResultOutput = createRunTerminalToolResult({
          command,
          cwd: commandCwd,
          stdout: null,
          stderr: null,
          exitCode: 1,
          errorMessage,
        })
        const errorOutputJson = JSON.stringify(errorToolResultOutput)

        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.blocks) return msg
            let didUpdate = false
            const blocks = msg.blocks.map((block) => {
              if ('toolCallId' in block && block.toolCallId === id) {
                didUpdate = true
                return { ...block, output: errorOutputJson }
              }
              return block
            })
            return didUpdate ? { ...msg, blocks, isComplete: true } : msg
          }),
        )

        // Also add to pending bash messages so the next user message includes this context for the LLM
        // Mark as already added to history to avoid duplicate UI entries
        addPendingBashMessage({
          id,
          command,
          stdout: '',
          stderr: errorMessage,
          exitCode: 1,
          isRunning: false,
          cwd: commandCwd,
          addedToHistory: true,
        })
      }
    })
}

/**
 * Add a completed bash command result to the chat message history.
 * Note: This is UI-only; we no longer send these commands to the AI context.
 */
export function addBashMessageToHistory(params: {
  command: string
  stdout: string
  stderr: string | null
  exitCode: number
  cwd: string
  setMessages: RouterParams['setMessages']
}) {
  const { command, stdout, stderr, exitCode, cwd, setMessages } = params
  const toolResultOutput = createRunTerminalToolResult({
    command,
    cwd,
    stdout: stdout || null,
    stderr: stderr ?? null,
    exitCode,
  })
  const toolCallId = crypto.randomUUID()
  const outputJson = JSON.stringify(toolResultOutput)
  const { assistantMessage } = buildBashHistoryMessages({
    command,
    cwd,
    toolCallId,
    output: outputJson,
    isComplete: true,
  })

  setMessages((prev) => [...prev, assistantMessage])
}

export async function routeUserPrompt(
  params: RouterParams,
): Promise<CommandResult> {
  const {
    agentMode,
    inputRef,
    inputValue,
    isChainInProgressRef,
    isStreaming,
    streamMessageIdRef,
    addToQueue,
    hasQueuedMessages,
    saveToHistory,
    scrollToLatest,
    sendMessage,
    setInputFocused,
    setInputValue,
    setMessages,
  } = params

  const inputMode = useChatStore.getState().inputMode
  const setInputMode = useChatStore.getState().setInputMode
  const pendingAttachments = useChatStore.getState().pendingAttachments
  const pendingImages = pendingAttachments.filter((a) => a.kind === 'image')

  const trimmed = inputValue.trim()
  // Allow empty messages if there are pending attachments (images or text).
  // Skill mode also accepts an empty submit: it means "run the skill as-is".
  const hasAttachments = pendingAttachments.length > 0
  if (!trimmed && !hasAttachments && inputMode !== 'skill') return

  // DAU signal: one un-sampled event per user-submitted prompt. The CLI's
  // distinct id resolves to the canonical codebuff user id (anonymous id is
  // aliased to the real user id on login), matching the web and chat surfaces
  // so combined DAU is a single unique-users query. Freebuff-only: codebuff
  // CLI usage is intentionally excluded.
  if (IS_FREEBUFF) {
    const freebuffSession = useFreebuffSessionStore.getState().session
    trackEvent(AnalyticsEvent.MESSAGE_SENT, {
      surface: 'cli',
      accessTier:
        freebuffSession && 'accessTier' in freebuffSession
          ? freebuffSession.accessTier
          : 'unknown',
      mode: agentMode,
      inputMode,
      inputLength: trimmed.length,
      isSlashCommand: isSlashCommand(trimmed),
      isBashCommand: trimmed.startsWith('!'),
      hasImages: pendingImages.length > 0,
    })
  }

  // Handle bash mode commands
  if (inputMode === 'bash') {
    const commandWithBang = '!' + trimmed
    saveToHistory(commandWithBang)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    runBashCommand(trimmed)
    return
  }

  // Handle plan mode input
  if (inputMode === 'plan') {
    if (!trimmed) return
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    sendOrQueuePrompt(params, buildPlanPrompt(trimmed))
    return
  }

  // Handle interview mode input
  if (inputMode === 'interview') {
    if (!trimmed) return
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    sendOrQueuePrompt(params, buildInterviewPrompt(trimmed))
    return
  }

  // Handle skill mode input: the user picked a skill (bare /skill:<name>)
  // and is now adding instructions. Empty input runs the skill without any.
  if (inputMode === 'skill') {
    const skillName = useChatStore.getState().pendingSkillName
    const skill = skillName ? getSkillByName(skillName) : undefined

    if (!skill) {
      // Mode without a resolvable skill (state got out of sync): explain,
      // and leave the user's typed text in the composer rather than
      // destroying it — only the mode is reset.
      setInputMode('default')
      setInputFocused(true)
      inputRef.current?.focus()
      setMessages((prev) => [
        ...prev,
        getSystemMessage(`Skill not found: ${skillName ?? '(unknown)'}`),
      ])
      return
    }

    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    if (trimmed) {
      saveToHistory(trimmed)
    }
    dispatchSkillPrompt(params, skill, trimmed)
    return
  }

  // Handle review mode input
  if (inputMode === 'review') {
    if (!trimmed) return
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    setInputFocused(true)
    inputRef.current?.focus()

    sendOrQueuePrompt(params, buildReviewPrompt('custom', trimmed))
    return
  }

  // Handle bash commands from queue (starts with '!')
  if (trimmed.startsWith('!') && trimmed.length > 1) {
    const command = trimmed.slice(1)
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    runBashCommand(command)
    return
  }

  // Handle image mode input
  if (inputMode === 'image') {
    const imagePath = trimmed
    const projectRoot = getProjectRoot()

    // Validate and add the image (handles path resolution, format check, and processing)
    const result = await validateAndAddImage(imagePath, projectRoot)
    if (!result.success) {
      setMessages((prev) => [
        ...prev,
        getUserMessage(trimmed),
        getSystemMessage(`❌ ${result.error}`),
      ])
    }

    // Note: No system message added here - the PendingImagesBanner shows attached images
    saveToHistory(trimmed)
    setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
    setInputMode('default')
    return
  }

  // Handle slash commands or configured slashless exact commands.
  const parsedCommand = parseCommandInput(trimmed)
  if (parsedCommand) {
    const commandDef = findCommand(parsedCommand.command)
    if (commandDef) {
      const argsLength = parsedCommand.args.length
      const analyticsPayload = {
        command: commandDef.name,
        hasArgs: argsLength > 0,
        argsLength,
        agentMode,
        ...(parsedCommand.implicitCommand ? { implicitCommand: true } : {}),
      }

      trackEvent(AnalyticsEvent.SLASH_COMMAND_USED, analyticsPayload)

      // The command handler (via defineCommand/defineCommandWithArgs factories)
      // is responsible for validating and handling args
      return await commandDef.handler(params, parsedCommand.args)
    }
  }

  // Regular message or unknown slash command - send to agent

  // Block sending if attachments are still processing
  if (hasProcessingImages() || hasProcessingFiles()) {
    showClipboardMessage('processing attachments...', {
      durationMs: 2000,
    })
    return
  }

  saveToHistory(trimmed)
  setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })

  if (
    isStreaming ||
    streamMessageIdRef.current ||
    isChainInProgressRef.current
  ) {
    // Steer the running turn when possible: plain text is handed to the
    // active run and injected at its next step boundary, so the user can
    // redirect the agent without waiting the turn out. Falls back to the
    // queue for anything the steering hook can't carry faithfully:
    // attachments (strings only), a slash command (queued today so it can
    // error/execute after the turn), pending `!` bash output (only
    // prepareUserMessage folds it into the message that referenced it), a
    // non-empty queue (steering would deliver this text ahead of earlier
    // submissions), and the window where no run is accepting steering.
    const canSteer =
      !hasAttachments &&
      !isSlashCommand(trimmed) &&
      useChatStore.getState().pendingBashMessages.length === 0 &&
      !hasQueuedMessages?.()
    if (canSteer) {
      // Echo the bubble now, so the submit is visible immediately, and hand
      // its id to the buffer: if the run ends before draining this entry,
      // use-send-message retracts the bubble and requeues the text (which
      // mints its own bubble at dequeue) — no invisible message, no dupe.
      const steeredMessage = getUserMessage(trimmed)
      if (
        pushSteeringMessage({ messageId: steeredMessage.id, text: trimmed })
      ) {
        setMessages((prev) => [...prev, steeredMessage])
        setInputFocused(true)
        inputRef.current?.focus()
        return
      }
    }
    const pendingAttachmentsForQueue = capturePendingAttachments()
    // Pass a copy of pending attachments to the queue
    addToQueue(trimmed, pendingAttachmentsForQueue)

    setInputFocused(true)
    inputRef.current?.focus()
    return
  }

  // Unknown slash command - show error
  if (isSlashCommand(trimmed)) {
    // Track invalid/unknown command (only log command name, not full input for privacy)
    const attemptedCmd = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() || ''
    trackEvent(AnalyticsEvent.INVALID_COMMAND, {
      attemptedCommand: attemptedCmd,
      inputLength: trimmed.length,
      agentMode,
    })

    setMessages((prev) => [
      ...prev,
      getUserMessage(trimmed),
      getSystemMessage(`Command not found: ${JSON.stringify(trimmed)}`),
    ])
    return
  }

  sendMessage({ content: trimmed, agentMode })

  setTimeout(() => {
    scrollToLatest()
  }, 0)

  return
}
