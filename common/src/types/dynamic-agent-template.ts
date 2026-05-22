import { z } from 'zod/v4'

import { ALLOWED_MODEL_PREFIXES, models } from '../old-constants'
import { mcpConfigSchema } from './mcp'

import type { JSONSchema } from 'zod/v4/core'

// Filter models to only include those that begin with allowed prefixes
const filteredModels = Object.values(models).filter((model) =>
  ALLOWED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix)),
)

if (filteredModels.length === 0) {
  throw new Error('No valid models found with allowed prefixes')
}

// Simplified JSON Schema definition - supports object schemas with nested properties
export const JsonSchemaSchema: z.ZodType<
  JSONSchema.BaseSchema,
  JSONSchema.BaseSchema
> = z.lazy(() =>
  z.looseObject({
    type: z
      .enum([
        'object',
        'array',
        'string',
        'number',
        'boolean',
        'null',
        'integer',
      ])
      .optional(),
    description: z.string().optional(),
    properties: z
      .record(z.string(), JsonSchemaSchema.or(z.boolean()))
      .optional(),
    required: z.string().array().optional(),
    enum: z
      .union([z.string(), z.number(), z.boolean(), z.null()])
      .array()
      .optional(),
  }),
)
const JsonObjectSchemaSchema = z.intersection(
  JsonSchemaSchema,
  z.object({ type: z.literal('object') }),
)

// Schema for the combined inputSchema object
const InputSchemaObjectSchema = z
  .looseObject({
    prompt: z
      .looseObject({
        type: z.literal('string'),
        description: z.string().optional(),
      })
      .optional(), // Optional JSON schema for prompt validation
    params: JsonObjectSchemaSchema.optional(), // Optional JSON schema for params validation
  })
  .optional()

// Schema for prompt fields that can be either a string or a path reference
const PromptFieldSchema = z.union([
  z.string(), // Direct string content
  z.object({ path: z.string() }), // Path reference to external file
])
export type PromptField = z.infer<typeof PromptFieldSchema>

const functionSchema = <T extends z.core.$ZodFunction>(schema: T) =>
  z.custom<Parameters<T['implement']>[0]>((fn: any) => schema.implement(fn))
// Schema for the Logger interface
const LoggerSchema = z.object({
  debug: z.function({
    input: [z.any(), z.string().optional()],
    output: z.void(),
  }),
  info: z.function({
    input: [z.any(), z.string().optional()],
    output: z.void(),
  }),
  warn: z.function({
    input: [z.any(), z.string().optional()],
    output: z.void(),
  }),
  error: z.function({
    input: [z.any(), z.string().optional()],
    output: z.void(),
  }),
})

// Schema for validating handleSteps function signature
const HandleStepsSchema = functionSchema(
  z.function({
    input: [
      z.object({
        agentState: z.object({
          agentId: z.string(),
          parentId: z.string(),
          messageHistory: z.array(z.any()),
        }),
        prompt: z.string().optional(),
        params: z.any().optional(),
      }),
      LoggerSchema.optional(),
    ],
    output: z.any(),
  }),
).optional()

// Validates the Typescript template file.
export const DynamicAgentDefinitionSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9-]+$/,
      'Agent ID must contain only lowercase letters, numbers, and hyphens',
    ), // The unique identifier for this agent
  version: z.string().optional(),
  publisher: z.string().optional(),

  // Required fields for new agents
  displayName: z.string(),
  model: z.string(),
  reasoningOptions: z
    .object({
      enabled: z.boolean().optional(),
      exclude: z.boolean().optional(),
    })
    .and(
      z.union([
        z.object({ max_tokens: z.number() }),
        z.object({ effort: z.enum(['high', 'medium', 'low', 'minimal', 'none']) }),
      ]),
    )
    .optional(),
  providerOptions: z
    .object({
      order: z.array(z.string()).optional(),
      allow_fallbacks: z.boolean().optional(),
      require_parameters: z.boolean().optional(),
      data_collection: z.enum(['allow', 'deny']).optional(),
      only: z.array(z.string()).optional(),
      ignore: z.array(z.string()).optional(),
      quantizations: z
        .array(
          z.enum([
            'int4',
            'int8',
            'fp4',
            'fp6',
            'fp8',
            'fp16',
            'bf16',
            'fp32',
            'unknown',
          ]),
        )
        .optional(),
      sort: z.enum(['price', 'throughput', 'latency']).optional(),
      max_price: z
        .object({
          prompt: z.union([z.number(), z.string()]).optional(),
          completion: z.union([z.number(), z.string()]).optional(),
          image: z.union([z.number(), z.string()]).optional(),
          audio: z.union([z.number(), z.string()]).optional(),
          request: z.union([z.number(), z.string()]).optional(),
        })
        .optional(),
      baseUrl: z.string().url().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),

  // Tools and spawnable agents
  mcpServers: z.record(z.string(), mcpConfigSchema).default(() => ({})),
  toolNames: z
    .string()
    .array()
    .optional()
    .default(() => []),
  spawnableAgents: z
    .array(z.string())
    .optional()
    .default(() => []),

  // Input and output
  inputSchema: InputSchemaObjectSchema,
  includeMessageHistory: z.boolean().default(false),
  inheritParentSystemPrompt: z.boolean().default(false),
  outputMode: z
    .enum(['last_message', 'all_messages', 'structured_output'])
    .default('last_message'),
  outputSchema: JsonObjectSchemaSchema.optional(), // Optional JSON schema for output validation

  // Prompts
  spawnerPrompt: z.string().optional(),
  systemPrompt: z.string().optional(),
  instructionsPrompt: z.string().optional(),
  stepPrompt: z.string().optional(),

  // Optional generator function for programmatic agents
  handleSteps: z.union([z.string(), HandleStepsSchema]).optional(),
})
export type DynamicAgentDefinition = z.input<
  typeof DynamicAgentDefinitionSchema
