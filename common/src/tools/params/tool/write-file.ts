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
      .describe(`Path to the file relative to the **project root**`),
    instructions: z
      .string()
      .describe('What the change is intended to do in only one sentence.'),
    content: z.string().describe(`Edit snippet to apply to the file.`),
  })
  .describe(`Create or edit a file with the given content.`)
const description = `
Create or replace a file with the given content.

####  Edit Snippet

Format the \`content\` parameter with the entire content of the file or as an edit snippet that describes how you would like to modify the provided existing code.

You may abbreviate any sections of the code in your response that will remain the same with placeholder comments: "// ... existing code ...". Abbreviate as much as possible to save the user credits!

If you don't use any placeholder comments, the entire file will be replaced. E.g. don't write out a single function without using placeholder comments unless you want to replace the entire file with that function.

#### Additional Info

Prefer str_replace to write_file for most edits, including small-to-medium edits to a file, for deletions, or for editing large files (>1000 lines). Otherwise, prefer write_file for major edits throughout a file, or for creating new files.

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

Example 2 - Editing with placeholder comments:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'foo.ts',
    instructions: 'Update foo and remove console.log',
    content: `// ... existing code ...

function foo() {
  console.log('foo');
  for (let i = 0; i < 10; i++) {
    console.log(i);
  }
  doSomething();

  // Delete the console.log line from here

  doSomethingElse();
}

// ... existing code ...`,
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
