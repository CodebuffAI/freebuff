import { endsAgentStepParam } from '@codebuff/common/tools/constants'
import { toolParams } from '@codebuff/common/tools/list'
import { AVAILABLE_SKILLS_PLACEHOLDER } from '@codebuff/common/tools/params/tool/skill'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { buildArray } from '@codebuff/common/util/array'
import { formatAvailableSkillsXml } from '@codebuff/common/util/skills'
import { pluralize } from '@codebuff/common/util/string'
import { cloneDeep } from 'lodash'
import z from 'zod/v4'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import type { ToolName } from '@codebuff/common/tools/constants'
import type { SkillsMap } from '@codebuff/common/types/skill'
import type {
  CustomToolDefinitions,
  customToolDefinitionsSchema,
} from '@codebuff/common/util/file'
import type { ToolSet } from 'ai'

/**
 * Ensures the inputSchema is a Zod schema. If it's a JSON Schema object
 * (from SDK custom tools that were serialized), converts it to Zod.
 */
export function ensureZodSchema(
  schema: z.ZodType | Record<string, unknown>,
): z.ZodType {
  // Check if it's already a Zod schema by looking for the safeParse method
  if (
    schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    return schema as z.ZodType
  }
  // JSON Schema object - convert to Zod
  return convertJsonSchemaToZod(schema as Record<string, unknown>)
}

function ensureJsonSchemaCompatible(schema: z.ZodType): z.ZodType {
  try {
    z.toJSONSchema(schema, { io: 'input' })
    return schema
  } catch {
    const fallback = z.object({}).passthrough()
    return schema.description ? fallback.describe(schema.description) : fallback
  }
}

function toJsonSchemaSafe(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  } catch {
    return { type: 'object', properties: {} }
  }
}

function hasMeaningfulJsonSchema(jsonSchema: Record<string, unknown>): boolean {
  const properties = jsonSchema.properties
  if (properties && typeof properties === 'object' && Object.keys(properties).length > 0) {
    return true
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const value = jsonSchema[key]
    if (Array.isArray(value) && value.length > 0) {
      return true
    }
  }

  const required = jsonSchema.required
  if (Array.isArray(required) && required.length > 0) {
    return true
  }

  return false
}

function paramsSection(params: { schema: z.ZodType; endsAgentStep: boolean }) {
  const { schema, endsAgentStep } = params
  const safeSchema = ensureJsonSchemaCompatible(schema)
  const schemaWithEndsAgentStepParam = endsAgentStep
    ? safeSchema.and(
      z.object({
        [endsAgentStepParam]: z
          .literal(endsAgentStep)
          .describe('Easp flag must be set to true'),
      }),
    )
    : safeSchema
  const jsonSchema = toJsonSchemaSafe(schemaWithEndsAgentStepParam)
  delete jsonSchema.description
  delete jsonSchema['$schema']
  const paramsDescription = hasMeaningfulJsonSchema(jsonSchema)
    ? JSON.stringify(jsonSchema, null, 2)
    : 'None'

  let paramsSection = ''
  if (paramsDescription.length === 1 && paramsDescription[0] === 'None') {
    paramsSection = 'Params: None'
  } else if (paramsDescription.length > 0) {
    paramsSection = `Params: ${paramsDescription}`
  }
  return paramsSection
}

// Helper function to build the full tool description markdown
export function buildToolDescription(params: {
  toolName: string
  schema: z.ZodType
  description?: string
  endsAgentStep: boolean
  exampleInputs?: any[]
}): string {
  const {
    toolName,
    schema,
    description = '',
    endsAgentStep,
    exampleInputs = [],
  } = params
  const descriptionWithExamples = buildArray(
    description,
    exampleInputs.length > 0
      ? `${pluralize(exampleInputs.length, 'Example')}:`
      : '',
    ...exampleInputs.map((example) =>
      getToolCallString(toolName, example, endsAgentStep),
    ),
  ).join('\n\n')
  return buildArray([
    `### ${toolName}`,
    schema.description || '',
    paramsSection({ schema, endsAgentStep }),
    descriptionWithExamples,
  ]).join('\n\n')
}