>
export type DynamicAgentDefinitionParsed = z.infer<
  typeof DynamicAgentDefinitionSchema
>

export const DynamicAgentTemplateSchema = DynamicAgentDefinitionSchema.extend({
  systemPrompt: z.string(),
  instructionsPrompt: z.string(),
  stepPrompt: z.string(),
  handleSteps: z.string().optional(), // Converted to string after processing
})
  .refine(
    (data) => {
      // If outputSchema is provided, outputMode must be explicitly set to 'structured_output'
      if (data.outputSchema && data.outputMode !== 'structured_output') {
        return false
      }
      return true
    },
    {
      message:
        "outputSchema requires outputMode to be explicitly set to 'structured_output'.",
      path: ['outputMode'],
    },
  )
  // Note(James): Disabled so that handleSteps could use set_output while the llm does not see or have access to the set_output tool.
  // .refine(
  //   (data) => {
  //     // If outputMode is 'structured_output', 'set_output' tool must be included
  //     if (
  //       data.outputMode === 'structured_output' &&
  //       !data.toolNames.includes('set_output')
  //     ) {
  //       return false
  //     }
  //     return true
  //   },
  //   {
  //     message:
  //       "outputMode 'structured_output' requires the 'set_output' tool. Add 'set_output' to toolNames.",
  //     path: ['toolNames'],
  //   },
  // )
  // Note(James): Disabled so that a parent agent can have set_output tool and 'last_message' outputMode while its subagents use 'structured_output'. (The set_output tool must be included in parent to preserver prompt caching.)
  // .refine(
  //   (data) => {
  //     // If 'set_output' tool is included, outputMode must be 'structured_output'
  //     if (
  //       data.toolNames.includes('set_output') &&
  //       data.outputMode !== 'structured_output'
  //     ) {
  //       return false
  //     }
  //     return true
  //   },
  //   {
  //     message:
  //       "'set_output' tool requires outputMode to be 'structured_output'. Change outputMode to 'structured_output' or remove 'set_output' from toolNames.",
  //     path: ['outputMode'],
  //   },
  // )
  .refine(
    (data) => {
      // If spawnableAgents array is non-empty, 'spawn_agents' tool must be included
      if (
        data.spawnableAgents.length > 0 &&
        !data.toolNames.includes('spawn_agents')
      ) {
        return false
      }
      return true
    },
    {
      message:
        "Non-empty spawnableAgents array requires the 'spawn_agents' tool. Add 'spawn_agents' to toolNames or remove spawnableAgents.",
      path: ['toolNames'],
    },
  )
  .refine(
    (data) => {
      // If inheritParentSystemPrompt is true, systemPrompt must be empty or undefined
      if (
        data.inheritParentSystemPrompt &&
        data.systemPrompt &&
        data.systemPrompt.trim() !== ''
      ) {
        return false
      }
      return true
    },
    {
      message:
        'Cannot specify both systemPrompt and inheritParentSystemPrompt. When inheritParentSystemPrompt is true, systemPrompt must be empty.',
      path: ['systemPrompt'],
    },
  )
export type DynamicAgentTemplate = z.infer<typeof DynamicAgentTemplateSchema>
