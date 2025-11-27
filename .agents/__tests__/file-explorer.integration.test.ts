import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import { describe, expect, it } from 'bun:test'

import { CodebuffClient } from '@codebuff/sdk'
import filePickerDefinition from '../file-explorer/file-picker'
import fileListerDefinition from '../file-explorer/file-lister'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * Integration tests for agents that use the read_subtree tool.
 * These tests verify that the SDK properly initializes the session state
 * with project files and that agents can access the file tree through
 * the read_subtree tool.
 *
 * The file-lister agent is used directly instead of file-picker because:
 * - file-lister directly uses the read_subtree tool
 * - file-picker spawns file-lister as a subagent, adding complexity
 * - Testing file-lister directly verifies the core functionality
 */
describe('File Lister Agent Integration - read_subtree tool', () => {
  it(
    'should find relevant files using read_subtree tool',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]
      if (!apiKey) {
        throw new Error('API key not found')
      }

      // Create mock project files that the file-lister should be able to find
      const projectFiles: Record<string, string> = {
        'src/index.ts': `
import { UserService } from './services/user-service'
import { AuthService } from './services/auth-service'

export function main() {
  const userService = new UserService()
  const authService = new AuthService()
  console.log('Application started')
}
`,
        'src/services/user-service.ts': `
export class UserService {
  async getUser(id: string) {
    return { id, name: 'John Doe' }
  }

  async createUser(name: string) {
    return { id: 'new-user-id', name }
  }

  async deleteUser(id: string) {
    console.log('User deleted:', id)
  }
}
`,
        'src/services/auth-service.ts': `
export class AuthService {
  async login(email: string, password: string) {
    return { token: 'mock-token' }
  }

  async logout() {
    console.log('Logged out')
  }

  async validateToken(token: string) {
    return token === 'mock-token'
  }
}
`,
        'src/utils/logger.ts': `
export function log(message: string) {
  console.log('[LOG]', message)
}

export function error(message: string) {
  console.error('[ERROR]', message)
}
`,
        'src/types/user.ts': `
export interface User {
  id: string
  name: string
  email?: string
}
`,
        'package.json': JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          dependencies: {},
        }),
        'README.md':
          '# Test Project\n\nA simple test project for integration testing.',
      }

      const client = new CodebuffClient({
        apiKey,
        cwd: '/tmp/test-project',
        projectFiles,
      })

      const events: PrintModeEvent[] = []

      // Run the file-lister agent to find files related to user service
      // The file-lister agent uses the read_subtree tool directly
      const run = await client.run({
        agent: 'file-lister',
        prompt: 'Find files related to user authentication and user management',
        handleEvent: (event) => {
          events.push(event)
        },
      })

      // The output should not be an error
      expect(run.output.type).not.toEqual('error')

      // Verify we got some output
      expect(run.output).toBeDefined()

      // The file-lister should have found relevant files
      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Verify that the file-lister found some relevant files
      const relevantFiles = [
        'user-service',
        'auth-service',
        'user',
        'auth',
        'services',
      ]
      const foundRelevantFile = relevantFiles.some((file) =>
        outputStr.toLowerCase().includes(file.toLowerCase()),
      )

      expect(foundRelevantFile).toBe(true)
    },
    { timeout: 60_000 },
  )

  it(
    'should use the file tree from session state',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]
      if (!apiKey) {
        throw new Error('API key not found')
      }

      // Create a different set of project files with a specific structure
      const projectFiles: Record<string, string> = {
        'packages/core/src/index.ts': 'export const VERSION = "1.0.0"',
        'packages/core/src/api/server.ts':
          'export function startServer() { console.log("started") }',
        'packages/core/src/api/routes.ts':
          'export const routes = { health: "/health" }',
        'packages/utils/src/helpers.ts':
          'export function formatDate(d: Date) { return d.toISOString() }',
        'docs/api.md': '# API Documentation\n\nAPI docs here.',
        'package.json': JSON.stringify({ name: 'mono-repo', version: '2.0.0' }),
      }

      const client = new CodebuffClient({
        apiKey,
        cwd: '/tmp/test-project',
        projectFiles,
      })

      const events: PrintModeEvent[] = []

      // Run file-lister to find API-related files
      const run = await client.run({
        agent: 'file-lister',
        prompt: 'Find files related to the API server implementation',
        handleEvent: (event) => {
          events.push(event)
        },
      })

      expect(run.output.type).not.toEqual('error')

      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Should find API-related files
      const apiRelatedTerms = ['server', 'routes', 'api', 'core']
      const foundApiFile = apiRelatedTerms.some((term) =>
        outputStr.toLowerCase().includes(term.toLowerCase()),
      )

      expect(foundApiFile).toBe(true)
    },
    { timeout: 60_000 },
  )

  it(
    'should respect directories parameter',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]
      if (!apiKey) {
        throw new Error('API key not found')
      }

      // Create project with multiple top-level directories
      const projectFiles: Record<string, string> = {
        'frontend/src/App.tsx':
          'export function App() { return <div>App</div> }',
        'frontend/src/components/Button.tsx':
          'export function Button() { return <button>Click</button> }',
        'backend/src/server.ts':
          'export function start() { console.log("started") }',
        'backend/src/routes/users.ts':
          'export function getUsers() { return [] }',
        'shared/types/common.ts': 'export type ID = string',
        'package.json': JSON.stringify({ name: 'full-stack-app' }),
      }

      const client = new CodebuffClient({
        apiKey,
        cwd: '/tmp/test-project',
        projectFiles,
      })

      // Run file-lister with directories parameter to limit to frontend only
      const run = await client.run({
        agent: 'file-lister',
        prompt: 'Find React component files',
        params: {
          directories: ['frontend'],
        },
        handleEvent: () => {},
      })

      expect(run.output.type).not.toEqual('error')

      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Should find frontend files
      const frontendTerms = ['app', 'button', 'component', 'frontend']
      const foundFrontendFile = frontendTerms.some((term) =>
        outputStr.toLowerCase().includes(term.toLowerCase()),
      )

      expect(foundFrontendFile).toBe(true)
    },
    { timeout: 60_000 },
  )
})

