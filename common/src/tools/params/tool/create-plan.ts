import z from 'zod/v4'

import { updateFileResultSchema } from './str-replace'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'create_plan'
const endsAgentStep = false
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(
        `The path including the filename of a markdown file that will be overwritten with the plan.`,
      ),
    plan: z
      .string()
      .min(1, 'Plan cannot be empty')
      .describe(`A detailed plan to solve the user's request.`),
  })
  .describe(`Generate a detailed markdown plan for complex tasks.`)
const description = `
Use when:
- User explicitly requests a detailed plan.
- Use this tool to overwrite a previous plan by using the exact same file name.

Don't include:
- Goals, timelines, benefits, next steps.
- Background context or extensive explanations.

For a technical plan, act as an expert architect engineer and provide direction to your editor engineer.
- Study the change request and the current code.
- Describe how to modify the code to complete the request. The editor engineer will rely solely on your instructions, so make them unambiguous and complete.
- Explain all needed code changes clearly and completely, but concisely.
- Just show the changes needed.

What to include in the plan:
- Include key snippets of code -- not full files of it. Use pseudo code. For example, include interfaces between modules, function signatures, and other code that is not immediately obvious should be written out explicitly. Function and method bodies could be written out in psuedo code.
- Do not waste time on much background information, focus on the exact steps of the implementation.
- Do not wrap the path content in markdown code blocks, e.g. \`\`\`.

Do not include any of the following sections in the plan:
- goals
- a timeline or schedule
- benefits/key improvements
- next steps

After creating the plan, you should end turn to let the user review the plan.

Important: Use this tool sparingly. Do not use this tool more than once in a conversation, unless in ask mode.

Examples:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'feature-x-plan.md',
    plan: [
      '1. Create module `auth.ts` in `/src/auth/`.',
      '```ts',
      'export function authenticate(user: User): boolean { /* pseudo-code logic */ }',
      '```',
      '2. Refactor existing auth logic into this module.',
      '3. Update imports across codebase.',
      '4. Write integration tests covering new module logic.',
    ].join('\n'),
  },
  endsAgentStep,
})}
`.trim()

export const createPlanParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(updateFileResultSchema),
} satisfies $ToolParams
