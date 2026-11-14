import z from 'zod/v4'

import { $getNativeToolCallExampleString, coerceToArray, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'suggest_followups'
const endsAgentStep = false

const followupSchema = z.object({
  prompt: z
    .string()
    .describe(
      'The prompt text to send as a user message when clicked. Keep it short and goal-oriented — one sentence naming the outcome, not the steps to get there',
    ),
  label: z
    .string()
    .optional()
    .describe(
      'Short display label for the card (defaults to truncated prompt if not provided)',
    ),
})

export type SuggestFollowup = z.infer<typeof followupSchema>

const inputSchema = z
  .object({
    followups: z
      .preprocess(
        coerceToArray,
        z
          .array(followupSchema)
          .min(1, 'Must provide at least one followup'),
      )
      .describe(
        'List of suggested followup prompts the user can click to send',
      ),
  })
  .describe(
    `Suggest clickable followup prompts to the user. Each followup becomes a card the user can click to send that prompt.`,
  )

const outputSchema = z.object({
  message: z.string(),
})

const description = `
Suggest clickable followup prompts to the user. When the user clicks a suggestion, it sends that prompt as a new user message.

Use this tool after completing a task to suggest what the user might want to do next. Write your complete answer or result as plain text first, then call this tool as the last thing in your turn, with no tool call after it; never put the answer inside the tool. Good suggestions include:
- Alternatives to the latest implementation like "Cache the data in local storage instead"
- Related features like "Show the state data in a hover card"
- Cleanup opportunities like "Split app.ts into focused modules"
- Testing suggestions like "Add unit tests for this change"
- Verification you can run yourself like "Check the login flow in the browser and fix what breaks"
- "Continue with the next step" - when there are more steps in a plan

Keep every suggestion short and goal-oriented: one sentence naming the outcome you want, not the steps to get there. Whoever picks up the prompt does better work when free to choose the approach, so leave out file paths, function names, ordering, and design decisions unless one of those is the actual point of the request. A prompt still has to stand on its own — name the target clearly, just don't narrate a plan.

Don't include suggestions like:
- "Commit these changes"
- Anything the user would have to carry out themselves, like "Ask your designer whether this matches the spec" — as opposed to "Add test coverage for the login flow", which is a goal the assistant can own. Judge by the tools you actually have: work you can do yourself is a goal, not a chore.

Try to make different suggestions than you did in past steps. That's because users can still click previous suggestions if they want to.

Aim for around 3 suggestions. The suggestions persist and remain clickable, with clicked ones visually updated to show they were used.

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    followups: [
      {
        prompt: 'Continue with the next step',
        label: 'Continue',
      },
      {
        prompt: 'Add unit tests for UserService',
        label: 'Add tests',
      },
      {
        prompt: 'Pull the auth logic out of the request handler',
        label: 'Refactor auth',
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const suggestFollowupsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(outputSchema),
} satisfies $ToolParams
