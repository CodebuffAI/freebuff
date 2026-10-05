import {
  KNOWLEDGE_FILE_NAMES_LOWERCASE,
  PROJECT_INSTRUCTIONS_HEADER,
} from '@codebuff/common/constants/knowledge'
import { escapeString } from '@codebuff/common/util/string'
import { z } from 'zod/v4'

import { getAgentTemplate } from './agent-registry'
import { buildFullSpawnableAgentsSpec, modelSpawnableAgents } from './prompts'
import { PLACEHOLDER, placeholderValues } from './types'
import {
  getGitChangesPrompt,
  getProjectFileTreePrompt,
  getSystemInfoPrompt,
} from '../system-prompt/prompts'
import { parseUserMessage, unwrapSteeringText } from '../util/messages'

import type { AgentTemplate, PlaceholderValue } from './types'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  Message,
  UserMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { TextPart } from '@codebuff/common/types/messages/content-part'
import type {
  AgentState,
  AgentTemplateType,
} from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

export function formatCurrentDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export async function formatPrompt(
  params: {
    prompt: string
    fileContext: ProjectFileContext
    agentState: AgentState
    tools: readonly string[]
    spawnableAgents: AgentTemplateType[]
    agentTemplates: Record<string, AgentTemplate>
    intitialAgentPrompt?: string
    additionalToolDefinitions: () => Promise<
      ProjectFileContext['customToolDefinitions']
    >
    logger: Logger
  } & ParamsExcluding<
    typeof getAgentTemplate,
    'agentId' | 'localAgentTemplates'
  >,
): Promise<string> {
  const {
    fileContext,
    agentState,
    tools: _tools,
    spawnableAgents: _spawnableAgents,
    agentTemplates,
    intitialAgentPrompt,
    additionalToolDefinitions: _additionalToolDefinitions,
    logger,
  } = params
  let { prompt } = params

  const { messageHistory } = agentState
  function isUserInputMessage(message: Message): message is UserMessage & {
    content: [TextPart, ...any[]]
  } {
    return (
      message.role === 'user' &&
      message.content[0].type === 'text' &&
      message.tags?.includes('USER_PROMPT') === true
    )
  }
  const lastUserMessage = messageHistory.findLast(isUserInputMessage)
  const lastUserInput = lastUserMessage
    ? (parseUserMessage(lastUserMessage.content[0].text) ??
      unwrapSteeringText(lastUserMessage.content[0].text))
    : undefined

  const agentTemplate = agentState.agentType
    ? await getAgentTemplate({
        ...params,
        agentId: agentState.agentType,
        localAgentTemplates: agentTemplates,
      })
    : null

  const toInject: Record<PlaceholderValue, () => string | Promise<string>> = {
    [PLACEHOLDER.AGENT_NAME]: () =>
      agentTemplate ? agentTemplate.displayName || 'Unknown Agent' : 'Buffy',
    [PLACEHOLDER.CURRENT_DATE]: () => formatCurrentDate(new Date()),
    [PLACEHOLDER.FILE_TREE_PROMPT_SMALL]: () =>
      getProjectFileTreePrompt({
        fileContext,
        fileTreeTokenBudget: 2_500,
        mode: 'agent',
        logger,
      }),
    [PLACEHOLDER.FILE_TREE_PROMPT]: () =>
      getProjectFileTreePrompt({
        fileContext,
        fileTreeTokenBudget: 10_000,
        mode: 'agent',
        logger,
      }),
    [PLACEHOLDER.FILE_TREE_PROMPT_LARGE]: () =>
      getProjectFileTreePrompt({
        fileContext,
        fileTreeTokenBudget: 190_000,
        mode: 'search',
        logger,
      }),
    [PLACEHOLDER.GIT_CHANGES_PROMPT]: () => getGitChangesPrompt(fileContext),
    [PLACEHOLDER.REMAINING_STEPS]: () => `${agentState.stepsRemaining!}`,
    [PLACEHOLDER.PROJECT_ROOT]: () => fileContext.projectRoot,
    [PLACEHOLDER.SYSTEM_INFO_PROMPT]: () => getSystemInfoPrompt(fileContext),
    [PLACEHOLDER.USER_CWD]: () => fileContext.cwd,
    [PLACEHOLDER.USER_INPUT_PROMPT]: () => escapeString(lastUserInput ?? ''),
    [PLACEHOLDER.INITIAL_AGENT_PROMPT]: () =>
      escapeString(intitialAgentPrompt ?? ''),
    [PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS]: () => {
      const blocks = Object.entries({
        ...Object.fromEntries(
          Object.entries(fileContext.knowledgeFiles)
            .filter(([filePath]) => {
              const lowerPath = filePath.toLowerCase()
              // Root-level knowledge files only (AGENTS.md, CLAUDE.md)
              return KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(lowerPath)
            })
            .map(([path, content]) => [path, content.trim()]),
        ),
        ...fileContext.userKnowledgeFiles,
      }).map(([path, content]) => {
        return `\`\`\`${path}\n${content.trim()}\n\`\`\``
      })
      if (blocks.length === 0) return ''
      return `${PROJECT_INSTRUCTIONS_HEADER}

${blocks.join('\n\n')}`
    },
  }

  for (const varName of placeholderValues) {
    const valueProvider = toInject[varName] ?? (() => '')
    const value = await valueProvider()
    prompt = prompt.replaceAll(varName, value)
  }
  return prompt
}
type StringField = 'systemPrompt' | 'instructionsPrompt' | 'stepPrompt'

