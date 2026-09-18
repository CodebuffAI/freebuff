import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  loadMCPConfig,
  loadMCPConfigSync,
  mcpFileSchema,
} from '../agents/load-mcp-config'

import type { MCPConfig } from '@codebuff/common/types/mcp'

// Helper to safely access stdio config properties
function isStdioConfig(
  config: MCPConfig,
): config is MCPConfig & { command: string; env?: Record<string, string> } {
  return 'command' in config
}

describe('mcpFileSchema', () => {
  it('should parse a valid mcp.json with stdio config', () => {
    const config = {
      mcpServers: {
        myServer: {
          command: 'npx',
          args: ['-y', 'my-package'],
          env: {
            API_KEY: 'test-key',
          },
        },
      },
    }

    const result = mcpFileSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      const myServer = result.data.mcpServers.myServer
      expect(myServer).toBeDefined()
      expect('command' in myServer && myServer.command).toBe('npx')
    }
  })

  it('should parse a valid mcp.json with http config', () => {
    const config = {
      mcpServers: {
        remoteServer: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: {
            Authorization: 'Bearer token',
          },
        },
      },
    }

    const result = mcpFileSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      const remoteServer = result.data.mcpServers.remoteServer
      expect(remoteServer).toBeDefined()
      expect('url' in remoteServer && remoteServer.url).toBe(
        'https://example.com/mcp',
      )
    }
  })

  it('should default mcpServers to empty object if not provided', () => {
    const config = {}

    const result = mcpFileSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mcpServers).toEqual({})
    }
  })

  it('should reject invalid config', () => {
    const config = {
      mcpServers: {
        invalidServer: {
          // Missing required fields
          type: 'invalid-type',
        },
      },
    }

    const result = mcpFileSchema.safeParse(config)
    expect(result.success).toBe(false)
  })
})

describe('loadMCPConfigSync', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should return empty config when no mcp.json exists in project dir', () => {
    // No mcp.json in tempDir/.agents - should not find any project-specific servers
    const result = loadMCPConfigSync({ verbose: false })
    // Check that no server named 'testProjectServer' exists (which we'd create if one existed)
    expect(result.mcpServers.testProjectServer).toBeUndefined()
  })

  it('should load mcp.json from .agents directory', () => {
    const agentsDir = path.join(tempDir, '.agents')
    fs.mkdirSync(agentsDir, { recursive: true })

    const mcpConfig = {
      mcpServers: {
        testServer: {
          command: 'node',
          args: ['server.js'],
        },
      },
    }
    fs.writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
    )

    const result = loadMCPConfigSync({ verbose: false })
    expect(result.mcpServers.testServer).toBeDefined()
    const testServer = result.mcpServers.testServer
    if (isStdioConfig(testServer)) {
      expect(testServer.command).toBe('node')
    }
    // Verify a source path was recorded (don't check exact path due to temp dir variations)
    expect(result._sourceFilePath).toContain('mcp.json')
  })

  it('should resolve environment variable references', () => {
    const agentsDir = path.join(tempDir, '.agents')
    fs.mkdirSync(agentsDir, { recursive: true })

    // Set env var for test
    process.env.TEST_MCP_API_KEY = 'resolved-api-key'

    const mcpConfig = {
      mcpServers: {
        envServer: {
          command: 'npx',
          args: ['-y', 'my-mcp-server'],
          env: {
            API_KEY: '$TEST_MCP_API_KEY',
          },
        },
      },
    }
    fs.writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
    )

    const result = loadMCPConfigSync({ verbose: false })
    expect(result.mcpServers.envServer).toBeDefined()
    const envServer = result.mcpServers.envServer
    if (isStdioConfig(envServer)) {
      expect(envServer.env?.API_KEY).toBe('resolved-api-key')
    }

    // Cleanup
    delete process.env.TEST_MCP_API_KEY
  })

  it('should skip config if env var is missing', () => {
    const agentsDir = path.join(tempDir, '.agents')
    fs.mkdirSync(agentsDir, { recursive: true })

    const mcpConfig = {
      mcpServers: {
        missingEnvServer: {
          command: 'npx',
          args: ['-y', 'my-mcp-server'],
          env: {
            API_KEY: '$NONEXISTENT_VAR_12345',
          },
        },
      },
    }
    fs.writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
    )

    // Should not throw, just skip the server with missing env var
    const result = loadMCPConfigSync({ verbose: false })
    // The server with missing env var should not be loaded
    expect(result.mcpServers.missingEnvServer).toBeUndefined()
  })

  it('should load config from project .agents directory', () => {
    // Create project .agents directory
    const projectAgentsDir = path.join(tempDir, '.agents')
    fs.mkdirSync(projectAgentsDir, { recursive: true })

    // Project config
    const projectConfig = {
      mcpServers: {
        projectServer: {
          command: 'project-command',
          args: ['--flag'],
        },
      },
    }
    fs.writeFileSync(
      path.join(projectAgentsDir, 'mcp.json'),
      JSON.stringify(projectConfig, null, 2),
    )

    const result = loadMCPConfigSync({ verbose: false })

    // Project config should be loaded
    const projectServer = result.mcpServers.projectServer
    expect(projectServer).toBeDefined()
    if (projectServer && isStdioConfig(projectServer)) {
      expect(projectServer.command).toBe('project-command')
    }
  })

  it('should handle invalid JSON gracefully', () => {
    const agentsDir = path.join(tempDir, '.agents')
    fs.mkdirSync(agentsDir, { recursive: true })

    fs.writeFileSync(path.join(agentsDir, 'mcp.json'), 'not valid json {')

    // Should not throw - just skip the invalid file
    const result = loadMCPConfigSync({ verbose: false })
    // The result should not contain any servers from this invalid config
    // (though it might contain servers from other directories like home)
    expect(result.mcpServers.invalidServer).toBeUndefined()
  })
})

