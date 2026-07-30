import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import os from 'os'

import { findCommand } from '../command-registry'
import {
  buildMcpStatusReport,
  formatMcpStatusForCli,
  handleMcpCommand,
} from '../mcp-command'
import {
  sanitizeErrorForDisplay,
  truncateError,
} from '@codebuff/common/mcp/client'

import type { RouterParams } from '../command-registry'
import type { ChatMessage } from '../../types/chat'

// ============================================================================
// Helmock module for loadMCPConfigSync
// ============================================================================
let mockMcpConfig: any = { mcpServers: {}, _sourceFilePath: '' }

mock.module('@codebuff/sdk', () => {
  const actual = require('@codebuff/sdk') as any
  return {
    ...actual,
    loadMCPConfigSync: () => mockMcpConfig,
  }
})

// ============================================================================
// Tests
// ============================================================================

describe('/mcp command registration', () => {
  test('findCommand finds /mcp', () => {
    const command = findCommand('mcp')
    expect(command).toBeDefined()
    expect(command!.name).toBe('mcp')
  })

  test('findCommand finds mcp via alias', () => {
    const command = findCommand('mcp-servers')
    expect(command).toBeDefined()
    expect(command!.name).toBe('mcp')
  })

  test('command is defined with defineCommandWithArgs (accepts args)', () => {
    const command = findCommand('mcp')
    expect(command!.acceptsArgs).toBe(true)
  })

  test('command handler renders a system message via handleMcpCommand', () => {
    mockMcpConfig = { mcpServers: {}, _sourceFilePath: '' }
    const { postUserMessage } = handleMcpCommand()
    const prev: any[] = [{ id: '1', variant: 'user', content: '/mcp', timestamp: '' }]
    const result = postUserMessage(prev)

    expect(result).toHaveLength(2)
    const systemMsg = result[1]
    expect(systemMsg.variant).toBe('ai')
    expect(systemMsg.content).toContain('MCP')
  })
})

describe('/mcp parser integration', () => {
  test('/mcp triggers handler via parseCommandInput', () => {
    const { parseCommandInput } = require('../router-utils')
    const result = parseCommandInput('/mcp')
    expect(result).not.toBeNull()
    expect(result!.command).toBe('mcp')
    expect(result!.args).toBe('')
  })

  test('/mcp list triggers handler with args="list"', () => {
    const { parseCommandInput } = require('../router-utils')
    const result = parseCommandInput('/mcp list')
    expect(result).not.toBeNull()
    expect(result!.command).toBe('mcp')
    expect(result!.args).toBe('list')
  })

  test('/mcp unknown triggers handler with args="unknown"', () => {
    const { parseCommandInput } = require('../router-utils')
    const result = parseCommandInput('/mcp unknown')
    expect(result).not.toBeNull()
    expect(result!.command).toBe('mcp')
    expect(result!.args).toBe('unknown')
  })

  test('/mcp list shows same report as /mcp', () => {
    mockMcpConfig = {
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {},
        },
      },
      _sourceFilePath: '/home/user/project/.agents/mcp.json',
    }

    const noArgs = handleMcpCommand()
    const withList = handleMcpCommand('list')

    const prev: any[] = [{ id: '1', variant: 'user', content: '/mcp', timestamp: '' }]
    const resultNoArgs = noArgs.postUserMessage([...prev])
    const resultWithList = withList.postUserMessage([...prev])

    // Both should contain the server info, not help text
    expect(resultNoArgs[1].content).toContain('github')
    expect(resultWithList[1].content).toContain('github')
  })

  test('/mcp unknown shows help text', () => {
    const { postUserMessage } = handleMcpCommand('unknown')
    const prev: any[] = [{ id: '1', variant: 'user', content: '/mcp unknown', timestamp: '' }]
    const result = postUserMessage([...prev])

    expect(result[1].content).toContain('Usage:')
    expect(result[1].content).toContain('/mcp')
    expect(result[1].content).toContain('read-only')
  })
})

