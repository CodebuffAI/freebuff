import { CHATGPT_OAUTH_ENABLED } from '@codebuff/common/constants/chatgpt-oauth'
import { AGENT_MODES, IS_FREEBUFF } from '../utils/constants'
import { getChatGptOAuthStatus } from '../utils/chatgpt-oauth'

import type { SkillsMap } from '@codebuff/common/types/skill'


export interface SlashCommand {
  id: string
  label: string
  description: string
  aliases?: string[]
  /**
   * If true, this command can be invoked without a leading slash when the
   * input matches the command id exactly (no arguments).
   */
  implicitCommand?: boolean
  /**
   * If set, selecting this command inserts this text into the input field
   * instead of executing a command. Useful for agent shortcuts.
   */
  insertText?: string
}

// Generate mode commands from the AGENT_MODES constant (excluded in Freebuff)
const MODE_COMMANDS: SlashCommand[] = IS_FREEBUFF
  ? []
  : AGENT_MODES.map((mode) => ({
      id: `mode:${mode.toLowerCase()}`,
      label: `mode:${mode.toLowerCase()}`,
      description: `Switch to ${mode} mode`,
      aliases: [`model:${mode.toLowerCase()}`],
    }))

const FREEBUFF_REMOVED_COMMAND_IDS = new Set([
  'ads:enable',
  'ads:disable',
  'usage',
  'subscribe',
  'agent:gpt-5',
  'image',
  'publish',
  'init',
])

const FREEBUFF_ONLY_COMMAND_IDS = new Set([
  'connect',
  'plan',
  'end-session',
])

const ALL_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'help',
    label: 'help',
    description: 'Display keyboard shortcuts and tips',
    aliases: ['h', '?'],
    implicitCommand: true,
  },
  ...(CHATGPT_OAUTH_ENABLED
    ? [
        {
          id: 'connect',
          label: 'connect',
          description: 'Connect your ChatGPT account',
          aliases: ['connect:chatgpt', 'chatgpt'],
        },
      ]
    : []),

  {
    id: 'ads:enable',
    label: 'ads:enable',
    description: 'Enable contextual ads',
  },
  {
    id: 'ads:disable',
    label: 'ads:disable',
    description: 'Disable contextual ads',
  },
  {
    id: 'init',
    label: 'init',
    description: 'Create a starter knowledge.md file',
    implicitCommand: true,
  },
  // {
  //   id: 'undo',
  //   label: 'undo',
  //   description: 'Undo the last change made by the assistant',
  // },
  // {
  //   id: 'redo',
  //   label: 'redo',
  //   description: 'Redo the most recent undone change',
  // },
  {
    id: 'usage',
    label: 'usage',
    description: 'View credits and subscription quota',
    aliases: ['credits'],
  },
  {
    id: 'subscribe',
    label: 'subscribe',
    description: 'Subscribe to get more usage',
    aliases: ['strong', 'sub', 'buy-credits'],
  },
  {
    id: 'interview',
    label: 'interview',
    description: 'AI asks a series of questions to flesh out request into a spec',
  },
  {
    id: 'plan',
    label: 'plan',
    description: 'Create a plan with GPT 5.4',
  },
  {
    id: 'review',
    label: 'review',
    description: 'Review code changes with GPT 5.4',
  },
  {
    id: 'new',
    label: 'new',
    description: 'Clear the conversation history and start a new chat',
    aliases: ['n', 'clear', 'c', 'reset'],
    implicitCommand: true,
  },
  {
    id: 'history',
    label: 'history',
    description: 'Browse and resume past conversations',
    aliases: ['chats'],
  },
  {
    id: 'agent:gpt-5',
    label: 'agent:gpt-5',
    description: 'Spawn the GPT-5 agent to help solve complex problems',
    insertText: '@GPT-5 Agent ',
  },
  // {
  //   id: 'agent:opus',
  //   label: 'agent:opus',
  //   description: 'Spawn the Opus agent to help solve any problem',
  //   insertText: '@Opus Agent ',
  // },
  {
    id: 'feedback',
    label: 'feedback',
    description: IS_FREEBUFF ? 'Share general feedback about Freebuff' : 'Share general feedback about Codebuff',
  },
  {
    id: 'bash',
    label: 'bash',
    description: 'Enter bash mode ("!" at beginning enters bash mode)',
    aliases: ['!'],
  },
  {
    id: 'image',
    label: 'image',
    description: 'Attach an image file (or Ctrl+V to paste from clipboard)',
    aliases: ['img', 'attach'],
  },
  {
    id: 'local',
    label: 'local',
    description: 'Toggle local LLM provider (Ollama/LM Studio). Usage: /local [on <model>|off|model <name>|list|status]',
  },
  ...MODE_COMMANDS,
  // {
  //   id: 'publish',
  //   label: 'publish',
  //   description: 'Publish agents to the agent store',
  // },
  {
    id: 'theme:toggle',
    label: 'theme:toggle',
    description: 'Toggle between light and dark mode',
  },
  {
    id: 'end-session',
    label: 'end-session',
    description: 'End your free session (lets you switch model)',
    aliases: ['model'],
  },
  {
    id: 'logout',
    label: 'logout',
    description: 'Sign out of your session',
    aliases: ['signout'],
    implicitCommand: true,
  },
  {
    id: 'exit',
    label: 'exit',
    description: 'Quit the CLI',
    aliases: ['quit', 'q'],
    implicitCommand: true,
  },
]

export const SLASH_COMMANDS = IS_FREEBUFF
  ? ALL_SLASH_COMMANDS.filter(
      (cmd) => !FREEBUFF_REMOVED_COMMAND_IDS.has(cmd.id),
    )
  : ALL_SLASH_COMMANDS.filter(
      (cmd) => !FREEBUFF_ONLY_COMMAND_IDS.has(cmd.id),
    )

export const SLASHLESS_COMMAND_IDS = new Set(
  SLASH_COMMANDS.filter((cmd) => cmd.implicitCommand).map((cmd) =>
    cmd.id.toLowerCase(),
  ),
)

/** Maximum description length for skill commands in the slash menu */
const SKILL_MENU_DESCRIPTION_MAX_LENGTH = 50

function truncateDescription(description: string): string {
  if (description.length <= SKILL_MENU_DESCRIPTION_MAX_LENGTH) {
    return description
  }
  return description.slice(0, SKILL_MENU_DESCRIPTION_MAX_LENGTH - 1) + '…'
}

/**
 * Returns SLASH_COMMANDS merged with skill commands.
 * Skills become slash commands that users can invoke directly.
 */
export function getSlashCommandsWithSkills(skills: SkillsMap): SlashCommand[] {
  const skillCommands: SlashCommand[] = Object.values(skills).map((skill) => ({
    id: `skill:${skill.name}`,
    label: `skill:${skill.name}`,
    description: truncateDescription(skill.description),
  }))

  let commands = [...SLASH_COMMANDS, ...skillCommands]

  if (IS_FREEBUFF && !getChatGptOAuthStatus().connected) {
    commands = commands.map((cmd) => {
      if (cmd.id === 'review' || cmd.id === 'plan') {
        return { ...cmd, description: 'Connect required. ' + cmd.description }
      }
      return cmd
    })
  }

  return commands
}
