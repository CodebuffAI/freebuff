import { buildArray } from '@codebuff/common/util/array'

import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

export const createGeneralAgent = (options: {
  model: 'gpt-5' | 'opus'
}): Omit<SecretAgentDefinition, 'id'> => {
  const { model } = options
  const isGpt5 = model === 'gpt-5'

  return {
    publisher,
    model: isGpt5 ? 'openai/gpt-5.4' : 'anthropic/claude-opus-4.7',
    ...(!isGpt5 && {
      providerOptions: {
        only: ['amazon-bedrock'],
      },
    }),
    ...(isGpt5 && {
      reasoningOptions: {
        effort: 'high' as const,
      },
    }),
    displayName: isGpt5 ? 'GPT-5 Agent' : 'Opus Agent',
    spawnerPrompt:
      isGpt5 ?
        'A general-purpose, deep-thinking (and slow) agent that can be used to solve a wide range of problems. Use this to help you solve a specific problem that requires extended reasoning. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.'
        : 'A general-purpose capable agent that can be used to solve a wide range of problems. Use this to help you solve any problem. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'The problem you are trying to solve',
      },
      params: {
        type: 'object',
        properties: {
          filePaths: {
            type: 'array',
            items: {
              type: 'string',
              description: 'The path to a file',
            },
            description:
              'A list of relevant file paths to read before thinking. Try to provide ALL the files that could be relevant to your request.',
          },
        },
      },
    },
    outputMode: 'last_message',
    spawnableAgents: buildArray(
      'researcher-web',
      'researcher-docs',
      !isGpt5 && 'file-picker',
      'code-searcher',
      'directory-lister',
      'glob-matcher',
      'basher',
      'context-pruner',
    ),
    toolNames: [
      'spawn_agents',
      'read',
      'read_files',
      'read_subtree',
      'str_replace',
      'write_file',
    ],

    instructionsPrompt: buildArray(
      `Use the spawn_agents tool to spawn agents to help you complete the user request.`,
      !isGpt5 && `If you need to find more information in the codebase, file-picker is really good at finding relevant files. You should spawn multiple agents in parallel when possible to speed up the process. (e.g. spawn 3 file-pickers + 1 code-searcher + 1 researcher-web in one spawn_agents call or 3 bashers in one spawn_agents call).`,
    ).join('\n'),

    handleSteps: function* ({ params }) {
      const filePaths = params?.filePaths as string[] | undefined

      if (filePaths && filePaths.length > 0) {
        yield {
          toolName: 'read_files',
          input: { paths: filePaths },
        }
      }

      while (true) {
        // Run context-pruner before each step
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'context-pruner',
            params: params ?? {},
          },
          includeToolCall: false,
        } as any

        const { stepsComplete } = yield 'STEP'
        if (stepsComplete) break
      }
    },
  }
}
