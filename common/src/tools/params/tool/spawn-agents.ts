import z from 'zod/v4'

import { jsonObjectSchema } from '../../../types/json'
import {
  $getNativeToolCallExampleString,
  coerceToArray,
  coerceToObject,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

export const spawnAgentsOutputSchema = z
  .object({
    agentType: z.string(),
  })
  .and(jsonObjectSchema)
  .array()

/** Most agents one spawn_agents call may spawn; the runtime handler refuses a
 *  bigger batch with the same number, so bypassing this schema changes nothing. */
export const MAX_SPAWN_AGENTS_PER_CALL = 6

const toolName = 'spawn_agents'
const endsAgentStep = true
const inputSchema = z
  .object({
    agents: z.preprocess(
      coerceToArray,
      z
        .object({
          agent_type: z.string().describe('Agent to spawn'),
          prompt: z.string().optional().describe('Prompt to send to the agent'),
          params: z
            .preprocess(
              coerceToObject,
              z
                .object({
                  // Common agent fields (all optional hints — each agent validates its own required fields)
                  command: z
                    .string()
                    .optional()
                    .describe('Terminal command to run (basher, tmux-cli)'),
                  what_to_summarize: z
                    .string()
                    .optional()
                    .describe(
                      'What information from the command output is desired (basher)',
                    ),
                  timeout_seconds: z
                    .number()
                    .optional()
                    .describe(
                      'Timeout for command. Set to -1 for no timeout. Default 30 (basher)',
                    ),
                  searchQueries: z
                    .array(
                      z.object({
                        pattern: z
                          .string()
                          .describe('The pattern to search for'),
                        flags: z
                          .string()
                          .optional()
                          .describe(
                            'Optional ripgrep flags (e.g., "-i", "-g *.ts")',
                          ),
                        cwd: z
                          .string()
                          .optional()
                          .describe(
                            'Optional working directory relative to project root',
                          ),
                        maxResults: z
                          .number()
                          .optional()
                          .describe('Max results per file. Default 15'),
                      }),
                    )
                    .optional()
                    .describe('Array of code search queries (code-searcher)'),
                  filePaths: z
                    .array(z.string())
                    .optional()
                    .describe(
                      'Relevant file paths to read (opus-agent, gpt-5-agent)',
                    ),
                  directories: z
                    .array(z.string())
                    .optional()
                    .describe('Directories to search within (file-picker)'),
                  url: z
                    .string()
                    .optional()
                    .describe('Starting URL to navigate to (browser-use)'),
                  prompts: z
                    .array(z.string())
                    .optional()
                    .describe(
                      'Array of strategy prompts (editor-multi-prompt, code-reviewer-multi-prompt)',
                    ),
                })
                .catchall(z.any()),
            )
            .optional()
            .describe('Parameters object for the agent'),
        })
        .array()
        // One swarm at a time, and never a big one: a free-mode root once
        // fanned out to 21 subagents in a single call (2026-10-10). The
        // runtime handler enforces the same ceiling, so a caller that
        // bypasses the schema still cannot.
        .max(
          MAX_SPAWN_AGENTS_PER_CALL,
          `Spawn at most ${MAX_SPAWN_AGENTS_PER_CALL} agents in one call. For more, spawn again after these return.`,
        ),
    ),
  })
  .describe(
    `Spawn multiple agents and send a prompt and/or parameters to each of them. These agents will run in parallel. Note that that means they will run independently. If you need to run agents sequentially, use spawn_agents with one agent at a time instead. At most 6 agents per call.`,
  )
const description = `
Use this tool to spawn agents to help you complete the user request. Each agent has specific requirements for prompt and params based on their tools schema.

The prompt field is a simple string, while params is a JSON object that gets validated against the agent's schema.

Each agent available is already defined as another tool, or, dynamically defined later in the conversation.

**IMPORTANT**: \`agent_type\` must be an actual agent name (e.g., \`basher\`, \`code-searcher\`, \`opus-agent\`), NOT a tool name like \`read_files\`, \`str_replace\`, \`code_search\`, etc. If you need to call a tool, use it directly as a tool call instead of wrapping it in spawn_agents.

You can call agents either as direct tool calls (using the listed tool name, e.g. \`example_agent\`) or use \`spawn_agents\` with the canonical agent name in \`agent_type\` (e.g. \`example-agent\`). Both formats work, but **prefer using spawn_agents** because it allows you to spawn multiple agents in parallel for better performance. Both use the same schema with nested \`prompt\` and \`params\` fields.

**IMPORTANT**: Many agents have REQUIRED fields in their params schema. Check the agent's schema before spawning - if params has required fields, you MUST include them in the params object. For example, code-searcher requires \`searchQueries\`, basher requires \`command\`.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    agents: [
      {
        agent_type: 'basher',
        prompt: 'Check if tests pass',
        params: {
          command: 'npm test',
        },
      },
      {
        agent_type: 'code-searcher',
        params: {
          searchQueries: [{ pattern: 'authenticate', flags: '-g *.ts' }],
        },
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const spawnAgentsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(spawnAgentsOutputSchema),
} satisfies $ToolParams
