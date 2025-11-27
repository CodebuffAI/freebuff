import { publisher } from '../../constants'

import type { SecretAgentDefinition } from '../../types/secret-agent-definition'

export const createBestOfNImplementor = (options: {
  model: 'sonnet' | 'opus' | 'gpt-5' | 'gemini'
}): Omit<SecretAgentDefinition, 'id'> => {
  const { model } = options
  const isSonnet = model === 'sonnet'
  const isOpus = model === 'opus'
  const isGpt5 = model === 'gpt-5'
  const isGemini = model === 'gemini'

  return {
    publisher,
    model: isSonnet
      ? 'anthropic/claude-sonnet-4.5'
      : isOpus
        ? 'anthropic/claude-opus-4.5'
        : isGemini
          ? 'google/gemini-3-pro-preview'
          : 'openai/gpt-5.1',
    displayName: 'Implementation Generator',
    spawnerPrompt:
      'Generates a complete implementation plan with all code changes',

    includeMessageHistory: true,
    inheritParentSystemPrompt: true,

    toolNames: [],
    spawnableAgents: [],

    inputSchema: {},
    outputMode: 'last_message',

    instructionsPrompt: `You are an expert code editor with deep understanding of software engineering principles. You were spawned to generate an implementation for the user's request.
    
Your task is to write out ALL the code changes needed to complete the user's request in a single comprehensive response.

Important: You can not make any other tool calls besides editing files. You cannot read more files, write todos, spawn agents, or set output. Do not call any of these tools!

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
  "content": "Complete file content or edit snippet"
}
</codebuff_tool_call>
${
  isGpt5 || isGemini
    ? ``
    : `
You can also use <think> tags interspersed between tool calls to think about the best way to implement the changes. Keep these thoughts very brief. You may not need to use think tags at all.

<example>

<think>
[ Thoughts about the best way to implement the feature ]
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

After the edit tool calls, you can optionally mention any follow-up steps to take, like deleting a file, or a sepcific way to validate the changes. There's no need to use the set_output tool as your entire response will be included in the output.

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

    handleSteps: function* () {
      yield 'STEP'
    },
  }
}
const definition = {
  ...createBestOfNImplementor({ model: 'sonnet' }),
  id: 'editor-implementor',
}
export default definition