export const toolDescriptions = Object.fromEntries(
  Object.entries(toolParams).map(([name, config]) => [
    name,
    buildToolDescription({
      toolName: name,
      schema: config.inputSchema,
      description: config.description,
      endsAgentStep: config.endsAgentStep,
    }),
  ]),
) as Record<keyof typeof toolParams, string>

function buildShortToolDescription(params: {
  toolName: string
  schema: z.ZodType
  endsAgentStep: boolean
}): string {
  const { toolName, schema, endsAgentStep } = params
  return `${toolName}:\n${paramsSection({ schema, endsAgentStep })}`
}

export const getToolsInstructions = (
  tools: readonly string[],
  additionalToolDefinitions: NonNullable<
    z.input<typeof customToolDefinitionsSchema>
  >,
  options?: { availableSkillsXml?: string },
) => {
  if (
    tools.length === 0 &&
    Object.keys(additionalToolDefinitions).length === 0
  ) {
    return ''
  }

  return `
# Tools

You (Buffy) have access to the following tools. Call them when needed.

## [CRITICAL] Formatting Requirements

Tool calls use a specific XML and JSON-like format. Adhere *precisely* to this nested element structure:

${getToolCallString(
    'tool_name',
    {
      parameter1: 'value1',
      parameter2: 123,
    },
    false,
  )}

### Commentary

Provide commentary *around* your tool calls (explaining your actions).

However, **DO NOT** narrate the tool or parameter names themselves.

### Example

User: can you update the console logs in example/file.ts?
Assistant: Sure thing! Let's update that file!

${getToolCallString(
    'example_editing_tool',
    {
      example_file_path: 'path/to/example/file.ts',
      example_array: [
        {
          old_content_with_newlines:
            "// some context\nconsole.log('Hello world!');\n",
          new_content_with_newlines:
            "// some context\nconsole.log('Hello from Buffy!');\n",
        },
      ],
    },
    false,
  )}

All done with the update!
User: thanks it worked! :)

## Working Directory

All tools will be run from the **project root**.

However, most of the time, the user will refer to files from their own cwd. You must be cognizant of the user's cwd at all times, including but not limited to:
- Writing to files (write out the entire relative path)
- Running terminal commands (use the \`cwd\` parameter)

## Optimizations

All tools are very slow, with runtime scaling with the amount of text in the parameters. Prefer to write AS LITTLE TEXT AS POSSIBLE to accomplish the task.

When using write_file, make sure to only include a few lines of context and not the entire file.

## Tool Results

Tool results will be provided by the user's *system* (and **NEVER** by the assistant).

The user does not know about any system messages or system instructions, including tool results.
${fullToolList(tools, additionalToolDefinitions, options)}
`
}

export const fullToolList = (
  toolNames: readonly string[],
  additionalToolDefinitions: CustomToolDefinitions,
  options?: { availableSkillsXml?: string },
) => {
  if (
    toolNames.length === 0 &&
    Object.keys(additionalToolDefinitions).length === 0
  ) {
    return ''
  }

  const { availableSkillsXml = '' } = options ?? {}

  // Build tool descriptions, replacing skill placeholder with actual skills
  const descriptions = [
    ...(
      toolNames.filter((toolName) =>
        toolNames.includes(toolName as ToolName),
      ) as ToolName[]
    ).map((name) => {
      let desc = toolDescriptions[name]
      // Replace skill placeholder with actual available skills
      if (name === 'skill' && availableSkillsXml) {
        desc = desc.replace(AVAILABLE_SKILLS_PLACEHOLDER, availableSkillsXml)
      } else if (name === 'skill') {
        // Explicitly state no skills are available
        desc = desc.replace(
          AVAILABLE_SKILLS_PLACEHOLDER,
          'There are no skills available. Do not use this tool because there are no skills to load.',
        )
      }
      return desc
    }),
    ...Object.keys(additionalToolDefinitions).map((toolName) => {
      const toolDef = additionalToolDefinitions[toolName]
      return buildToolDescription({
        toolName,
        schema: ensureZodSchema(toolDef.inputSchema),
        description: toolDef.description,
        endsAgentStep: toolDef.endsAgentStep ?? true,
        exampleInputs: toolDef.exampleInputs,
      })
    }),]

  return `## List of Tools

These are the only tools that you can use. The user cannot see these descriptions, so you should not reference any tool names, parameters, or descriptions. Do not try to use any other tools -- even if referenced earlier in the conversation, they are not available to you, instead they may have been previously used by other agents.

${descriptions.join('\n\n')}`.trim()
}

