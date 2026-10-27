import type { ToolName } from '@codebuff/common/tools/constants'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { z } from 'zod/v4'

export type CustomToolDefinition<
  N extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Args extends any = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input extends any = any,
> = {
  toolName: N
  inputSchema: z.ZodType<Args, Input>
  description: string
  endsAgentStep: boolean
  exampleInputs: Input[]
  execute: (params: Args, context?: { toolCallId?: string }) => Promise<ToolResultOutput[]>
}

/**
 * Creates a CustomToolDefinition object
 *
 * @param toolName the name of the tool
 * @param inputSchema a Zod4 schema describing the input of the tool.
 * @param description a description of the tool to be passed to the LLM. This should describe what the tool does and when to use it.
 * @param endsAgentStep whether the tool ends the agent step. If `true`, this will be used as a "stop sequence" for the LLM. i.e. it will not be able to call any other tools after this one in a single step and must wait for the tool results. Used for tools that give more information to the LLM.
 * @param exampleInputs an array of example inputs for the tool.
 * @param execute what to do when the tool is called. Can be either a sync or async. Must return an array of {@linkcode ToolResultOutput}
 * @returns a {@linkcode CustomToolDefinition} object
 */
export function getCustomToolDefinition<
  TN extends string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Args extends any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input extends any,
>({
  toolName,
  inputSchema,
  description,
  endsAgentStep = true,
  exampleInputs = [],
  execute,
}: {
  toolName: TN extends ToolName
    ? TN & {
        error: `Hi there. This is a message from the Codebuff team: You have used a custom tool where you needed to use overrideTools instead for name: ${TN}`
      }
    : TN
  inputSchema: z.ZodType<Args, Input>
  description: string
  endsAgentStep?: boolean
  exampleInputs?: Input[]
  execute: (params: Args, context?: { toolCallId?: string }) => Promise<ToolResultOutput[]> | ToolResultOutput[]
}): CustomToolDefinition<TN, Args, Input> {
  return {
    toolName,
    inputSchema,
    description,
    endsAgentStep,
    exampleInputs,
    execute: async (params, context) => {
      return await execute(params, context)
    },
  }
}
