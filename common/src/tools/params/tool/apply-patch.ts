import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  coerceToObject,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

export const applyPatchResultSchema = z.union([
  z.object({
    message: z.string(),
    applied: z.array(
      z.object({
        file: z.string(),
        action: z.enum(['add', 'update', 'delete']),
      }),
    ),
  }),
  z.object({
    errorMessage: z.string(),
  }),
])

const toolName = 'apply_patch'
const endsAgentStep = false

const operationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_file'),
    path: z.string().min(1, 'Path cannot be empty'),
    diff: z.string().min(1, 'Diff cannot be empty'),
  }),
  z.object({
    type: z.literal('update_file'),
    path: z.string().min(1, 'Path cannot be empty'),
    diff: z.string().min(1, 'Diff cannot be empty'),
  }),
  z.object({
    type: z.literal('delete_file'),
    path: z.string().min(1, 'Path cannot be empty'),
  }),
])

export type ApplyPatchOperation = z.infer<typeof operationSchema>

const inputSchema = z
  .object({
    operation: z.preprocess(coerceToObject, operationSchema).describe(
      'The file operation to perform. type is one of create_file, update_file, or delete_file.',
    ),
  })
  .describe('Apply a file operation (create, update, or delete).')

const description = `
Use this tool to apply file operations using Codex-style apply_patch format.

Each call performs a single operation on one file.

Operation types:
- create_file: Create a new file. Requires path and diff (lines prefixed with +).
- update_file: Update an existing file. Requires path and diff (unified diff with @@ hunks).
- delete_file: Delete a file. Requires only path.

Example (create):
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    operation: {
      type: 'create_file',
      path: 'hello.txt',
      diff: '@@\n+Hello world\n',
    },
  },
  endsAgentStep,
})}

Example (update):
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    operation: {
      type: 'update_file',
      path: 'lib/fib.py',
      diff: '@@\n-def fib(n):\n+def fibonacci(n):\n     if n <= 1:\n         return n\n-    return fib(n-1) + fib(n-2)\n+    return fibonacci(n-1) + fibonacci(n-2)\n',
    },
  },
  endsAgentStep,
})}

Example (delete):
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    operation: {
      type: 'delete_file',
      path: 'old-file.txt',
    },
  },
  endsAgentStep,
})}
`.trim()

export const applyPatchParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(applyPatchResultSchema),
} satisfies $ToolParams
