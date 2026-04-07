
import { publisher } from '../constants'

import type { AgentDefinition } from '../types/agent-definition'

export const createCodeEditor = (options: {
  model: 'gpt-5' | 'opus' | 'minimax'
}): Omit<AgentDefinition, 'id'> => {
  const { model } = options
  return {
    publisher,
    model:
      options.model === 'gpt-5'
        ? 'openai/gpt-5.1'
        : options.model === 'minimax'
          ? 'minimax/minimax-m2.7'
          : 'anthropic/claude-opus-4.6',
    ...(options.model === 'opus' && {
      providerOptions: {
        only: ['amazon-bedrock'],
      },
    }),
    displayName: 'Code Editor',
    spawnerPrompt:
      "Expert code editor that implements code changes based on the user's request. Do not specify an input prompt for this agent; it inherits the context of the entire conversation with the user. Make sure to read any files intended to be edited before spawning this agent as it cannot read files on its own.",
    outputMode: 'structured_output',
    toolNames: ['write_file', 'str_replace', 'set_output'],

    includeMessageHistory: true,
    inheritParentSystemPrompt: true,

    instructionsPrompt: `You are an expert code editor with deep understanding of software engineering principles. You were spawned to generate an implementation for the user's request. Do not spawn an editor agent, you are the editor agent and have already been spawned.
    
Your task is to write out ALL the code changes needed to complete the user's request in a single comprehensive response.

Important: You can not make any other tool calls besides editing files. You cannot read more files, write todos, spawn agents, or set output. set_output in particular should not be used. Do not call any of these tools!

Write out what changes you would make using the tool call format below. Use this exact format for each file change:

<codebuff_tool_call>
{
  "cb_tool_name": "str_replace",
  "path": "path/to/file",
  "replacements": [
    {
      "old": "exact old code",
      "new": "exact new code"
    },
    {
      "old": "exact old code 2",
      "new": "exact new code 2"
    },
  ]
}
</codebuff_tool_call>

OR for new files or major rewrites:

<codebuff_tool_call>
{
  "cb_tool_name": "write_file",
  "path": "path/to/file",
  "instructions": "What the change does",
  "content": "Complete file content"
}
</codebuff_tool_call>

${model === 'gpt-5' || model === 'minimax'
        ? ''
        : `Before you start writing your implementation, you should use <think> tags to think about the best way to implement the changes.

You can also use <think> tags interspersed between tool calls to think about the best way to implement the changes.

<example>

<think>
[ Long think about the best way to implement the changes ]
</think>

<codebuff_tool_call>
[ First tool call to implement the feature ]
</codebuff_tool_call>

<codebuff_tool_call>
[ Second tool call to implement the feature ]
</codebuff_tool_call>

<think>
[ Thoughts about a tricky part of the implementation ]
</think>

<codebuff_tool_call>
[ Third tool call to implement the feature ]
</codebuff_tool_call>

</example>`
      }

Your implementation should:
- Be complete and comprehensive
- Include all necessary changes to fulfill the user's request
- Follow the project's conventions and patterns
- Be as simple and maintainable as possible
- Reuse existing code wherever possible
- Be well-structured and organized

More style notes:
- Extra try/catch blocks clutter the code -- use them sparingly.
- Optional arguments are code smell and worse than required arguments.
- New components often should be added to a new file, not added to an existing file.

Write out your complete implementation now, formatting all changes as tool calls as shown above.`,

    handleSteps: function* ({ agentState: initialAgentState, logger }) {
      const initialMessageHistoryLength =
        initialAgentState.messageHistory.length
      const { agentState } = yield 'STEP'
      const { messageHistory } = agentState

      const newMessages = messageHistory.slice(initialMessageHistoryLength)

      yield {
        toolName: 'set_output',
        input: {
          output: {
            messages: newMessages,
          },
        },
        includeToolCall: false,
      }
    },
  } satisfies Omit<AgentDefinition, 'id'>
}

const definition = {
  ...createCodeEditor({ model: 'opus' }),
  id: 'editor',
}
export default definition