describe('buildMcpStatusReport', () => {
  beforeEach(() => {
    mockMcpConfig = { mcpServers: {}, _sourceFilePath: '' }
  })

  test('no servers configured', () => {
    mockMcpConfig = { mcpServers: {}, _sourceFilePath: '' }
    const report = buildMcpStatusReport()
    expect(report.servers).toEqual([])
    expect(report.configPath).toBe('')
  })

  test('one stdio server configured (not connected)', () => {
    mockMcpConfig = {
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {},
        },
      },
      _sourceFilePath: '/project/.agents/mcp.json',
    }

    const report = buildMcpStatusReport()
    expect(report.servers).toHaveLength(1)
    expect(report.servers[0].name).toBe('github')
    expect(report.servers[0].transport).toBe('stdio')
    expect(report.servers[0].connected).toBe(false)
    expect(report.servers[0].toolCount).toBeNull()
    expect(report.servers[0].errorLabel).toBeNull()
  })

  test('multiple servers configured', () => {
    mockMcpConfig = {
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {},
        },
        postgres: {
          type: 'stdio',
          command: 'uvx',
          args: ['mcp-server-postgres'],
          env: {},
        },
      },
      _sourceFilePath: '/project/.agents/mcp.json',
    }

    const report = buildMcpStatusReport()
    expect(report.servers).toHaveLength(2)

    const github = report.servers.find((s) => s.name === 'github')!
    expect(github).toBeDefined()
    expect(github.transport).toBe('stdio')

    const postgres = report.servers.find((s) => s.name === 'postgres')!
    expect(postgres).toBeDefined()
    expect(postgres.transport).toBe('stdio')
  })

  test('config file with http transport', () => {
    mockMcpConfig = {
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
          params: {},
        },
      },
      _sourceFilePath: '/project/.agents/mcp.json',
    }

    const report = buildMcpStatusReport()
    expect(report.servers).toHaveLength(1)
    expect(report.servers[0].transport).toBe('Streamable HTTP')
  })

  test('config file with sse transport', () => {
    mockMcpConfig = {
      mcpServers: {
        events: {
          type: 'sse',
          url: 'https://events.example.com/mcp',
          params: {},
          headers: {},
        },
      },
      _sourceFilePath: '/project/.agents/mcp.json',
    }

    const report = buildMcpStatusReport()
    expect(report.servers).toHaveLength(1)
    expect(report.servers[0].transport).toBe('SSE')
  })
})

describe('formatMcpStatusForCli', () => {
  test('empty config shows helpful message', () => {
    const output = formatMcpStatusForCli({ servers: [], configPath: '' })
    expect(output).toContain('No MCP servers configured')
    expect(output).toContain('.agents/mcp.json')
    expect(output).not.toContain('✓')
    expect(output).not.toContain('✗')
  })

  test('single connected server', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'github',
          transport: 'stdio',
          connected: true,
          toolCount: 18,
          configPath: '/project/.agents/mcp.json',
          errorLabel: null,
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('✓')
    expect(output).toContain('github')
    expect(output).toContain('connected')
    expect(output).toContain('stdio')
    expect(output).toContain('18')
    expect(output).toContain('Config path')
  })

  test('multiple servers with mixed status', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'github',
          transport: 'stdio',
          connected: true,
          toolCount: 18,
          configPath: '/project/.agents/mcp.json',
          errorLabel: null,
        },
        {
          name: 'postgres',
          transport: 'stdio',
          connected: false,
          toolCount: null,
          configPath: '/project/.agents/mcp.json',
          errorLabel: null,
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('✓ github')
    expect(output).toContain('○ postgres')
    expect(output).toContain('not connected')
    expect(output).toContain('will connect when the agent uses its tools')
  })

  test('failed server with error', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'broken',
          transport: 'stdio',
          connected: false,
          toolCount: null,
          configPath: '/project/.agents/mcp.json',
          errorLabel: 'process exited before initialization',
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('✗')
    expect(output).toContain('broken')
    expect(output).toContain('failed')
    expect(output).toContain('process exited before initialization')
  })

  test('unknown transport', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'weird',
          transport: 'unknown',
          connected: false,
          toolCount: null,
          configPath: '/project/.agents/mcp.json',
          errorLabel: null,
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('weird')
    expect(output).toContain('unknown')
  })

  test('tool count shows ellipsis when null', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'github',
          transport: 'stdio',
          connected: true,
          toolCount: null,
          configPath: '/project/.agents/mcp.json',
          errorLabel: null,
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('Tools: …')
  })
})

