import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import { AskUserBridge } from '@codebuff/common/utils/ask-user-bridge'
import { CodebuffClient } from '@codebuff/sdk'

import { getAuthTokenDetails } from './auth'
import { getCliEnv, getSystemProcessEnv } from './env'
import { loadAgentDefinitions } from './local-agent-registry'
import { logger } from './logger'
import { createTraceWriter } from './trace-writer'
import { terminalCommandBroker } from './terminal-command-broker'
import { getRgPath } from '../native/ripgrep'
import { getProjectRoot } from '../project-files'

import type { ClientToolCall } from '@codebuff/common/tools/list'

let clientInstance: CodebuffClient | null = null

// Test-only escape hatch: tests inject a controllable client factory instead
// of constructing a real SDK client (see docs/testing.md: DI over module
// mocking — mock.module leaks across bun test files).
let clientFactoryOverride: (() => Promise<CodebuffClient | null>) | undefined

export function setClientFactoryOverrideForTesting(
  factory: (() => Promise<CodebuffClient | null>) | undefined,
): void {
  clientFactoryOverride = factory
  clientInstance = null
}

/**
 * Recursively removes undefined values from an object to ensure clean JSON serialization.
 * This prevents issues with APIs that don't accept explicit undefined values.
 */
function removeUndefinedValues<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedValues) as T
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = removeUndefinedValues(value)
      }
    }
    return result as T
  }
  return obj
}

/**
 * Reset the cached CodebuffClient instance.
 * This should be called after login to ensure the client is re-initialized with new credentials.
 */
export function resetCodebuffClient(): void {
  clientInstance = null
}

export async function getCodebuffClient(): Promise<CodebuffClient | null> {
  if (!clientInstance) {
    if (clientFactoryOverride) {
      clientInstance = await clientFactoryOverride()
      return clientInstance
    }
    const { token: apiKey } = getAuthTokenDetails()

    if (!apiKey) {
      logger.warn(
        {},
        `No authentication token found. Please run the login flow or set ${API_KEY_ENV_VAR}.`,
      )
      return null
    }

    const projectRoot = getProjectRoot()

    // Set up ripgrep path for SDK to use
    const env = getCliEnv()
    if (env.CODEBUFF_IS_BINARY) {
      try {
        const rgPath = await getRgPath()
        // Note: We still set process.env here because SDK reads from it
        getSystemProcessEnv().CODEBUFF_RG_PATH = rgPath
      } catch (error) {
        logger.error(error, 'Failed to set up ripgrep binary for SDK')
      }
    }

    try {
      const agentDefinitions = loadAgentDefinitions()
      clientInstance = new CodebuffClient({
        apiKey,
        cwd: projectRoot,
        // Keeps the model's skill list identical to the one the registry shows
        // (utils/skill-registry.ts). The SDK default is project-only so that a
        // server embedding it cannot read a home directory by omission; the
        // CLI runs on the user's machine, so it opts back in.
        includeHomeSkills: true,
        agentDefinitions,
        logger,
        traceWriter: createTraceWriter(),
        terminalCommandBroker,
        overrideTools: {
          ask_user: async (input: ClientToolCall<'ask_user'>['input']) => {
            const askUserResponse = await AskUserBridge.request(
              'cli-override',
              input.questions,
            )
            const response = askUserResponse as {
              answers?: Array<{ questionIndex: number; selectedOption: string }>
              skipped?: boolean
            }
            return [
              {
                type: 'json',
                value: removeUndefinedValues(response),
              },
            ]
          },
        },
      })
    } catch (error) {
      logger.error(error, 'Failed to initialize CodebuffClient')
      return null
    }
  }

  return clientInstance
}

export function getToolDisplayInfo(toolName: string): {
  name: string
  type: string
} {
  const TOOL_NAME_OVERRIDES: Record<string, string> = {
    list_directory: 'List Directories',
  }

  const capitalizeWords = (str: string) => {
    return str.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  }

  return {
    name: TOOL_NAME_OVERRIDES[toolName] ?? capitalizeWords(toolName),
    type: 'tool',
  }
}

function toYaml(obj: any, indent = 0): string {
  const spaces = '  '.repeat(indent)

  if (obj === null || obj === undefined) {
    return 'null'
  }

  if (typeof obj === 'string') {
    if (obj.includes('\n')) {
      const lines = obj.split('\n')
      return (
        '|\n' + lines.map((line) => '  '.repeat(indent + 1) + line).join('\n')
      )
    }
    return obj.includes(':') || obj.includes('#') ? `"${obj}"` : obj
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return String(obj)
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return (
      '\n' +
      obj
        .map((item) => spaces + '- ' + toYaml(item, indent + 1).trimStart())
        .join('\n')
    )
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj)
    if (entries.length === 0) return '{}'

    return entries
      .map(([key, value]) => {
        const yamlValue = toYaml(value, indent + 1)
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          Object.keys(value).length > 0
        ) {
          return `${spaces}${key}:\n${yamlValue}`
        }
        if (typeof value === 'string' && value.includes('\n')) {
          return `${spaces}${key}: ${yamlValue}`
        }
        return `${spaces}${key}: ${yamlValue}`
      })
      .join('\n')
  }

  return String(obj)
}

export function formatToolOutput(output: unknown): string {
  if (!output) return ''

  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (item.type === 'json') {
          // Handle errorMessage in the value object
          if (
            item.value &&
            typeof item.value === 'object' &&
            'errorMessage' in item.value
          ) {
            return String(item.value.errorMessage)
          }
          return toYaml(item.value)
        }
        if (item.type === 'text') {
          return item.text || ''
        }
        return String(item)
      })
      .join('\n')
  }

  if (typeof output === 'string') {
    return output
  }

  return toYaml(output)
}
