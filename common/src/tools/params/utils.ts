import z from 'zod/v4'

import {
  endsAgentStepParam,
  endToolTag,
  startToolTag,
  toolNameParam,
} from '../constants'

import type { JSONValue } from '../../types/json'
import type { ToolResultOutput } from '../../types/messages/content-part'

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
