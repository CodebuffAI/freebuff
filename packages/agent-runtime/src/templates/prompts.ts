import { buildArray } from '@codebuff/common/util/array'
import { schemaToJsonStr } from '@codebuff/common/util/zod-schema'
import { z } from 'zod/v4'

import { getAgentTemplate } from './agent-registry'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { AgentTemplateType } from '@codebuff/common/types/session-state'
import type { ToolSet } from 'ai'

function ensureJsonSchemaCompatible(schema: z.ZodType): z.ZodType {
  try {
    z.toJSONSchema(schema, { io: 'input' })
    return schema
  } catch {
    const fallback = z.object({}).passthrough()
    try {
      return schema.description ? fallback.describe(schema.description) : fallback
    } catch {
      return fallback
    }
  }
}

/**
 * Gets the short agent name from a fully qualified agent ID.
 * E.g., 'codebuff/file-picker@1.0.0' -> 'file-picker'
 */
export function getAgentShortName(agentType: AgentTemplateType): string {
  const withoutVersion = agentType.split('@')[0]
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1]
}

/**
 * Converts an agent ID into the provider-facing tool name used for direct
 * subagent calls. Agent IDs remain hyphenated; tool names use underscores.
 */
export function getAgentToolName(agentType: AgentTemplateType): string {
  return getAgentShortName(agentType).replace(/-/g, '_')
}

/**
 * Builds an input schema for an agent tool with prompt and params as top-level fields.
 * This matches the spawn_agents schema structure: { prompt?: string, params?: object }
 */
export function buildAgentToolInputSchema(
  agentTemplate: AgentTemplate,
): z.ZodType {
  const { inputSchema } = agentTemplate

  // Build schema with prompt and params as top-level fields (consistent with spawn_agents)
  // Preserve the original optionality from the inputSchema
  let schemaFields: Record<string, z.ZodType> = {}

  if (inputSchema?.prompt) {
    schemaFields.prompt = inputSchema.prompt
  }

  if (inputSchema?.params) {
    schemaFields.params = inputSchema.params
  }

  return z
    .object(schemaFields)
    .describe(
      agentTemplate.spawnerPrompt ||
        `Spawn the ${agentTemplate.displayName} agent`,
    )
}

/**
 * Builds AI SDK tool definitions for spawnable agents.
 * These tools allow the model to call agents directly as tool calls.
 */
export async function buildAgentToolSet(
  params: {
    spawnableAgents: AgentTemplateType[]
    agentTemplates: Record<string, AgentTemplate>
    logger: Logger
  } & ParamsExcluding<
    typeof getAgentTemplate,
    'agentId' | 'localAgentTemplates'
  >,
): Promise<ToolSet> {
  const { spawnableAgents, agentTemplates } = params

  const toolSet: ToolSet = {}

  for (const agentType of spawnableAgents) {
    const agentTemplate = await getAgentTemplate({
      ...params,
      agentId: agentType,
      localAgentTemplates: agentTemplates,
    })

    if (!agentTemplate) continue

    const toolName = getAgentToolName(agentType)
    const inputSchema = ensureJsonSchemaCompatible(
      buildAgentToolInputSchema(agentTemplate),
    )

    // Use the same structure as other tools in toolParams
    toolSet[toolName] = {
      description:
        agentTemplate.spawnerPrompt ||
        `Spawn the ${agentTemplate.displayName} agent`,
      inputSchema,
    }
  }

  return toolSet
}

/**
 * Builds the description of a single agent for the system prompt.
 */
function buildSingleAgentDescription(
  agentType: AgentTemplateType,
  agentTemplate: AgentTemplate | null,
): string {
  if (!agentTemplate) {
    // Fallback for unknown agents
    return `- ${agentType}: Dynamic agent (description not available)
prompt: {"description": "A coding task to complete", "type": "string"}
params: None`
  }

  const { inputSchema } = agentTemplate
  const inputSchemaStr = inputSchema
    ? [
        `prompt: ${schemaToJsonStr(inputSchema.prompt)}`,
        `params: ${schemaToJsonStr(inputSchema.params)}`,
      ].join('\n')
    : ['prompt: None', 'params: None'].join('\n')

  return buildArray(
    `- ${agentType}: ${agentTemplate.spawnerPrompt}`,
    agentTemplate.includeMessageHistory &&
      'This agent can see the current message history.',
    agentTemplate.inheritParentSystemPrompt &&
      "This agent inherits the parent's system prompt for prompt caching.",
    inputSchemaStr,
  ).join('\n')
}

/**
 * Builds the full spawnable agents specification for subagent instructions.
 * This is used when inheritSystemPrompt is true to tell subagents which agents they can spawn.
 */
export async function buildFullSpawnableAgentsSpec(
  params: {
    spawnableAgents: AgentTemplateType[]
    agentTemplates: Record<string, AgentTemplate>
    logger: Logger
  } & ParamsExcluding<
    typeof getAgentTemplate,
    'agentId' | 'localAgentTemplates'
  >,
): Promise<string> {
  const { spawnableAgents, agentTemplates } = params
  if (spawnableAgents.length === 0) {
    return ''
  }

  const subAgentTypesAndTemplates = await Promise.all(
    spawnableAgents.map(async (agentType) => {
      return [
        agentType,
        await getAgentTemplate({
          ...params,
          agentId: agentType,
          localAgentTemplates: agentTemplates,
        }),
      ] as const
    }),
  )

  const agentsDescription = subAgentTypesAndTemplates
    .map(([agentType, agentTemplate]) =>
      buildSingleAgentDescription(agentType, agentTemplate),
    )
    .filter(Boolean)
    .join('\n\n')

  return `You are a subagent that can only spawn the following agents using the spawn_agents tool:

${agentsDescription}`
}
