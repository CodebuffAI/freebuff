import z from 'zod/v4'

import { updateFileResultSchema } from './str-replace'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'write_file'
const endsAgentStep = false
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(
        `Path to the file, relative to the **project root**. Local hosts (CLI, Desktop, SDK) also accept an absolute path, which is not limited to the project.`,
      ),
    instructions: z
      .string()
      .describe('What the change is intended to do in only one sentence.'),
    content: z.string().describe(`Complete file content to write to the file.`),
  })
  .describe(`Create or overwrite a file with the given content.`)
const description = `
Create or replace a file with the given content.

Format the \`content\` parameter with the entire content of the file.

#### Additional Info

Do not use this tool to delete or rename a file. Instead run a terminal command for that.

Examples:

Example 1 - Simple file creation:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'new-file.ts',
    instructions: 'Prints Hello, world',
    content: 'console.log("Hello, world!");',
  },
  endsAgentStep,
})}

Example 2 - Overwriting a file:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'foo.ts',
    instructions: 'Update foo function',
    content: `function foo() {
  doSomethingNew();
}
  
function bar() {
  doSomethingOld();
}
`,
  },
  endsAgentStep,
})}
`.trim()

export const writeFileParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(updateFileResultSchema),
} satisfies $ToolParams
