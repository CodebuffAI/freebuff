import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import type { JSONValue } from '../types/util-types'

interface SearchQuery {
  pattern: string
  flags?: string
  cwd?: string
  maxResults?: number
}

const paramsSchema = {
  type: 'object',
  properties: {
    searchQueries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The pattern to search for',
          },
          flags: {
            type: 'string',
            description:
              'Optional ripgrep flags to customize the search (e.g., "-i" for case-insensitive, "-g *.ts -g *.js" for TypeScript and JavaScript files only, "-g !*.test.ts" to exclude Typescript test files, "-A 3" for 3 lines after match, "-B 2" for 2 lines before match).',
          },
          cwd: {
            type: 'string',
            description:
              'Optional working directory to search within, relative to the project root. Defaults to searching the entire project',
          },
          maxResults: {
            type: 'number',
            description:
              'Maximum number of results to return per file. Defaults to 15. There is also a global limit of 250 results across all files',
          },
        },
        required: ['pattern'],
      },
      description: 'Array of code search queries to execute',
    },
  },
  required: ['searchQueries'],
} as const

const codeSearcher: SecretAgentDefinition = {
  id: 'code-searcher',
  displayName: 'Code Searcher',
  spawnerPrompt:
    'Mechanically runs multiple code search queries (using ripgrep line-oriented search) and returns up to 250 results across all source files, showing each line that matches the search pattern. Excludes git-ignored files. You MUST pass searchQueries in params. Example input: { "params": { "searchQueries": [{ "pattern": "createUser", "flags": "-g *.ts" }, { "pattern": "deleteUser", "flags": "-g *.ts" }, { "pattern": "UserSchema", "maxResults": 5 }] } }',
  model: 'anthropic/claude-sonnet-4.5',
  publisher,
  includeMessageHistory: false,
  toolNames: ['code_search', 'set_output'],
  spawnableAgents: [],
  inputSchema: {
    params: paramsSchema,
  },
  outputMode: 'structured_output',

  *handleSteps({ params }) {
    const searchQueries: SearchQuery[] = params?.searchQueries ?? []
    const toolResults: JSONValue[] = []

    for (const query of searchQueries) {
      const { toolResult } = yield {
        toolName: 'code_search',
        input: {
          pattern: query.pattern,
          flags: query.flags,
          cwd: query.cwd,
          maxResults: query.maxResults,
        },
      }

      if (Array.isArray(toolResult)) {
        for (const result of toolResult) {
          if (result?.type === 'json' && result.value !== undefined) {
            toolResults.push(result.value)
          }
        }
      }
    }

    yield {
      toolName: 'set_output',
      input: {
        message: '',
        results: toolResults,
      },
      includeToolCall: false,
    }
  },
}

export default codeSearcher
