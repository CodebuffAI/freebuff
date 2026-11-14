import z from 'zod/v4'

import { proposeUpdateFileResultSchema } from './propose-str-replace'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'propose_write_file'
const endsAgentStep = false
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(`Path to the file relative to the **project root**`),
    instructions: z
      .string()
      .optional()
      .describe('What the change is intended to do in only one sentence.'),
    content: z.string().describe(`Complete file content to write to the file.`),
  })
  .describe(
    `Propose creating or editing a file without actually applying the changes.`,
  )
const description = `
Propose creating or editing a file without actually applying the changes.

This tool works identically to write_file but the changes are not written to disk. Instead, it returns the unified diff of what would change. Each call overwrites the previous call.

Format the \`content\` parameter with the entire content of the file.

This tool is to be used in subagents.

Example - Simple file creation:
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

Example - Overwriting a file:
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

export const proposeWriteFileParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(proposeUpdateFileResultSchema),
} satisfies $ToolParams