describe('loadMCPConfig', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-async-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should load mcp.json asynchronously', async () => {
    const agentsDir = path.join(tempDir, '.agents')
    fs.mkdirSync(agentsDir, { recursive: true })

    const mcpConfig = {
      mcpServers: {
        asyncServer: {
          command: 'async-command',
          args: ['--async'],
        },
      },
    }
    fs.writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
    )

    const result = await loadMCPConfig({ verbose: false })
    expect(result.mcpServers.asyncServer).toBeDefined()
    const asyncServer = result.mcpServers.asyncServer
    if (isStdioConfig(asyncServer)) {
      expect(asyncServer.command).toBe('async-command')
    }
  })
})

describe('configDirs option', () => {
  let tempDir: string

  const writeMcpJson = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { [name]: { command: 'node' } } }),
    )
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-dirs-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('reads mcp.json only from the listed directories (sync)', () => {
    const trusted = path.join(tempDir, 'trusted')
    const untrusted = path.join(tempDir, 'untrusted')
    writeMcpJson(trusted, 'okServer')
    writeMcpJson(untrusted, 'evilServer')

    const result = loadMCPConfigSync({ configDirs: [trusted] })

    expect(Object.keys(result.mcpServers)).toEqual(['okServer'])
    expect(result._sourceFilePath).toBe(path.join(trusted, 'mcp.json'))
  })

  it('reads mcp.json only from the listed directories (async)', async () => {
    const trusted = path.join(tempDir, 'trusted')
    const untrusted = path.join(tempDir, 'untrusted')
    writeMcpJson(trusted, 'okServer')
    writeMcpJson(untrusted, 'evilServer')

    const result = await loadMCPConfig({ configDirs: [trusted] })

    expect(Object.keys(result.mcpServers)).toEqual(['okServer'])
  })

  it('an empty list loads nothing', async () => {
    writeMcpJson(path.join(tempDir, '.agents'), 'server')

    expect(loadMCPConfigSync({ configDirs: [] }).mcpServers).toEqual({})
    expect((await loadMCPConfig({ configDirs: [] })).mcpServers).toEqual({})
  })
})