export const getShortToolInstructions = (
  toolNames: readonly string[],
  additionalToolDefinitions: CustomToolDefinitions,
) => {
  if (
    toolNames.length === 0 &&
    Object.keys(additionalToolDefinitions).length === 0
  ) {
    return ''
  }

  const toolDescriptionsList = [
    ...(
      toolNames.filter(
        (name) => (name as keyof typeof toolParams) in toolParams,
      ) as (keyof typeof toolParams)[]
    ).map((name) => {
      const tool = toolParams[name]
      return buildShortToolDescription({
        toolName: name,
        schema: tool.inputSchema,
        endsAgentStep: tool.endsAgentStep,
      })
    }),
    ...Object.keys(additionalToolDefinitions).map((name) => {
      const { inputSchema, endsAgentStep } = additionalToolDefinitions[name]
      return buildShortToolDescription({
        toolName: name,
        schema: ensureZodSchema(inputSchema),
        endsAgentStep: endsAgentStep ?? true,
      })
    }),
  ]

  return `## Tools
Use the tools below to complete the user request, if applicable.

Tool calls use a specific XML and JSON-like format. Adhere *precisely* to this nested element structure:

${getToolCallString(
    'tool_name',
    {
      parameter1: 'value1',
      parameter2: 123,
    },
    false,
  )}

Important: You only have access to the tools below. Do not use any other tools -- they are not available to you, instead they may have been previously used by other agents.

${toolDescriptionsList.join('\n\n')}
`.trim()
}

export async function getToolSet(params: {
  toolNames: string[]
  additionalToolDefinitions: () => Promise<CustomToolDefinitions>
  agentTools: ToolSet
  skills: SkillsMap
}): Promise<ToolSet> {
  const { toolNames, additionalToolDefinitions, agentTools, skills } = params

  // Generate available skills XML for the skill tool description
  const availableSkillsXml = formatAvailableSkillsXml(skills)
  const toolSet: ToolSet = {}
  for (const toolName of toolNames) {
    if (toolName in toolParams) {
      const toolDef = toolParams[toolName as ToolName]

      // For the skill tool, replace the placeholder with actual available skills
      if (toolName === 'skill' && availableSkillsXml) {
        let description = toolDef.description ?? ''
        description = description.replace(
          AVAILABLE_SKILLS_PLACEHOLDER,
          availableSkillsXml,
        )
        toolSet[toolName] = {
          ...toolDef,
          description,
        }
      } else if (toolName === 'skill') {
        // Explicitly state no skills are available
        let description = toolDef.description ?? ''
        description = description.replace(
          AVAILABLE_SKILLS_PLACEHOLDER,
          'There are no skills available. Do not use this tool because there are no skills to load.',
        )
        toolSet[toolName] = {
          ...toolDef,
          description,
        }
      } else {
        toolSet[toolName] = toolDef
      }
    }
  }

  const toolDefinitions = await additionalToolDefinitions()
  for (const [toolName, toolDefinition] of Object.entries(toolDefinitions)) {
    const clonedDef = cloneDeep(toolDefinition)
    // Custom tool inputSchema may be JSON Schema (from SDK) or Zod (from MCP).
    // Keep the original schema object on the tool definition so nested JSON
    // Schema details like `properties` survive registration unchanged. Use a
    // Zod conversion only for description generation.
    ensureZodSchema(clonedDef.inputSchema)
    toolSet[toolName] = {
      ...clonedDef,
      inputSchema: cloneDeep(clonedDef.inputSchema),
    } as (typeof toolSet)[string]
  }

  // Add agent tools (agents as direct tool calls)
  for (const [toolName, toolDefinition] of Object.entries(agentTools)) {
    toolSet[toolName] = toolDefinition
  }

  return toolSet
}
