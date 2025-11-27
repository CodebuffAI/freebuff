import { buildArray } from '@codebuff/common/util/array'

import { publisher } from '../../constants'

import type {
  AgentStepContext,
  StepText,
  ToolCall,
} from '../../types/agent-definition'
import type { SecretAgentDefinition } from '../../types/secret-agent-definition'

export function createBestOfNEditor(
  model: 'default' | 'max' | 'opus',
): Omit<SecretAgentDefinition, 'id'> {
  const isDefault = model === 'default'
  const isMax = model === 'max'
  const isOpus = model === 'opus'
  return {
    publisher,
    model: 'anthropic/claude-sonnet-4.5',
    displayName: isDefault
      ? 'Best-of-N Editor'
      : isMax
        ? 'Best-of-N Max Editor'
        : 'Best-of-N Opus Editor',
    spawnerPrompt:
      'Edits code by orchestrating multiple implementor agents to generate implementation proposals, selects the best one, and applies the changes. Do not specify an input prompt for this agent; it inherits the context of the entire conversation with the user. Make sure to read any files intended to be edited before spawning this agent as it cannot read files on its own.',

    includeMessageHistory: true,
    inheritParentSystemPrompt: true,

    toolNames: [
      'spawn_agents',
      'str_replace',
      'write_file',
      'set_messages',
      'set_output',
    ],
    spawnableAgents: buildArray(
      'best-of-n-selector',
      'best-of-n-selector-opus',
      'best-of-n-selector-gemini',
      'editor-implementor',
      'editor-implementor-opus',
      'editor-implementor-gemini',
      'editor-implementor-gpt-5',
    ),

    inputSchema: {
      params: {
        type: 'object',
        properties: {
          n: {
            type: 'number',
            description: `Number of parallel implementor agents to spawn. Defaults to ${isDefault ? 4 : 5}. Use fewer for simple tasks and max of 10 for complex tasks.`,
          },
        },
      },
    },
    outputMode: 'structured_output',

    handleSteps: isOpus
      ? handleStepsOpus
      : isMax
        ? handleStepsMax
        : handleStepsDefault,
  }
}

function* handleStepsDefault({
  params,
  logger,
}: AgentStepContext): ReturnType<
  NonNullable<SecretAgentDefinition['handleSteps']>