export async function getAgentPrompt<T extends StringField>(
  params: {
    agentTemplate: AgentTemplate
    promptType: { type: T }
    fileContext: ProjectFileContext
    agentState: AgentState
    agentTemplates: Record<string, AgentTemplate>
    additionalToolDefinitions: () => Promise<CustomToolDefinitions>
    logger: Logger
    useParentTools?: boolean
  } & ParamsExcluding<
    typeof formatPrompt,
    'prompt' | 'tools' | 'spawnableAgents'
  > &
    ParamsExcluding<
      typeof buildFullSpawnableAgentsSpec,
      'spawnableAgents' | 'agentTemplates'
    >,
): Promise<string | undefined> {
  const {
    agentTemplate,
    promptType,
    agentState,
    agentTemplates,
    additionalToolDefinitions: _additionalToolDefinitions,
    useParentTools,
  } = params

  const { toolNames, spawnableAgents, outputSchema } = agentTemplate
  const promptValue = agentTemplate[promptType.type]

  let prompt = await formatPrompt({
    ...params,
    prompt: promptValue,
    tools: toolNames,
    spawnableAgents,
  })

  let addendum = ''

  if (promptType.type === 'stepPrompt' && agentState.agentType && prompt) {
    // Put step prompt within a system_reminder tag so agent doesn't think the user just spoke again.
    prompt = `<system_reminder>${prompt}</system_reminder>`
  }

  // Add tool instructions, spawnable agents, and output schema prompts to instructionsPrompt
  if (promptType.type === 'instructionsPrompt' && agentState.agentType) {
    // Add subagent tools message when using parent's tools for prompt caching
    if (useParentTools) {
      addendum += `\n\nYou are a subagent that only has access to the following tools: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}. Previously referenced tools in the conversation may have only been available to the parent agent. Do not attempt to use any other tools besides these listed here. You will only get tool errors if you do.`

      // For subagents with inheritSystemPrompt, include full spawnable agents spec
      // since the parent's system prompt may not have these agents listed
      if (spawnableAgents.length > 0) {
        const spawnableAgentsSpec = await buildFullSpawnableAgentsSpec({
          ...params,
          spawnableAgents,
          agentTemplates,
        })
        addendum += `\n\n${spawnableAgentsSpec}`
      }
    } else if (modelSpawnableAgents(agentTemplate).length > 0) {
      // For non-inherited tools, agents are already defined as tools with full schemas,
      // so we add the spawnerPrompt for each agent
      const agentDescriptions = await Promise.all(
        spawnableAgents.map(async (agentType) => {
          const template = await getAgentTemplate({
            ...params,
            agentId: agentType,
            localAgentTemplates: agentTemplates,
          })
          if (template?.spawnerPrompt) {
            return `- ${agentType}: ${template.spawnerPrompt}`
          }
          return `- ${agentType}`
        }),
      )
      addendum += `\n\nYou can spawn the following agents:\n\n${agentDescriptions.join('\n')}`
    }

    // Add output schema information if defined
    if (outputSchema) {
      addendum += '\n\n## Output Schema\n\n'
      addendum +=
        'When using the set_output tool, your output must conform to this schema. You may pass the fields either directly as top-level parameters or inside a `data` field — both are accepted.\n\n'
      addendum += '```json\n'
      try {
        // Convert Zod schema to JSON schema for display
        const jsonSchema = z.toJSONSchema(outputSchema, {
          io: 'input',
        })
        delete jsonSchema['$schema'] // Remove the $schema field for cleaner display
        addendum += JSON.stringify(jsonSchema, null, 2)
      } catch {
        // Fallback to a simple description
        addendum += JSON.stringify(
          { type: 'object', description: 'Output schema validation enabled' },
          null,
          2,
        )
      }
      addendum += '\n```'
    }
  }

  const combinedPrompt = (prompt + addendum).trim()
  if (combinedPrompt === '') {
    return undefined
  }

  return combinedPrompt
}
