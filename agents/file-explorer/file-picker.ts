import { FREEBUFF_GPT_6_LUNA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from '../constants'
import {
  PLACEHOLDER,
  type SecretAgentDefinition,
} from '../types/secret-agent-definition'

import type { StepText, ToolCall } from '../types/agent-definition'

type FilePickerMode = 'default' | 'max'

export const createFilePicker = (
  mode: FilePickerMode,
): Omit<SecretAgentDefinition, 'id'> => {
  const isMax = mode === 'max'

  return {
    displayName: 'Fletcher the File Fetcher',
    publisher,
    model: FREEBUFF_GPT_6_LUNA_MODEL_ID,
    reasoningOptions: {
      effort: 'none',
      exclude: true,
    },
    spawnerPrompt: `Spawn to find relevant files in a codebase related to the prompt. Outputs up to ${isMax ? 20 : 12} file paths with short summaries for each file. Cannot do string searches on the codebase, but does a fuzzy search. Unless you know which directories are relevant, omit the directories parameter. This agent is extremely effective at finding files in the codebase that could be relevant to the prompt.`,
    inputSchema: {
      prompt: {
        type: 'string',
        description:
          'A description of the files you need to find. Be more broad for better results: instead of "Find x file" say "Find x file and related files". This agent is designed to help you find several files that could be relevant to the prompt.',
      },
      params: {
        type: 'object' as const,
        properties: {
          directories: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description:
              'Optional list of paths to directories to look within. If omitted, the entire project tree is used.',
          },
        },
        required: [],
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: false,
    // handleSteps spawns the lister, so the report step gets no tools: offered
    // spawn_agents, the model spawned its example code-searcher instead.
    toolNames: [],
    spawnableAgents: isMax
      ? ['file-lister-max']
      : ['file-lister'],

    systemPrompt: `You are an expert at finding relevant files in a codebase. ${PLACEHOLDER.FILE_TREE_PROMPT}`,
    instructionsPrompt: `Instructions:
Provide an extremely short report of the locations in the codebase that could be helpful. Focus on the files that are most relevant to the user prompt.
In your report, please give a very concise analysis that includes the full paths of files that are relevant and (extremely briefly) how they could be useful.

Do not use any further tools or spawn any further agents.
  `.trim(),

    handleSteps: isMax ? handleStepsMax : handleStepsDefault,
  }
}

// handleSteps for default mode - spawns 1 file-lister
const handleStepsDefault: SecretAgentDefinition['handleSteps'] = function* ({
  prompt,
  params,
}) {
  const { toolResult: fileListerResults } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: [
        {
          agent_type: 'file-lister',
          prompt: prompt ?? '',
          params: params ?? {},
        },
      ],
    },
  } satisfies ToolCall

  const spawnResults = extractSpawnResults(fileListerResults)

  // Collect paths from all agents and deduplicate
  const allPaths = new Set<string>()
  let hasAnyResults = false

  for (const result of spawnResults) {
    const fileListText = typeof result === 'string' ? result : null
    if (fileListText) {
      hasAnyResults = true
      const paths = fileListText.split('\n').filter(Boolean)
      for (const path of paths) {
        allPaths.add(path)
      }
    }
  }

  if (!hasAnyResults) {
    const errorMessages = spawnResults
      .map(extractErrorMessage)
      .filter(Boolean)
      .join('; ')
    yield {
      type: 'STEP_TEXT',
      text: errorMessages
        ? `Error from file-lister(s): ${errorMessages}`
        : 'Error: Could not extract file list from spawned agent(s)',
    } satisfies StepText
    return
  }

  const paths = Array.from(allPaths)

  yield {
    toolName: 'read_files',
    input: { paths },
  }

  yield 'STEP'

  function extractSpawnResults(results: any[] | undefined): any[] {
    if (!results || results.length === 0) return []
    const jsonResult = results.find((r) => r.type === 'json')
    if (!jsonResult?.value) return []
    const spawnedResults = Array.isArray(jsonResult.value)
      ? jsonResult.value
      : [jsonResult.value]
    return spawnedResults.map((result: any) => result?.value).filter(Boolean)
  }

  function extractErrorMessage(agentOutput: any): string | null {
    if (!agentOutput) return null
    if (agentOutput.type === 'error') {
      return agentOutput.message ?? agentOutput.value ?? null
    }
    return null
  }
}

// handleSteps for max mode - spawns 1 file-lister-max
const handleStepsMax: SecretAgentDefinition['handleSteps'] = function* ({
  prompt,
  params,
}) {
  const { toolResult: fileListerResults } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: [
        {
          agent_type: 'file-lister-max',
          prompt: prompt ?? '',
          params: params ?? {},
        },
      ],
    },
  } satisfies ToolCall

  const spawnResults = extractSpawnResults(fileListerResults)

  // Collect paths from all agents and deduplicate
  const allPaths = new Set<string>()
  let hasAnyResults = false

  for (const result of spawnResults) {
    const fileListText = typeof result === 'string' ? result : null
    if (fileListText) {
      hasAnyResults = true
      const paths = fileListText.split('\n').filter(Boolean)
      for (const path of paths) {
        allPaths.add(path)
      }
    }
  }

  if (!hasAnyResults) {
    const errorMessages = spawnResults
      .map(extractErrorMessage)
      .filter(Boolean)
      .join('; ')
    yield {
      type: 'STEP_TEXT',
      text: errorMessages
        ? `Error from file-lister(s): ${errorMessages}`
        : 'Error: Could not extract file list from spawned agent(s)',
    } satisfies StepText
    return
  }

  const paths = Array.from(allPaths)

  yield {
    toolName: 'read_files',
    input: { paths },
  }

  yield 'STEP'

  function extractSpawnResults(results: any[] | undefined): any[] {
    if (!results || results.length === 0) return []
    const jsonResult = results.find((r) => r.type === 'json')
    if (!jsonResult?.value) return []
    const spawnedResults = Array.isArray(jsonResult.value)
      ? jsonResult.value
      : [jsonResult.value]
    return spawnedResults.map((result: any) => result?.value).filter(Boolean)
  }

  function extractErrorMessage(agentOutput: any): string | null {
    if (!agentOutput) return null
    if (agentOutput.type === 'error') {
      return agentOutput.message ?? agentOutput.value ?? null
    }
    return null
  }
}

const definition: SecretAgentDefinition = {
  id: 'file-picker',
  ...createFilePicker('default'),
}

export default definition