/**
 * Integration tests for the file-picker agent that spawns subagents.
 * The file-picker spawns file-lister as a subagent to find files.
 * This tests the spawn_agents tool functionality through the SDK.
 */
describe('File Picker Agent Integration - spawn_agents tool', () => {
  // Note: This test requires the local agent definitions to be used for both
  // file-picker AND its spawned file-lister subagent. Currently, the spawned
  // agent may resolve to the server version which has the old parsing bug.
  // Skip until we have a way to ensure spawned agents use local definitions.
  it.skip(
    'should spawn file-lister subagent and find relevant files',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]
      if (!apiKey) {
        throw new Error('API key not found')
      }

      // Create mock project files
      const projectFiles: Record<string, string> = {
        'src/index.ts': `
import { UserService } from './services/user-service'
export function main() {
  const userService = new UserService()
  console.log('Application started')
}
`,
        'src/services/user-service.ts': `
export class UserService {
  async getUser(id: string) {
    return { id, name: 'John Doe' }
  }
}
`,
        'src/services/auth-service.ts': `
export class AuthService {
  async login(email: string, password: string) {
    return { token: 'mock-token' }
  }
}
`,
        'package.json': JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
        }),
      }

      // Use local agent definitions to test the updated handleSteps
      const localFilePickerDef = filePickerDefinition as unknown as any
      const localFileListerDef = fileListerDefinition as unknown as any

      const client = new CodebuffClient({
        apiKey,
        cwd: '/tmp/test-project-picker',
        projectFiles,
        agentDefinitions: [localFilePickerDef, localFileListerDef],
      })

      const events: PrintModeEvent[] = []

      // Run the file-picker agent which spawns file-lister as a subagent
      const run = await client.run({
        agent: localFilePickerDef.id,
        prompt: 'Find files related to user authentication',
        handleEvent: (event) => {
          events.push(event)
        },
      })

      // Check for errors in the output
      if (run.output.type === 'error') {
        console.error('File picker error:', run.output)
      }

      console.log('File picker output type:', run.output.type)
      console.log('File picker output:', JSON.stringify(run.output, null, 2))

      // The output should not be an error
      expect(run.output.type).not.toEqual('error')

      // Verify we got some output
      expect(run.output).toBeDefined()

      // The file-picker should have found relevant files via its spawned file-lister
      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Verify that the file-picker found some relevant files
      const relevantFiles = ['user', 'auth', 'service']
      const foundRelevantFile = relevantFiles.some((file) =>
        outputStr.toLowerCase().includes(file.toLowerCase()),
      )

      expect(foundRelevantFile).toBe(true)
    },
    { timeout: 90_000 },
  )
})