describe('/mcp command does not break other commands', () => {
  test('help command still works', () => {
    const help = findCommand('help')
    expect(help).toBeDefined()
    expect(help!.name).toBe('help')
  })

  test('bash command still works', () => {
    const bash = findCommand('bash')
    expect(bash).toBeDefined()
    expect(bash!.name).toBe('bash')
  })

  test('history command still works', () => {
    const history = findCommand('history')
    expect(history).toBeDefined()
    expect(history!.name).toBe('history')
  })

  test('init command still works', () => {
    const init = findCommand('init')
    expect(init).toBeDefined()
    expect(init!.name).toBe('init')
  })

  test('theme:toggle command still works', () => {
    const theme = findCommand('theme:toggle')
    expect(theme).toBeDefined()
    expect(theme!.name).toBe('theme:toggle')
  })

  test('feedback command still works', () => {
    const fb = findCommand('feedback')
    expect(fb).toBeDefined()
    expect(fb!.name).toBe('feedback')
  })
})

// ============================================================================
// Sanitization and truncation
// ============================================================================

describe('sanitizeErrorForDisplay', () => {
  test('redacts OpenAI-style secret keys', () => {
    const input = 'Error: Invalid API key sk-proj-abcdefghijklmnopqrstuvwxyZ1234567890abcd'
    expect(sanitizeErrorForDisplay(input)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyZ1234567890abcd')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890abcdefghij'
    expect(sanitizeErrorForDisplay(input)).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz1234567890abcdefghij')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts GitHub tokens', () => {
    const input = 'Failed to clone: ghp_abcdefghijklmnopqrstuvwxyz1234567890abcdef'
    expect(sanitizeErrorForDisplay(input)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890abcdef')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts api_key patterns', () => {
    const input = 'Using api_key=abcdefghijklmnopqrstuvwxyz1234567890'
    expect(sanitizeErrorForDisplay(input)).not.toContain('api_key=')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts token= patterns', () => {
    const input = 'Setting token=mysecrettokenvalue123456789'
    expect(sanitizeErrorForDisplay(input)).not.toContain('token=mysecrettokenvalue123456789')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts password= patterns', () => {
    const input = 'password=hunter2!@#$%^&*'
    expect(sanitizeErrorForDisplay(input)).not.toContain('password=hunter2')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('passes through safe messages unchanged', () => {
    const input = 'Process exited with code 1. Failed to start MCP server.'
    expect(sanitizeErrorForDisplay(input)).toBe(input)
  })

  test('redacts multiple occurrences', () => {
    const input = 'sk-abcdefghijklmnopqrstuvwxyz1 failed, then sk-abcdefghijklmnopqrstuvwxyz2 also failed'
    const result = sanitizeErrorForDisplay(input)
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1')
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz2')
    // Both should be replaced with the placeholder
    expect((result.match(/<REDACTED>/g) || []).length).toBe(2)
  })

  test('redacts GitHub fine-grained PATs (github_pat_)', () => {
    const input = 'Error: token github_pat_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz1 is invalid'
    expect(sanitizeErrorForDisplay(input)).not.toContain('github_pat_')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts Basic auth tokens', () => {
    const input = 'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='
    expect(sanitizeErrorForDisplay(input)).not.toContain('Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts access_token patterns', () => {
    const input = 'Using access_token=gho_abcdefghijklmnopqrstuvwxyz1234567890abcdef'
    expect(sanitizeErrorForDisplay(input)).not.toContain('access_token=gho_abcdefghijklmnopqrstuvwxyz1234567890abcdef')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts refresh_token patterns', () => {
    const input = 'refresh_token=rt_abcdefghijklmnopqrstuvwxyz1234567890abcdef'
    expect(sanitizeErrorForDisplay(input)).not.toContain('refresh_token=rt_abcdefghijklmnopqrstuvwxyz1234567890abcdef')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts client_secret patterns', () => {
    const input = 'client_secret=cs_abcdefghijklmnopqrstuvwxyz1234567890abcdef'
    expect(sanitizeErrorForDisplay(input)).not.toContain('client_secret=cs_abcdefghijklmnopqrstuvwxyz1234567890abcdef')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })

  test('redacts URL credentials (user:password@host)', () => {
    const input = 'Error connecting to https://admin:supersecret@mysql.example.com:3306/db'
    expect(sanitizeErrorForDisplay(input)).not.toContain('admin:supersecret@')
    expect(sanitizeErrorForDisplay(input)).toContain('<REDACTED>')
  })
})

describe('truncateError', () => {
  test('short messages pass through', () => {
    const input = 'short error'
    expect(truncateError(input, 2000)).toBe(input)
  })

  test('truncates long messages at newline boundary', () => {
    const input = 'line one\nline two\nline three\nline four\nline five'
    const result = truncateError(input, 20)
    expect(result).toContain('… (truncated)')
    // Should break at newline boundary
    expect(result).toContain('line one')
    expect(result).not.toContain('line five')
  })

  test('truncates at space boundary when no newline found', () => {
    const input = 'word1 word2 word3 word4 word5 word6'
    const result = truncateError(input, 15)
    expect(result).toContain('… (truncated)')
  })

  test('truncates at hard limit when no boundary found', () => {
    const veryLongWord = 'x'.repeat(5000)
    const result = truncateError(veryLongWord, 100)
    expect(result.length).toBeLessThan(5000)
    expect(result).toContain('… (truncated)')
  })
})

describe('formatMcpStatusForCli with error labels', () => {
  test('shows failed server with error label', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'broken',
          transport: 'stdio',
          connected: false,
          toolCount: null,
          configPath: '/project/.agents/mcp.json',
          errorLabel: 'Connection refused: process exited before initialization',
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('✗')
    expect(output).toContain('broken')
    expect(output).toContain('failed')
    expect(output).toContain('Connection refused')
  })

  test('shows sanitized error when error contains credentials', () => {
    // The buildMcpStatusReport already applies sanitizeErrorForDisplay
    // through getMCPClientConnectionInfo. This test verifies the format
    // layer handles sanitized content.
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'leaky',
          transport: 'http',
          connected: false,
          toolCount: null,
          configPath: '/project/.agents/mcp.json',
          errorLabel: 'Unauthorized: invalid <REDACTED>',
        },
      ],
      configPath: '/project/.agents/mcp.json',
    })
    expect(output).toContain('<REDACTED>')
  })
})

// ============================================================================
// Path sanitization
// ============================================================================

describe('sanitizePath (cross-platform home dir redaction)', () => {
  // sanitizePath is private; we test it indirectly via formatMcpStatusForCli
  // by verifying the config path is redacted when it contains the home dir.

  const originalHomedir = os.homedir()

  test('config path is redacted via formatMcpStatusForCli', () => {
    const output = formatMcpStatusForCli({
      servers: [
        {
          name: 'test',
          transport: 'stdio',
          connected: false,
          toolCount: null,
          configPath: originalHomedir + '/project/.agents/mcp.json',
          errorLabel: null,
        },
      ],
      configPath: originalHomedir + '/project/.agents/mcp.json',
    })
    expect(output).toContain('~/project/.agents/mcp.json')
    expect(output).not.toContain(originalHomedir)
  })

  test('non-home paths appear as-is', () => {
    const output = formatMcpStatusForCli({
      servers: [],
      configPath: '/etc/project/mcp.json',
    })
    expect(output).toContain('/etc/project/mcp.json')
  })
})

// ============================================================================
// Connection lifecycle (connection/disconnection error tracking)
// ============================================================================

describe('MCP connection lifecycle error tracking', () => {
  const { getMCPClientConnectionInfo } = require('@codebuff/common/mcp/client')

  test('getMCPClientConnectionInfo returns status for a server', () => {
    const info = getMCPClientConnectionInfo({
      type: 'stdio' as const,
      command: 'echo',
      args: ['hello'],
      env: {},
    })

    // Returns a single info object (not an array)
    expect(info).toHaveProperty('connected')
    expect(info).toHaveProperty('toolCount')
    expect(info).toHaveProperty('errorLabel')
  })

  test('getMCPClientConnectionInfo handles disconnected server', () => {
    const info = getMCPClientConnectionInfo({
      type: 'stdio' as const,
      command: 'never-connects',
      args: [],
      env: {},
    })

    expect(info.connected).toBe(false)
    // toolCount should be null since it was never resolved
    expect(info.toolCount).toBeNull()
  })

  test('error labels are null for unknown servers', () => {
    // A server that was never tried to connect should have no error
    const info = getMCPClientConnectionInfo({
      type: 'stdio' as const,
      command: 'unknown-command',
      args: [],
      env: {},
    })

    // A server that was never attempted will have errorLabel as null
    // (it's keyed by hashConfig, so if never connected, no error entry)
    expect(info.errorLabel).toBeNull()
  })
})
