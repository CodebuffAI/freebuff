import { safeOpen } from '../utils/open-url'

import {
  handleAdsEnable,
  handleAdsDisable,
  handleProposalDismiss,
  handleProposalMenu,
  handleProposalNeverAdvertiser,
  handleProposalReport,
  handleProposalsOff,
} from './ads'
import { handleCopyConversationCommand } from './copy-conversation'
import { handleExportConversationCommand } from './export-conversation'
import { handleHelpCommand } from './help'
import { handleImageCommand } from './image'
import { handleInitializationFlowLocally } from './init'
import {
  collectProcessDiagnostics,
  formatProcessDiagnostics,
} from './process-diagnostics'
import { buildInterviewPrompt, buildPlanPrompt, buildReviewPromptFromArgs, buildSkillPrompt } from './prompt-builders'
import { handleReasoningCommand } from './reasoning'
import { runBashCommand } from './router'
import { handleUsageCommand } from './usage'
import { returnToFreebuffLanding } from '../hooks/use-freebuff-session'
import { useThemeStore } from '../hooks/use-theme'
import { LOGIN_WEBSITE_URL, WEBSITE_URL } from '../login/constants'
import { startNewChat } from '../project-files'
import { useChatStore } from '../state/chat-store'
import { stopActiveRun } from '../utils/active-run'
import { useFeedbackStore } from '../state/feedback-store'
import { useLoginStore } from '../state/login-store'
import { AGENT_MODES, END_SESSION_MESSAGE, IS_FREEBUFF } from '../utils/constants'
import { exitCliCleanly } from '../utils/exit-cleanly'
import { getSystemMessage, getUserMessage } from '../utils/message-history'
import { capturePendingAttachments } from '../utils/pending-attachments'
import { getSkillByName } from '../utils/skill-registry'

import type { MultilineInputHandle } from '../components/multiline-input'
import type { InputValue, PendingAttachment } from '../types/store'
import type { ChatMessage } from '../types/chat'
import type { SendMessageFn } from '../types/contracts/send-message'
import type { User } from '../utils/auth'
import type { AgentMode } from '../utils/constants'
import type { UseMutationResult } from '@tanstack/react-query'

