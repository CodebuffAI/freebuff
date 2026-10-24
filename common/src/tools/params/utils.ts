import z from 'zod/v4'

import {
  endsAgentStepParam,
  endToolTag,
  startToolTag,
  toolNameParam,
} from '../constants'

import type { JSONValue } from '../../types/json'
import type { ToolResultOutput } from '../../types/messages/content-part'

/**
 * Coerces a value into an array if it isn't one already.
 * Handles common LLM mistakes:
 * - Single object/string passed instead of an array → wraps in array
 * - Stringified JSON array passed as a string → parses it
 * - Already an array → passes through
 * - null/undefined → passes through (let Zod handle it)
 */
export function coerceToArray(val: unknown): unknown {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Not valid JSON — fall through to wrap
    }
  }
  if (val != null) return [val]
  return val
}

/**
 * Coerces a stringified JSON object into an object.
 * This is intentionally narrow so malformed values still fail validation.
 */
export function coerceToObject(val: unknown): unknown {
  if (typeof val !== 'string') {
    return val
  }

  try {
    const parsed = JSON.parse(val)
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed
    }
  } catch {
    // Leave the original value untouched so schema validation can reject it.
  }

  return val
}

/**
 * Handles common replacement-key aliases emitted by some models while keeping
 * the documented schema stable.
 */
export function normalizeReplacementAliases(val: unknown): unknown {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return val
  }

  const replacement = { ...(val as Record<string, unknown>) }
  for (const [target, aliases] of [
    ['oldString', ['old', 'old_str', 'old_string']],
    ['newString', ['new', 'new_str', 'new_string', 'replacement']],
  ] as const) {
    if (replacement[target] !== undefined) {
      continue
    }
    const alias = aliases.find((key) => typeof replacement[key] === 'string')
    if (alias) {
      replacement[target] = replacement[alias]
    }
  }
  return replacement
}

/**
 * Accepts a single edit sent at the top level (`{ path, oldString, newString }`)
 * instead of inside `replacements`, the most common str_replace shape slip in
 * production traces. Input that already has `replacements`, or has no
 * `oldString`, is left for the schema to judge.
 */
export function liftSingleReplacement(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const edit = normalizeReplacementAliases(input) as Record<string, unknown>
  if (edit.replacements !== undefined || typeof edit.oldString !== 'string') {
    return input
  }
  const { oldString, newString, allowMultiple, ...rest } = edit
  return { ...rest, replacements: [{ oldString, newString, allowMultiple }] }
}

/**
 * Runs `repair` on a copy of the raw tool input, when it is an object, before
 * `schema` validates it; anything else goes to the schema untouched. The JSON
 * schema shown to the model is unchanged (zod renders the inner schema); the
 * description is carried over because tool prompts read `schema.description`.
 */
export function repairInput<T extends z.ZodType>(
  repair: (input: Record<string, unknown>) => unknown,
  schema: T,
) {
  const repaired = z.preprocess(
    (val) =>
      val !== null && typeof val === 'object' && !Array.isArray(val)
        ? repair({ ...(val as Record<string, unknown>) })
        : val,
    schema,
  )
  return schema.description ? repaired.describe(schema.description) : repaired
}

/** Only used for generating tool call strings before all tools are defined.
 *
 * @param toolName - The name of the tool to call
 * @param inputSchema - The zod schema for the tool. This is only used as type validation and is unused otherwise.
 * @param input - The input to the tool
 * @param endsAgentStep - Whether the agent should end its turn after this tool call
 */
export function $getToolCallString<Input>(params: {
  toolName: string
  inputSchema: z.ZodType<any, Input> | null
  input: Input
  endsAgentStep: boolean
}): string {
  const { toolName, input, endsAgentStep } = params
  const obj: Record<string, any> = {
    [toolNameParam]: toolName,
    ...input,
  }
  if (endsAgentStep) {
    obj[endsAgentStepParam] = endsAgentStep satisfies true
  }
  return [startToolTag, JSON.stringify(obj, null, 2), endToolTag].join('')
}

export function $getNativeToolCallExampleString<Input>(params: {
  toolName: string
  inputSchema: z.ZodType<any, Input> | null
  input: Input
  endsAgentStep?: boolean // unused
}): string {
  const { toolName, input } = params
  return [
    `<${toolName}_params_example>\n`,
    JSON.stringify(input, null, 2),
    `\n</${toolName}_params_example>`,
  ].join('')
}

/** Generates the zod schema for a single JSON tool result. */
export function jsonToolResultSchema<T extends JSONValue>(
  valueSchema: z.ZodType<T>,
) {
  return z.tuple([
    z.object({
      type: z.literal('json'),
      value: valueSchema,
    }) satisfies z.ZodType<ToolResultOutput>,
  ])
}

/** Generates the zod schema for an empty tool result. */
export function emptyToolResultSchema() {
  return z.tuple([])
}

/** Generates the zod schema for a simple text tool result. */
export function textToolResultSchema() {
  return z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
      }),
    }) satisfies z.ZodType<ToolResultOutput>,
  ])
}
