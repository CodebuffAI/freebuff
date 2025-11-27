import { CodebuffConfigSchema } from '@codebuff/common/json-config/constants'
import { escapeString } from '@codebuff/common/util/string'
import { schemaToJsonStr } from '@codebuff/common/util/zod-schema'
import { z } from 'zod/v4'

import { getAgentTemplate } from './agent-registry'
import { buildSpawnableAgentsDescription } from './prompts'
import { PLACEHOLDER, placeholderValues } from './types'
import {
  getGitChangesPrompt,
  getProjectFileTreePrompt,
  getSystemInfoPrompt,
} from '../system-prompt/prompts'
import { parseUserMessage } from '../util/messages'

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
    tools,
    spawnableAgents,
    agentTemplates,
    intitialAgentPrompt,
    additionalToolDefinitions,
    logger,
  } = params
  let { prompt } = params

  const { messageHistory } = agentState
  function isUserMessage(message: Message): message is UserMessage & {
    content: [TextPart, ...any[]]
  } {
    return message.role === 'user' && message.content[0].type === 'text'
  }
  const lastUserMessage = messageHistory.findLast(isUserMessage)
  const lastUserInput = lastUserMessage
    ? parseUserMessage(lastUserMessage.content[0].text)
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
    [PLACEHOLDER.CONFIG_SCHEMA]: () => schemaToJsonStr(CodebuffConfigSchema),
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
    [PLACEHOLDER.TOOLS_PROMPT]: async () => '',
    [PLACEHOLDER.AGENTS_PROMPT]: () => buildSpawnableAgentsDescription(params),
    [PLACEHOLDER.USER_CWD]: () => fileContext.cwd,
    [PLACEHOLDER.USER_INPUT_PROMPT]: () => escapeString(lastUserInput ?? ''),
    [PLACEHOLDER.INITIAL_AGENT_PROMPT]: () =>
      escapeString(intitialAgentPrompt ?? ''),
    [PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS]: () =>
      Object.entries({
        ...Object.fromEntries(
          Object.entries(fileContext.knowledgeFiles)
            .filter(([path]) =>
              [
                'knowledge.md',
                'CLAUDE.md',
                'codebuff.json',
                'codebuff.jsonc',
              ].includes(path),
            )
            .map(([path, content]) => [path, content.trim()]),
        ),
        ...fileContext.userKnowledgeFiles,
      })
        .map(([path, content]) => {
          return `\`\`\`${path}\n${content.trim()}\n\`\`\``
        })
        .join('\n\n'),
  }

  for (const varName of placeholderValues) {
    const value = await (toInject[varName] ?? (() => ''))()
    prompt = prompt.replaceAll(varName, value)
  }
  return prompt
}
type StringField = 'systemPrompt' | 'instructionsPrompt' | 'stepPrompt'

const additionalPlaceholders = {
  systemPrompt: [PLACEHOLDER.TOOLS_PROMPT, PLACEHOLDER.AGENTS_PROMPT],
  instructionsPrompt: [],
  stepPrompt: [],
} satisfies Record<StringField, string[]>
export async function getAgentPrompt<T extends StringField>(
  params: {
    agentTemplate: AgentTemplate
    promptType: { type: T }
    fileContext: ProjectFileContext
    agentState: AgentState
    agentTemplates: Record<string, AgentTemplate>
    additionalToolDefinitions: () => Promise<CustomToolDefinitions>
    logger: Logger
  } & ParamsExcluding<
    typeof formatPrompt,
    'prompt' | 'tools' | 'spawnableAgents'
  > &
    ParamsExcluding<
      typeof buildSpawnableAgentsDescription,
      'spawnableAgents' | 'agentTemplates'
    >,
): Promise<string | undefined> {
  const {
    agentTemplate,
    promptType,
    agentState,
    agentTemplates,
    additionalToolDefinitions,
  } = params

  let promptValue = agentTemplate[promptType.type]
  for (const placeholder of additionalPlaceholders[promptType.type]) {
    if (!promptValue.includes(placeholder)) {
      promptValue += `\n\n${placeholder}`
    }
  }

  let prompt = await formatPrompt({
    ...params,
    prompt: promptValue,
    tools: agentTemplate.toolNames,
    spawnableAgents: agentTemplate.spawnableAgents,
  })

  let addendum = ''

  if (promptType.type === 'stepPrompt' && agentState.agentType && prompt) {
    // Put step prompt within a system_reminder tag so agent doesn't think the user just spoke again.
    prompt = `<system_reminder>${prompt}</system_reminder>`
  }

  // Add tool instructions, spawnable agents, and output schema prompts to instructionsPrompt
  if (promptType.type === 'instructionsPrompt' && agentState.agentType) {
    addendum +=
      '\n\n' +
      (await buildSpawnableAgentsDescription({
        ...params,
        spawnableAgents: agentTemplate.spawnableAgents,
        agentTemplates,
      }))

    // Add output schema information if defined
    if (agentTemplate.outputSchema) {
      addendum += '\n\n## Output Schema\n\n'
      addendum +=
        'When using the set_output tool, your output must conform to this schema:\n\n'
      addendum += '```json\n'
      try {
        // Convert Zod schema to JSON schema for display
        const jsonSchema = z.toJSONSchema(agentTemplate.outputSchema, {
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