export type RouterParams = {
  agentMode: AgentMode
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  inputValue: string
  isChainInProgressRef: React.MutableRefObject<boolean>
  isStreaming: boolean
  logoutMutation: UseMutationResult<boolean, Error, void, unknown>
  streamMessageIdRef: React.MutableRefObject<string | null>
  addToQueue: (message: string, attachments?: PendingAttachment[]) => void
  /** Whether the message queue currently holds anything. Steering checks it
   *  so a mid-turn submit can't overtake earlier queued submissions. */
  hasQueuedMessages?: () => boolean
  clearMessages: () => void
  saveToHistory: (message: string) => void
  scrollToLatest: () => void
  sendMessage: SendMessageFn
  setCanProcessQueue: (value: React.SetStateAction<boolean>) => void
  setInputFocused: (focused: boolean) => void
  setInputValue: (
    value: InputValue | ((prev: InputValue) => InputValue),
  ) => void
  setIsAuthenticated: (value: React.SetStateAction<boolean | null>) => void
  setMessages: (
    value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void
  setUser: (value: React.SetStateAction<User | null>) => void
}

export type CommandResult = {
  openFeedbackMode?: boolean
  openPublishMode?: boolean
  openChatHistory?: boolean
  openReviewScreen?: boolean
  openQueuePanel?: boolean
  preSelectAgents?: string[]
} | void

export type CommandHandler = (
  params: RouterParams,
  args: string,
) => Promise<CommandResult> | CommandResult

export type CommandDefinition = {
  name: string
  aliases: string[]
  handler: CommandHandler
  /** Whether this command accepts arguments. Set automatically by the factory functions. */
  acceptsArgs: boolean
}

/**
 * Handler type for commands that don't accept arguments.
 */
type CommandHandlerNoArgs = (
  params: RouterParams,
) => Promise<CommandResult> | CommandResult

/**
 * Handler type for commands that accept arguments.
 */
type CommandHandlerWithArgs = (
  params: RouterParams,
  args: string,
) => Promise<CommandResult> | CommandResult

/**
 * Configuration for defining a command that does NOT accept arguments.
 */
type CommandConfig = {
  name: string
  aliases?: string[]
  handler: CommandHandlerNoArgs
}

/**
 * Configuration for defining a command that accepts arguments.
 */
type CommandWithArgsConfig = {
  name: string
  aliases?: string[]
  handler: CommandHandlerWithArgs
}

/**
 * Factory for commands that do NOT accept arguments.
 * Any args passed are gracefully ignored.
 *
 * @example
 * defineCommand({
 *   name: 'new',
 *   aliases: ['n', 'clear'],
 *   handler: (params) => {
 *     params.setMessages(() => [])
 *   },
 * })
 */
export function defineCommand(config: CommandConfig): CommandDefinition {
  return {
    name: config.name,
    aliases: config.aliases ?? [],
    acceptsArgs: false,
    handler: (params) => {
      // Args are gracefully ignored for commands that don't accept them
      return config.handler(params)
    },
  }
}

/**
 * Factory for commands that accept arguments.
 * The handler receives both params and args.
 *
 * @example
 * defineCommandWithArgs({
 *   name: 'bash',
 *   aliases: ['!'],
 *   handler: (params, args) => {
 *     if (args.trim()) {
 *       runBashCommand(args.trim())
 *     }
 *   },
 * })
 */
export function defineCommandWithArgs(
  config: CommandWithArgsConfig,
): CommandDefinition {
  return {
    name: config.name,
    aliases: config.aliases ?? [],
    acceptsArgs: true,
    handler: config.handler,
  }
}

const clearInput = (params: RouterParams) => {
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}

const FREEBUFF_REMOVED_COMMANDS = new Set([
  'ads:enable',
  'ads:disable',
  'usage',
  'subscribe',
  'image',
  'publish',
  'gpt-5-agent',
])

const FREEBUFF_ONLY_COMMANDS = new Set([
  'plan',
  'end-session',
  'dashboard',
  // Freebuff-only because the ladder it reads is the FREEBUFF catalog's, and
  // the metadata it sets is honored only for free-mode traffic
  // (isFreebuffOriginatedRequest). On Codebuff the command would take a value
  // and silently drop it.
  'reasoning',
])

const ALL_COMMANDS: CommandDefinition[] = [
  defineCommand({
    name: 'ads:enable',
    handler: (params) => {
      const { postUserMessage } = handleAdsEnable()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'ads:disable',
    handler: (params) => {
      const { postUserMessage } = handleAdsDisable()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  // The sponsored-proposal channel's controls (COD-376). Separate from
  // ads:disable, which is the display rail: one switch for both would turn off
  // something the user did not ask about.
  //
  // THE CARD ITSELF BINDS NO BARE KEYS while its menu is closed, so these are
  // not merely a convenience for when no card is on screen -- `/ads:proposal`
  // and `/ads:dismiss-proposal` are the ONLY way to reach the menu and the
  // decline. `useKeyboard` is global and the composer's handler is too, so the
  // `m` and `esc` these replaced fired alongside whatever the user was
  // actually typing.
  defineCommand({
    name: 'ads:proposal',
    handler: (params) => {
      const message = handleProposalMenu(useChatStore.getState().messages)
      // Null means it opened the menu, which is visible on its own; a system
      // line would only push the card it refers to further up the transcript.
      if (message) params.setMessages((prev) => [...prev, getSystemMessage(message)])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'ads:dismiss-proposal',
    handler: (params) => {
      const message = handleProposalDismiss(useChatStore.getState().messages)
      if (message) params.setMessages((prev) => [...prev, getSystemMessage(message)])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'ads:report-proposal',
    handler: async (params) => {
      const message = await handleProposalReport(useChatStore.getState().messages)
      params.setMessages((prev) => [...prev, getSystemMessage(message)])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'ads:never-advertiser',
    handler: async (params) => {
      const message = await handleProposalNeverAdvertiser(useChatStore.getState().messages)
      params.setMessages((prev) => [...prev, getSystemMessage(message)])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'ads:proposals-off',
    handler: async (params) => {
      const message = await handleProposalsOff()
      params.setMessages((prev) => [...prev, getSystemMessage(message)])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'help',
    aliases: ['h', '?'],
    handler: async (params) => {
      const { postUserMessage } = await handleHelpCommand()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'diagnostics',
    aliases: ['diag', 'processes'],
    handler: (params) => {
      const diagnostics = formatProcessDiagnostics(collectProcessDiagnostics())
      params.setMessages((prev) => [...prev, getSystemMessage(diagnostics)])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'copy',
    aliases: ['copy-chat'],
    handler: async (params) => {
      await handleCopyConversationCommand(params)
    },
  }),
  defineCommandWithArgs({
    name: 'export',
    aliases: ['export-chat'],
    handler: async (params, args) => {
      await handleExportConversationCommand(params, args)
    },
  }),
  defineCommandWithArgs({
    name: 'feedback',
    aliases: ['bug', 'report'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided feedback text directly, pre-populate the form
      if (trimmedArgs) {
        useFeedbackStore.getState().setFeedbackText(trimmedArgs)
        useFeedbackStore.getState().setFeedbackCursor(trimmedArgs.length)
      }

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      return { openFeedbackMode: true }
    },
  }),
  defineCommandWithArgs({
    name: 'bash',
    aliases: ['!'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a command directly, execute it immediately
      if (trimmedArgs) {
        const commandWithBang = '!' + trimmedArgs
        params.saveToHistory(commandWithBang)
        clearInput(params)
        runBashCommand(trimmedArgs)
        return
      }

      // Otherwise enter bash mode
      useChatStore.getState().setInputMode('bash')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'login',
    aliases: ['signin'],
    handler: (params) => {
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          "You're already in the app. Use /logout to switch accounts.",
        ),
      ])
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'logout',
    aliases: ['signout'],
    handler: (params) => {
      stopActiveRun('logout')

      const { resetLoginState } = useLoginStore.getState()
      params.logoutMutation.mutate(undefined, {
        onSettled: () => {
          resetLoginState()
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage('Logged out.'),
          ])
          clearInput(params)
          setTimeout(() => {
            // The confirmation remains visible briefly; fence that window too
            // before unmounting the authenticated runtime.
            stopActiveRun('logout')
            params.setUser(null)
            params.setIsAuthenticated(false)
          }, 300)
        },
      })
    },
  }),
  defineCommand({
    name: 'exit',
    aliases: ['quit', 'q'],
    handler: () => {
      void exitCliCleanly()
    },
  }),
  defineCommandWithArgs({
    name: 'new',
    aliases: ['n', 'clear', 'c', 'reset'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // Abort any in-flight run BEFORE clearing state and rotating the chat
      // id: an orphaned run would keep streaming after the switch and its
      // late checkpoints/final save would persist the old conversation's
      // state under the new chat (or vice versa).
      stopActiveRun('new-chat')

      // Clear the conversation and rotate to a fresh chat directory, so the
      // next message doesn't overwrite the previous conversation's history
      params.setMessages(() => [])
      params.clearMessages()
      startNewChat()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      // If user provided a message, send it as the first message in the new chat
      if (trimmedArgs) {
        // Re-enable queue processing so the message can be sent
        params.setCanProcessQueue(true)
        params.sendMessage({
          content: trimmedArgs,
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
      } else {
        // Only disable queue if we're not sending a message
        params.setCanProcessQueue(false)
      }
    },
  }),
  defineCommand({
    name: 'init',
    handler: async (params) => {
      const { postUserMessage } = handleInitializationFlowLocally()
      const trimmed = params.inputValue.trim()

      params.saveToHistory(trimmed)
      clearInput(params)

      // Check streaming/queue state
      if (
        params.isStreaming ||
        params.streamMessageIdRef.current ||
        params.isChainInProgressRef.current
      ) {
        const pendingAttachments = capturePendingAttachments()
        params.addToQueue(trimmed, pendingAttachments)
        params.setInputFocused(true)
        params.inputRef.current?.focus()
        return
      }

      params.sendMessage({
        content: trimmed,
        agentMode: params.agentMode,
        postUserMessage,
      })
      setTimeout(() => {
        params.scrollToLatest()
      }, 0)
    },
  }),
  defineCommand({
    name: 'usage',
    aliases: ['credits'],
    handler: async (params) => {
      const { postUserMessage } = await handleUsageCommand()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'subscribe',
    aliases: ['strong', 'sub', 'buy-credits'],
    handler: (params) => {
      safeOpen(WEBSITE_URL + '/subscribe')
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'dashboard',
    // Freebuff-only (see FREEBUFF_ONLY_COMMANDS): the hub is a Freebuff web
    // surface, and Codebuff has its own credits-shaped `/usage` banner.
    //
    // `usage` is one of the aliases because Freebuff removes that command —
    // its banner is credits- and subscription-shaped — leaving the product
    // with no answer at all to "how much have I used?". The word now lands
    // somewhere, and only in the build where nothing else claims it.
    aliases: ['usage', 'stats', 'streak'],
    handler: (params) => {
      const url = `${LOGIN_WEBSITE_URL}/account`
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(
          `Opening your dashboard: ${url}\n\nStreak, activity, tokens, sessions and settings for your account — across the CLI, Desktop and web.`,
        ),
      ])
      // Best-effort: `safeOpen` skips headless Linux and a locked-down WSL
      // rather than risking the process, so the URL above is printed first and
      // stays useful when nothing opens.
      void safeOpen(url)
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommandWithArgs({
    name: 'image',
    aliases: ['img', 'attach'],
    handler: async (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a path directly, process it immediately
      if (trimmedArgs) {
        const remainingMessage = await handleImageCommand(trimmedArgs)
        params.saveToHistory(params.inputValue.trim())
        if (remainingMessage) {
          params.setInputValue({
            text: remainingMessage,
            cursorPosition: remainingMessage.length,
            lastEditDueToNav: false,
          })
        } else {
          clearInput(params)
        }
        return
      }

      // Otherwise enter image mode
      useChatStore.getState().setInputMode('image')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  // Mode commands generated from AGENT_MODES (excluded in Freebuff)
  ...(IS_FREEBUFF ? [] : AGENT_MODES).map((mode) =>
    defineCommandWithArgs({
      name: `mode:${mode.toLowerCase()}`,
      aliases: [`model:${mode.toLowerCase()}`],
      handler: (params, args) => {
        const trimmedArgs = args.trim()

        useChatStore.getState().setAgentMode(mode)
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Switched to ${mode} mode.`),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)

        // If user provided a message, send it in the new mode
        if (trimmedArgs) {
          params.setCanProcessQueue(true)
          params.sendMessage({
            content: trimmedArgs,
            agentMode: mode,
          })
          setTimeout(() => {
            params.scrollToLatest()
          }, 0)
        }
      },
    }),
  ),
  defineCommandWithArgs({
    name: 'publish',
    handler: (params, args) => {
      const trimmedArgs = args.trim()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided agent ids directly, skip to confirmation step
      if (trimmedArgs) {
        const agentIds = trimmedArgs.split(/\s+/).filter(Boolean)
        return { openPublishMode: true, preSelectAgents: agentIds }
      }

      // Otherwise open selection UI
      return { openPublishMode: true }
    },
  }),
  defineCommand({
    name: 'gpt-5-agent',
    handler: (params) => {
      // Insert @ GPT-5 Agent into the input field (UI shortcut, not a real command)
      params.setInputValue({
        text: '@GPT-5 Agent ',
        cursorPosition: '@GPT-5 Agent '.length,
        lastEditDueToNav: false,
      })
      params.inputRef.current?.focus()
      // Don't save to history - this is just a UI shortcut
    },
  }),
  defineCommand({
    name: 'history',
    aliases: ['chats'],
    handler: (params) => {
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      return { openChatHistory: true }
    },
  }),
  defineCommandWithArgs({
    name: 'interview',
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided text directly, send it immediately
      if (trimmedArgs) {
        params.sendMessage({
          content: buildInterviewPrompt(trimmedArgs),
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter interview mode
      useChatStore.getState().setInputMode('interview')
    },
  }),
  defineCommandWithArgs({
    name: 'plan',
    handler: (params, args) => {
      // /plan runs on the selected model. No gate.
      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided plan text directly, send it immediately
      if (trimmedArgs) {
        params.sendMessage({
          content: buildPlanPrompt(trimmedArgs),
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter plan mode
      useChatStore.getState().setInputMode('plan')
    },
  }),
  defineCommandWithArgs({
    name: 'review',
    handler: (params, args) => {
      // /review runs on the selected model. No gate.
      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided review text directly, send it immediately without showing the screen
      if (trimmedArgs) {
        params.sendMessage({
          content: buildReviewPromptFromArgs(trimmedArgs),
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise open the selection UI
      return { openReviewScreen: true }
    },
  }),
  defineCommand({
    // No `/q` alias: that one already quits the CLI, and a queue editor is not
    // worth the chance of a mis-fired exit.
    name: 'queue',
    aliases: ['queued'],
    handler: (params) => {
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      return { openQueuePanel: true }
    },
  }),
  defineCommand({
    name: 'theme:toggle',
    handler: (params) => {
      const { theme, setThemeName } = useThemeStore.getState()
      const newTheme = theme.name === 'dark' ? 'light' : 'dark'
      setThemeName(newTheme)
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(`Switched to ${newTheme} theme.`),
      ])
      clearInput(params)
    },
  }),
  // /reasoning (freebuff-only) — read or set the thinking level for the
  // selected model. Takes effect on the NEXT message: the effort rides
  // codebuff_metadata on each request, so nothing about the live session has to
  // be restarted for a change to land.
  defineCommandWithArgs({
    name: 'reasoning',
    aliases: ['effort', 'think'],
    handler: (params, args) => {
      const { message } = handleReasoningCommand(args)
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(message),
      ])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  // /end-session (freebuff-only) — end the active session early and drop back
  // to the model picker. The hook flips status to 'none', which unmounts
  // <Chat> and mounts <FreebuffLandingScreen>, where the user picks a model
  // and hits Enter to start a new session.
  defineCommand({
    name: 'end-session',
    aliases: ['model'],
    handler: (params) => {
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(END_SESSION_MESSAGE),
      ])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      returnToFreebuffLanding({ resetChat: true }).catch(() => {
        // The hook surfaces poll errors via the session store; nothing to do
        // here beyond letting the chat history reflect the attempt.
      })
    },
  }),
]

export const COMMAND_REGISTRY: CommandDefinition[] = IS_FREEBUFF
  ? ALL_COMMANDS.filter((cmd) => !FREEBUFF_REMOVED_COMMANDS.has(cmd.name))
  : ALL_COMMANDS.filter((cmd) => !FREEBUFF_ONLY_COMMANDS.has(cmd.name))

export function findCommand(cmd: string): CommandDefinition | undefined {
  const lowerCmd = cmd.toLowerCase()

  // First check the static command registry
  const staticCommand = COMMAND_REGISTRY.find(
    (def) => def.name === lowerCmd || def.aliases.includes(lowerCmd),
  )
  if (staticCommand) {
    return staticCommand
  }

  // Check if this is a skill command (prefixed with "skill:")
  if (lowerCmd.startsWith('skill:')) {
    const skillName = lowerCmd.slice('skill:'.length)
    const skill = getSkillByName(skillName)
    if (skill) {
      return createSkillCommand(skill.name)
    }
  }

  return undefined
}

/**
 * Creates a dynamic command definition for a skill.
 * When invoked, the skill's content is sent to the agent.
 */
function createSkillCommand(skillName: string): CommandDefinition {
  return defineCommandWithArgs({
    name: skillName,
    handler: (params, args) => {
      const skill = getSkillByName(skillName)
      if (!skill) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Skill not found: ${skillName}`),
        ])
        params.saveToHistory(params.inputValue.trim())
        params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
        return
      }

      const trimmed = params.inputValue.trim()
      params.saveToHistory(trimmed)
      params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })

      // Bare invocation: like /interview, drop into an input mode so the
      // user can add instructions before the skill is sent. Enter with an
      // empty composer still runs the skill as-is (the router's skill-mode
      // branch), so a no-args run costs one extra keystroke, not a feature.
      if (!args.trim()) {
        useChatStore.getState().enterSkillMode(skill.name)
        params.setInputFocused(true)
        params.inputRef.current?.focus()
        return
      }

      dispatchSkillPrompt(params, skill, args)
    },
  })
}

/**
 * Send (or queue, mid-turn) a user-invoked skill prompt. Shared by the
 * /skill:<name> args form and the skill input mode's submit (router), so the
 * two entry paths for the same feature cannot drift.
 */
export function dispatchSkillPrompt(
  params: RouterParams,
  skill: { name: string; content: string },
  input: string,
): void {
  const userPrompt = buildSkillPrompt(skill, input)

  if (
    params.isStreaming ||
    params.streamMessageIdRef.current ||
    params.isChainInProgressRef.current
  ) {
    params.addToQueue(userPrompt, capturePendingAttachments())
    params.setInputFocused(true)
    params.inputRef.current?.focus()
    return
  }

  params.sendMessage({
    content: userPrompt,
    agentMode: params.agentMode,
  })
  setTimeout(() => {
    params.scrollToLatest()
  }, 0)
}
