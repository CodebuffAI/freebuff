import { API_KEY_ENV_VAR } from '@codebuff/common/constants/paths'

import { getWebsiteUrl } from './constants'
import { getCodebuffApiKeyFromEnv } from './env'
import { run } from './run'
import { normalizeByokBaseUrl } from './byok'

import type { RunOptions, CodebuffClientOptions } from './run'
import type { RunState } from './run-state'

export class CodebuffClient {
  public options: CodebuffClientOptions & {
    apiKey: string
    fingerprintId: string
  }

  constructor(options: CodebuffClientOptions) {
    const foundApiKey = options.apiKey ?? getCodebuffApiKeyFromEnv()
    if (!foundApiKey && !options.byok) {
      throw new Error(
        `Codebuff API key not found. Please provide an apiKey in the constructor of CodebuffClient or set the ${API_KEY_ENV_VAR} environment variable.`,
      )
    }

    this.options = {
      handleEvent: (event) => {
        if (event.type === 'error') {
          throw new Error(
            `Received error: ${event.message}.\n\nProvide a handleEvent function to handle this error.`,
          )
        }
      },
      fingerprintId: `codebuff-sdk-${Math.random().toString(36).substring(2, 15)}`,
      ...options,
      // The direct runtime never sends this placeholder anywhere. It keeps the
      // established runtime contract while allowing CLI/Desktop BYOK without a
      // Codebuff account or API key.
      apiKey: foundApiKey ?? 'byok-local',
    }
  }

  /**
   * Run a Codebuff agent with the specified options.
   *
   * @param agent - The agent to run. Use 'base' for the default agent, or specify a custom agent ID if you made your own agent config.
   * @param prompt - The user prompt describing what you want the agent to do.
   * @param params - (Optional) Additional parameters for the agent. Most agents don't use this, but some custom agents can take a JSON object as input in addition to the user prompt string.
   * @param handleEvent - (Optional) Callback function that receives every event during execution (assistant messages, tool calls, etc.). This allows you to stream the agent's progress in real-time. We will likely add a token-by-token streaming callback in the future.
   * @param previousRun - (Optional) JSON state returned from a previous run() call. Use this to continue a conversation or session with the agent, maintaining context from previous interactions.
   * @param projectFiles - (Optional) All the files in your project as a plain JavaScript object. Keys should be the full path from your current directory to each file, and values should be the string contents of the file. Example: { "src/index.ts": "console.log('hi')" }. This helps Codebuff pick good source files for context.
   * @param knowledgeFiles - (Optional) Knowledge files to inject into every run() call. Uses the same schema as projectFiles - keys are file paths and values are file contents. These files are added directly to the agent's context.
   * @param agentDefinitions - (Optional) Array of custom agent definitions. Each object should satisfy the AgentDefinition type. You can input the agent's id field into the agent parameter to run that agent.
   * @param customToolDefinitions - (Optional) Array of custom tool definitions that extend the agent's capabilities. Each tool definition includes a name, Zod schema for input validation, and a handler function. These tools can be called by the agent during execution.
   * @param skillsDir - (Optional) Path to a directory containing skills to load. Each skill should be in its own subdirectory with a SKILL.md file (e.g., `skillsDir/my-skill/SKILL.md`). When provided, skills are loaded from this directory instead of the default locations. The loaded skills will be listed in the `skill` tool's description and can be loaded by the agent.
   * @param maxAgentSteps - (Optional) Maximum number of steps the agent can take before stopping. Use this as a safety measure in case your agent starts going off the rails. A reasonable number is around 20.
   * @param env - (Optional) Environment variables to pass to terminal commands executed by the agent. These will be merged with the current process environment, with the custom values taking precedence. Can also be provided in individual run() calls to override.
   *
   * @returns A Promise that resolves to a RunState JSON object which you can pass to a subsequent run() call to continue the run. Use result.output to get the agent's output.
   */
  public async run(
    options: RunOptions & CodebuffClientOptions,
  ): Promise<RunState> {
    return run({
      ...this.options,
      ...options,
      // An omitted/undefined per-call config inherits the client snapshot.
      // Switching a resumed conversation is refused by run() itself.
      byok: options.byok ?? this.options.byok,
    })
  }

  /**
   * Check connection to the Codebuff backend by hitting the /healthz endpoint.
   *
   * @returns Promise that resolves to true if connected, false otherwise
   */
  public async checkConnection(): Promise<boolean> {
    if (this.options.byok) {
      try {
        await this.options.byok.assertCurrent?.()
        const baseUrl = normalizeByokBaseUrl(
          this.options.byok.provider,
          this.options.byok.baseUrl,
        )
        const response = await fetch(new URL(this.options.byok.provider === 'openrouter' ? 'key' : 'models', baseUrl.replace(/\/?$/, '/')), {
          headers: { Authorization: `Bearer ${this.options.byok.apiKey}` },
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        })
        await response.body?.cancel()
        return response.ok
      } catch {
        return false
      }
    }
    try {
      const response = await fetch(`${getWebsiteUrl()}/api/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      if (!response.ok) return false

      const result = await response.json()
      return (
        typeof result === 'object' &&
        result !== null &&
        'status' in result &&
        (result as { status?: unknown }).status === 'ok'
      )
    } catch {
      return false
    }
  }
}
