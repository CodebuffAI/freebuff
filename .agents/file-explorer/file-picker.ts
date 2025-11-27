import { StepText, ToolCall } from 'types/agent-definition'
import { publisher } from '../constants'

import {
  PLACEHOLDER,
  type SecretAgentDefinition,
} from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'file-picker',
  displayName: 'Fletcher the File Fetcher',
  publisher,
  model: 'google/gemini-2.0-flash-001',
  reasoningOptions: {
    enabled: false,
    effort: 'low',
    exclude: false,
  },
  spawnerPrompt:
    'Spawn to find relevant files in a codebase related to the prompt. Outputs up to 12 file paths with short summaries for each file. Cannot do string searches on the codebase, but does a fuzzy search. Unless you know which directories are relevant, omit the directories parameter. This agent is extremely effective at finding files in the codebase that could be relevant to the prompt.',
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
  toolNames: ['spawn_agents'],
  spawnableAgents: ['file-lister'],

  systemPrompt: `You are an expert at finding relevant files in a codebase. ${PLACEHOLDER.FILE_TREE_PROMPT}`,
  instructionsPrompt: `Instructions:
Provide an extremely short report of the locations in the codebase that could be helpful. Focus on the files that are most relevant to the user prompt.
In your report, please give a very concise analysis that includes the full paths of files that are relevant and (extremely briefly) how they could be useful.

Do not use any further tools or spawn any further agents.
  `.trim(),

  handleSteps: function* ({ prompt, params, logger }) {
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
    const firstResult = spawnResults[0]
    const fileListText = extractLastMessageText(firstResult)
    
    if (!fileListText) {
      const errorMessage = extractErrorMessage(firstResult)
      yield {
        type: 'STEP_TEXT',
        text: errorMessage 
          ? `Error from file-lister: ${errorMessage}`
          : 'Error: Could not extract file list from spawned agent',
      } satisfies StepText
      return
    }

    const paths = fileListText.split('\n').filter(Boolean)

    yield {
      toolName: 'read_files',
      input: {
        paths,
      },
    }

    yield 'STEP'

    /**
     * Extracts the array of subagent results from spawn_agents tool output.
     * 
     * The spawn_agents tool result structure is:
     * [{ type: 'json', value: [{ agentName, agentType, value: AgentOutput }] }]
     * 
     * Returns an array of agent outputs, one per spawned agent.
     */
    function extractSpawnResults(results: any[] | undefined): any[] {
      if (!results || results.length === 0) return []
      
      // Find the json result containing spawn results
      const jsonResult = results.find((r) => r.type === 'json')
      if (!jsonResult?.value) return []
      
      // Get the spawned agent results array
      const spawnedResults = Array.isArray(jsonResult.value) ? jsonResult.value : [jsonResult.value]
      
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
      if (agentOutput.type === 'lastMessage' && Array.isArray(agentOutput.value)) {
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

    /**
     * Extracts the error message from an AgentOutput if it's an error type.
     * 
     * Returns the error message string, or null if not an error output.
     */
    function extractErrorMessage(agentOutput: any): string | null {
      if (!agentOutput) return null
      
      if (agentOutput.type === 'error') {
        return agentOutput.message ?? agentOutput.value ?? null
      }
      
      return null
    }
  },
}

export default definition