> {
  const DEFAULT_N = 4
  const selectorAgent = 'best-of-n-selector'
  const n = Math.min(
    10,
    Math.max(1, (params?.n as number | undefined) ?? DEFAULT_N),
  )

  // Spawn implementor agents: 1 gemini + rest sonnet (if n >= 2)
  const implementorAgents = []
  if (n >= 2) {
    // Add 1 gemini implementor
    implementorAgents.push({
      agent_type: 'editor-implementor-gemini',
    })
    // Add (n-1) sonnet implementors
    for (let i = 1; i < n; i++) {
      implementorAgents.push({
        agent_type: 'editor-implementor',
      })
    }
  } else {
    // If n === 1, just spawn 1 sonnet implementor
    implementorAgents.push({
      agent_type: 'editor-implementor',
    })
  }

  // Spawn all implementor agents
  const { toolResult: implementorResults } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: implementorAgents,
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  // Extract spawn results
  const spawnedImplementations =
    extractSpawnResults<{ text: string }[]>(implementorResults)

  logger.info({ spawnedImplementations }, 'spawnedImplementations')

  // Extract all the plans from the structured outputs
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  // Parse implementations from spawn results
  const implementations = spawnedImplementations.map((result, index) => ({
    id: letters[index],
    content:
      'errorMessage' in result
        ? `Error: ${result.errorMessage}`
        : result[0].text,
  }))

  // Spawn selector with implementations as params
  const { toolResult: selectorResult } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: [
        {
          agent_type: selectorAgent,
          params: { implementations },
        },
      ],
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  const selectorOutput = extractSpawnResults<{
    implementationId: string
    reasoning: string
  }>(selectorResult)[0]

  if ('errorMessage' in selectorOutput) {
    yield {
      toolName: 'set_output',
      input: { error: selectorOutput.errorMessage },
    } satisfies ToolCall<'set_output'>
    return
  }
  const { implementationId } = selectorOutput
  const chosenImplementation = implementations.find(
    (implementation) => implementation.id === implementationId,
  )
  if (!chosenImplementation) {
    yield {
      toolName: 'set_output',
      input: { error: 'Failed to find chosen implementation.' },
    } satisfies ToolCall<'set_output'>
    return
  }

  // Apply the chosen implementation using STEP_TEXT (only tool calls, no commentary)
  const toolCallsOnly = extractToolCallsOnly(
    typeof chosenImplementation.content === 'string'
      ? chosenImplementation.content
      : '',
  )
  const { agentState: postEditsAgentState } = yield {
    type: 'STEP_TEXT',
    text: toolCallsOnly,
  } as StepText
  const { messageHistory } = postEditsAgentState
  const lastAssistantMessageIndex = messageHistory.findLastIndex(
    (message) => message.role === 'assistant',
  )
  const editToolResults = messageHistory
    .slice(lastAssistantMessageIndex)
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content)
    .filter((output) => output.type === 'json')
    .map((output) => output.value)

  // Set output with the chosen implementation and reasoning
  yield {
    toolName: 'set_output',
    input: {
      response: chosenImplementation.content,
      toolResults: editToolResults,
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_output'>

  function extractSpawnResults<T>(
    results: any[] | undefined,
  ): (T | { errorMessage: string })[] {
    if (!results) return []
    const spawnedResults = results
      .filter((result) => result.type === 'json')
      .map((result) => result.value)
      .flat() as {
      agentType: string
      value: { value?: T; errorMessage?: string }
    }[]
    return spawnedResults.map(
      (result) =>
        result.value.value ?? {
          errorMessage:
            result.value.errorMessage ?? 'Error extracting spawn results',
        },
    )
  }

  // Extract only tool calls from text, removing any commentary
  function extractToolCallsOnly(text: string): string {
    const toolExtractionPattern =
      /<codebuff_tool_call>\n(.*?)\n<\/codebuff_tool_call>/gs
    const matches: string[] = []

    for (const match of text.matchAll(toolExtractionPattern)) {
      matches.push(match[0]) // Include the full tool call with tags
    }

    return matches.join('\n')
  }
}
function* handleStepsMax({
  agentState,
  params,
  logger,
}: AgentStepContext): ReturnType<
  NonNullable<SecretAgentDefinition['handleSteps']>
> {
  const MAX_N = 5
  const selectorAgent = 'best-of-n-selector-opus'
  const n = Math.min(
    10,
    Math.max(1, (params?.n as number | undefined) ?? MAX_N),
  )

  // Model selection pattern for max mode, using opus and gpt-5
  const MAX_MODEL_PATTERN = [
    'editor-implementor-opus',
    'editor-implementor-gemini',
    'editor-implementor-gpt-5',
    'editor-implementor-opus',
    'editor-implementor-opus',
    'editor-implementor-gpt-5',
    'editor-implementor-gemini',
    'editor-implementor-opus',
    'editor-implementor-opus',
    'editor-implementor-opus',
  ] as const

  // Only keep messages up to just before the last spawn agent tool call.
  const { messageHistory: initialMessageHistory } = agentState
  const lastSpawnAgentMessageIndex = initialMessageHistory.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.length > 0 &&
      message.content[0].type === 'tool-call' &&
      message.content[0].toolName === 'spawn_agents',
  )
  const updatedMessageHistory = initialMessageHistory.slice(
    0,
    lastSpawnAgentMessageIndex,
  )
  yield {
    toolName: 'set_messages',
    input: {
      messages: updatedMessageHistory,
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_messages'>

  // Spawn implementor agents using the model pattern
  const implementorAgents = MAX_MODEL_PATTERN.slice(0, n).map((agent_type) => ({
    agent_type,
  }))

  // Spawn all implementor agents
  const { toolResult: implementorResults } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: implementorAgents,
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  // Extract spawn results
  const spawnedImplementations = extractSpawnResults(
    implementorResults,
  ) as any[]

  // Extract all the plans from the structured outputs
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  // Parse implementations from spawn results
  const implementations = spawnedImplementations.map((result, index) => ({
    id: letters[index],
    content:
      'errorMessage' in result
        ? `Error: ${result.errorMessage}`
        : extractLastMessageText(result),
  }))

  logger.info(
    { spawnedImplementations, implementations },
    'spawnedImplementations',
  )

  // Spawn selector with implementations as params
  const { toolResult: selectorResult, agentState: selectorAgentState } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: [
        {
          agent_type: selectorAgent,
          params: { implementations },
        },
      ],
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  const selectorOutput = extractSpawnResults<{
    value: {
      implementationId: string
      reasoning: string
    }
  }>(selectorResult)[0]

  if ('errorMessage' in selectorOutput) {
    yield {
      toolName: 'set_output',
      input: { error: selectorOutput.errorMessage },
    } satisfies ToolCall<'set_output'>
    return
  }
  const { implementationId } = selectorOutput.value
  const chosenImplementation = implementations.find(
    (implementation) => implementation.id === implementationId,
  )
  if (!chosenImplementation) {
    yield {
      toolName: 'set_output',
      input: { error: 'Failed to find chosen implementation.' },
    } satisfies ToolCall<'set_output'>
    return
  }

  const numMessagesBeforeStepText = selectorAgentState.messageHistory.length

  const { agentState: postEditsAgentState } = yield {
    type: 'STEP_TEXT',
    text: chosenImplementation.content,
  } as StepText
  const { messageHistory } = postEditsAgentState

  // Set output with the messages from running the step text of the chosen implementation
  yield {
    toolName: 'set_output',
    input: {
      messages: messageHistory.slice(numMessagesBeforeStepText),
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_output'>

  /**
   * Extracts the array of subagent results from spawn_agents tool output.
   *
   * The spawn_agents tool result structure is:
   * [{ type: 'json', value: [{ agentName, agentType, value: AgentOutput }] }]
   *
   * Returns an array of agent outputs, one per spawned agent.
   */
  function extractSpawnResults<T>(results: any[] | undefined): T[] {
    if (!results || results.length === 0) return []

    // Find the json result containing spawn results
    const jsonResult = results.find((r) => r.type === 'json')
    if (!jsonResult?.value) return []

    // Get the spawned agent results array
    const spawnedResults = Array.isArray(jsonResult.value)
      ? jsonResult.value
      : [jsonResult.value]

    // Extract the value (AgentOutput) from each result
    return spawnedResults.map((result: any) => result?.value).filter(Boolean)
  }

  /**
   * Extracts the text content from a 'lastMessage' AgentOutput.
   *
   * For agents with outputMode: 'last_message', the output structure is:
   * { type: 'lastMessage', value: [{ role: 'assistant', content: [{ type: 'text', text: '...' }] }] }
   *
   * Returns the text from the last assistant message, or null if not found.
   */
  function extractLastMessageText(agentOutput: any): string | null {
    if (!agentOutput) return null

    // Handle 'lastMessage' output mode - the value contains an array of messages
    if (
      agentOutput.type === 'lastMessage' &&
      Array.isArray(agentOutput.value)
    ) {
      // Find the last assistant message with text content
      for (let i = agentOutput.value.length - 1; i >= 0; i--) {
        const message = agentOutput.value[i]
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          // Find text content in the message
          for (const part of message.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              return part.text
            }
          }
        }
      }
    }
    return null
  }
}

function* handleStepsOpus({
  params,
  logger,
}: AgentStepContext): ReturnType<
  NonNullable<SecretAgentDefinition['handleSteps']>
> {
  const DEFAULT_N = 5
  const selectorAgent = 'best-of-n-selector-opus'
  const n = Math.min(
    10,
    Math.max(1, (params?.n as number | undefined) ?? DEFAULT_N),
  )

  // Spawn implementor agents: 1 gemini + rest sonnet (if n >= 2)
  const implementorAgents = []
  for (let i = 0; i < n; i++) {
    implementorAgents.push({
      agent_type: 'editor-implementor-opus',
    })
  }
  // Spawn all implementor agents
  const { toolResult: implementorResults } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: implementorAgents,
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  // Extract spawn results
  const spawnedImplementations =
    extractSpawnResults<{ text: string }[]>(implementorResults)

  logger.info({ spawnedImplementations }, 'spawnedImplementations')

  // Extract all the plans from the structured outputs
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  // Parse implementations from spawn results
  const implementations = spawnedImplementations.map((result, index) => ({
    id: letters[index],
    content:
      'errorMessage' in result
        ? `Error: ${result.errorMessage}`
        : result[0].text,
  }))

  // Spawn selector with implementations as params
  const { toolResult: selectorResult } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: [
        {
          agent_type: selectorAgent,
          params: { implementations },
        },
      ],
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  const selectorOutput = extractSpawnResults<{
    implementationId: string
    reasoning: string
  }>(selectorResult)[0]

  if ('errorMessage' in selectorOutput) {
    yield {
      toolName: 'set_output',
      input: { error: selectorOutput.errorMessage },
    } satisfies ToolCall<'set_output'>
    return
  }
  const { implementationId } = selectorOutput
  const chosenImplementation = implementations.find(
    (implementation) => implementation.id === implementationId,
  )
  if (!chosenImplementation) {
    yield {
      toolName: 'set_output',
      input: { error: 'Failed to find chosen implementation.' },
    } satisfies ToolCall<'set_output'>
    return
  }

  // Apply the chosen implementation using STEP_TEXT (only tool calls, no commentary)
  const toolCallsOnly = extractToolCallsOnly(
    typeof chosenImplementation.content === 'string'
      ? chosenImplementation.content
      : '',
  )
  const { agentState: postEditsAgentState } = yield {
    type: 'STEP_TEXT',
    text: toolCallsOnly,
  } as StepText
  const { messageHistory } = postEditsAgentState
  const lastAssistantMessageIndex = messageHistory.findLastIndex(
    (message) => message.role === 'assistant',
  )
  const editToolResults = messageHistory
    .slice(lastAssistantMessageIndex)
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content)
    .filter((output) => output.type === 'json')
    .map((output) => output.value)

  // Set output with the chosen implementation and reasoning
  yield {
    toolName: 'set_output',
    input: {
      response: chosenImplementation.content,
      toolResults: editToolResults,
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_output'>

  function extractSpawnResults<T>(
    results: any[] | undefined,
  ): (T | { errorMessage: string })[] {
    if (!results) return []
    const spawnedResults = results
      .filter((result) => result.type === 'json')
      .map((result) => result.value)
      .flat() as {
      agentType: string
      value: { value?: T; errorMessage?: string }
    }[]
    return spawnedResults.map(
      (result) =>
        result.value.value ?? {
          errorMessage:
            result.value.errorMessage ?? 'Error extracting spawn results',
        },
    )
  }

  // Extract only tool calls from text, removing any commentary
  function extractToolCallsOnly(text: string): string {
    const toolExtractionPattern =
      /<codebuff_tool_call>\n(.*?)\n<\/codebuff_tool_call>/gs
    const matches: string[] = []

    for (const match of text.matchAll(toolExtractionPattern)) {
      matches.push(match[0]) // Include the full tool call with tags
    }

    return matches.join('\n')
  }
}

const definition = {
  ...createBestOfNEditor('default'),
  id: 'editor-best-of-n',
}
export default definition
