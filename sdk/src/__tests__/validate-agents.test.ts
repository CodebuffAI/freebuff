import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'

import { validateAgents } from '../validate-agents'

import type { AgentDefinition } from '..'

describe('validateAgents', () => {
  describe('local validation (default)', () => {
    describe('valid agent definitions', () => {
      it('should validate a simple agent with minimal required fields', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'simple-agent',
            displayName: 'Simple Agent',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should validate an agent with all common fields', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'complex-agent',
            displayName: 'Complex Agent',
            publisher: 'test-publisher',
            version: '1.0.0',
            model: 'anthropic/claude-sonnet-4.5',
            toolNames: ['read_files', 'write_file', 'code_search'],
            systemPrompt: 'You are a helpful coding assistant.',
            instructionsPrompt: 'Help the user with their coding tasks.',
            stepPrompt: 'Think step by step.',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should validate an agent with spawnable agents', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'orchestrator',
            displayName: 'Orchestrator Agent',
            model: 'anthropic/claude-sonnet-4.5',
            toolNames: ['spawn_agents'],
            spawnableAgents: ['file-explorer', 'researcher-web'],
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should validate an agent with input schema', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'input-agent',
            displayName: 'Input Schema Agent',
            model: 'anthropic/claude-sonnet-4',
            inputSchema: {
              prompt: {
                type: 'string',
                description: 'The task to perform',
              },
              params: {
                type: 'object',
                properties: {
                  maxTokens: { type: 'number' },
                  temperature: { type: 'number' },
                },
                required: [],
              },
            },
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should validate an agent with structured output', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'structured-agent',
            displayName: 'Structured Output Agent',
            model: 'anthropic/claude-sonnet-4',
            outputMode: 'structured_output',
            toolNames: ['set_output'],
            outputSchema: {
              type: 'object',
              properties: {
                result: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['result'],
            },
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should validate multiple agents at once', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'agent-one',
            displayName: 'Agent One',
            model: 'anthropic/claude-sonnet-4',
          },
          {
            id: 'agent-two',
            displayName: 'Agent Two',
            model: 'anthropic/claude-sonnet-4.5',
            toolNames: ['read_files'],
          },
          {
            id: 'agent-three',
            displayName: 'Agent Three',
            model: 'openai/gpt-4',
            systemPrompt: 'You are agent three.',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should validate an agent with reasoning options', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'reasoning-agent',
            displayName: 'Reasoning Agent',
            model: 'anthropic/claude-sonnet-4',
            reasoningOptions: {
              max_tokens: 4096,
            },
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })
    })

    describe('invalid agent definitions', () => {
      it('should reject an agent with missing required field: id', async () => {
        const agents: any[] = [
          {
            displayName: 'Missing ID Agent',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
        expect(result.validationErrors[0].message).toContain('id')
      })

      it('should reject an agent with missing required field: displayName', async () => {
        const agents: any[] = [
          {
            id: 'no-display-name',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
        expect(result.validationErrors[0].message).toContain('displayName')
      })

      it('should reject an agent with missing required field: model', async () => {
        const agents: any[] = [
          {
            id: 'no-model',
            displayName: 'No Model Agent',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
        expect(result.validationErrors[0].message).toContain('model')
      })

      it('should reject an agent with invalid id format (uppercase)', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'Invalid-Agent-ID',
            displayName: 'Invalid ID Agent',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should reject an agent with invalid id format (spaces)', async () => {
        const agents: any[] = [
          {
            id: 'invalid agent id',
            displayName: 'Invalid ID Agent',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should reject an agent with invalid id format (special chars)', async () => {
        const agents: any[] = [
          {
            id: 'invalid_agent_id!',
            displayName: 'Invalid ID Agent',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should reject duplicate agent IDs', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'duplicate-id',
            displayName: 'Agent One',
            model: 'anthropic/claude-sonnet-4',
          },
          {
            id: 'duplicate-id',
            displayName: 'Agent Two',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
        expect(result.validationErrors[0].message).toContain('Duplicate')
      })

      it('should reject outputSchema without structured_output mode', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'bad-output-schema',
            displayName: 'Bad Output Schema Agent',
            model: 'anthropic/claude-sonnet-4',
            outputSchema: {
              type: 'object',
              properties: {
                result: { type: 'string' },
              },
              required: ['result'],
            },
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should reject spawnableAgents without spawn_agents tool', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'missing-spawn-tool',
            displayName: 'Missing Spawn Tool',
            model: 'anthropic/claude-sonnet-4',
            spawnableAgents: ['child-agent'],
            toolNames: ['read_files'], // Missing spawn_agents
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should reject both inheritParentSystemPrompt and systemPrompt', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'conflicting-prompts',
            displayName: 'Conflicting Prompts',
            model: 'anthropic/claude-sonnet-4',
            inheritParentSystemPrompt: true,
            systemPrompt: 'This should not be allowed',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should handle invalid handleSteps function format', async () => {
        const agents: any[] = [
          {
            id: 'bad-handle-steps',
            displayName: 'Bad Handle Steps',
            model: 'anthropic/claude-sonnet-4',
            handleSteps: 'not a function',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })
    })

    describe('edge cases', () => {
      it('should handle empty array', async () => {
        const agents: AgentDefinition[] = []

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
        expect(result.errorCount).toBe(0)
      })

      it('should handle malformed input gracefully', async () => {
        const agents: any[] = [null, undefined, {}]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should report multiple validation errors', async () => {
        const agents: any[] = [
          {
            id: 'bad-agent-1',
            // Missing displayName and model
          },
          {
            id: 'bad-agent-2',
            displayName: 'Bad Agent 2',
            // Missing model
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(1)
        expect(result.validationErrors.length).toBeGreaterThan(1)
      })

      it('should catch severe type mismatches - number instead of string', async () => {
        const agents: any[] = [
          {
            id: 'type-mismatch-agent',
            displayName: 123, // Should be string
            model: 456, // Should be string
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBe(1)
        expect(result.validationErrors[0].message).toContain('invalid_type')
        expect(result.validationErrors[0].message).toContain('displayName')
        expect(result.validationErrors[0].message).toContain('model')
      })

      it('should catch severe type mismatches - string instead of array', async () => {
        const agents: any[] = [
          {
            id: 'array-mismatch',
            displayName: 'Array Mismatch Agent',
            model: 'anthropic/claude-sonnet-4',
            toolNames: 'read_files', // Should be array
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBe(1)
        expect(result.validationErrors[0].message).toContain('toolNames')
        expect(result.validationErrors[0].message).toContain('array')
      })

      it('should catch severely malformed agent with multiple type errors', async () => {
        const agents: any[] = [
          {
            id: 'severely-broken',
            // displayName missing
            model: 12345, // Wrong type
            toolNames: 'not-an-array', // Wrong type
            outputSchema: 'not-an-object', // Wrong type
            invalidField: 'should be ignored',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBe(1)
        const errorMessage = result.validationErrors[0].message
        expect(errorMessage).toContain('displayName')
        expect(errorMessage).toContain('model')
        expect(errorMessage).toContain('toolNames')
        expect(errorMessage).toContain('outputSchema')
      })

      it('should provide detailed error messages for schema violations', async () => {
        const agents: any[] = [
          {
            id: 'detailed-errors',
            model: 'anthropic/claude-sonnet-4',
            // Missing required displayName
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.validationErrors[0].message).toContain('displayName')
        expect(result.validationErrors[0].message).toContain('expected string')
      })

      it('should handle very large number of agents', async () => {
        // Create 100 agents
        const agents: AgentDefinition[] = Array.from(
          { length: 100 },
          (_, i) => ({
            id: `agent-${i}`,
            displayName: `Agent ${i}`,
            model: 'anthropic/claude-sonnet-4',
          }),
        )

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
        expect(result.validationErrors).toEqual([])
      })

      it('should handle agents with very long field values', async () => {
        const longString = 'a'.repeat(10000)
        const agents: AgentDefinition[] = [
          {
            id: 'long-field-agent',
            displayName: 'Long Field Agent',
            model: 'anthropic/claude-sonnet-4',
            systemPrompt: longString,
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
      })

      it('should handle unicode characters in agent fields', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'unicode-agent',
            displayName: '🚀 Unicode Agent 中文 العربية',
            model: 'anthropic/claude-sonnet-4',
            systemPrompt: 'You are a helpful assistant 😊',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
      })

      it('should reject unicode in agent IDs', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'agent-🚀-unicode',
            displayName: 'Unicode ID Agent',
            model: 'anthropic/claude-sonnet-4',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.validationErrors[0].message).toContain(
          'lowercase letters, numbers, and hyphens',
        )
      })

      it('should handle deeply nested input schemas', async () => {
        const agents: AgentDefinition[] = [
          {
            id: 'nested-schema-agent',
            displayName: 'Nested Schema Agent',
            model: 'anthropic/claude-sonnet-4',
            inputSchema: {
              params: {
                type: 'object',
                properties: {
                  level1: {
                    type: 'object',
                    properties: {
                      level2: {
                        type: 'object',
                        properties: {
                          level3: {
                            type: 'object',
                            properties: {
                              deepValue: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(true)
      })

      it('should handle invalid JSON schema structures gracefully', async () => {
        const agents: any[] = [
          {
            id: 'invalid-schema',
            displayName: 'Invalid Schema Agent',
            model: 'anthropic/claude-sonnet-4',
            inputSchema: {
              params: {
                type: 'invalid-type', // Not a valid JSON schema type
                properties: null, // Invalid
              },
            },
          },
        ]

        const result = await validateAgents(agents)

        // Should fail validation but not crash
        expect(result.success).toBe(false)
      })

      it('should handle circular references in data gracefully', async () => {
        const circularObj: any = {
          id: 'circular-agent',
          displayName: 'Circular Agent',
          model: 'anthropic/claude-sonnet-4',
        }
        // Create circular reference
        circularObj.self = circularObj

        const agents = [circularObj]

        // Should not crash when stringifying
        const result = await validateAgents(agents)

        // Validation might succeed or fail, but should not throw
        expect(result).toBeDefined()
        expect(result.success).toBeDefined()
      })

      it('should handle agents with empty strings in required fields', async () => {
        const agents: any[] = [
          {
            id: '',
            displayName: '',
            model: '',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
        expect(result.errorCount).toBeGreaterThan(0)
      })

      it('should handle agents with whitespace-only strings', async () => {
        const agents: any[] = [
          {
            id: '   ',
            displayName: '   ',
            model: '   ',
          },
        ]

        const result = await validateAgents(agents)

        expect(result.success).toBe(false)
      })
    })
  })

  describe('remote validation', () => {
    let mockFetch: ReturnType<typeof mock>
    const originalFetch = globalThis.fetch

    beforeEach(() => {
      mockFetch = mock(() => {
        throw new Error('fetch mock not configured')
      })
      globalThis.fetch = Object.assign(mockFetch, {
        preconnect: () => {},
      }) as typeof fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
      mock.restore()
    })

    it('should call the web API when remote option is enabled', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.codebuff.com/api/agents/validate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentDefinitions: agents }),
        }),
      )
      expect(result.success).toBe(true)
    })

    describe('Authorization header', () => {
      const agents: AgentDefinition[] = [
        { id: 'test-agent', displayName: 'Test Agent', model: 'm' },
      ]
      const okResponse = {
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      }
      const originalEnvKey = process.env.CODEBUFF_API_KEY

      afterEach(() => {
        if (originalEnvKey === undefined) delete process.env.CODEBUFF_API_KEY
        else process.env.CODEBUFF_API_KEY = originalEnvKey
      })

      const sentHeaders = () =>
        (mockFetch.mock.calls[0] as unknown[])[1] as {
          headers: Record<string, string>
        }

      it('sends the apiKey option as a bearer', async () => {
        delete process.env.CODEBUFF_API_KEY
        mockFetch.mockResolvedValue(okResponse)
        await validateAgents(agents, {
          remote: true,
          websiteUrl: 'https://test.codebuff.com',
          apiKey: 'key-from-option',
        })
        expect(sentHeaders().headers).toEqual({
          'Content-Type': 'application/json',
          Authorization: 'Bearer key-from-option',
        })
      })

      it('falls back to CODEBUFF_API_KEY from the environment', async () => {
        process.env.CODEBUFF_API_KEY = 'key-from-env'
        mockFetch.mockResolvedValue(okResponse)
        await validateAgents(agents, {
          remote: true,
          websiteUrl: 'https://test.codebuff.com',
        })
        expect(sentHeaders().headers.Authorization).toBe('Bearer key-from-env')
      })

      it('sends no Authorization header when no key is available', async () => {
        delete process.env.CODEBUFF_API_KEY
        mockFetch.mockResolvedValue(okResponse)
        await validateAgents(agents, {
          remote: true,
          websiteUrl: 'https://test.codebuff.com',
        })
        expect(sentHeaders().headers).toEqual({
          'Content-Type': 'application/json',
        })
      })
    })

    it('should use default websiteUrl from environment when not provided', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        // websiteUrl not provided - should use default from WEBSITE_URL constant
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      // Verify it called with some URL (the default from environment)
      const callUrl = (mockFetch.mock.calls[0] as [string, ...unknown[]])[0]
      expect(callUrl).toMatch(/\/api\/agents\/validate$/)
      expect(result.success).toBe(true)
    })

    it('should handle API validation errors', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'bad-agent',
          displayName: 'Bad Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          validationErrors: [
            {
              filePath: 'bad-agent',
              message: 'Agent "bad-agent": Invalid configuration',
            },
          ],
          errorCount: 1,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].message).toContain(
        'Invalid configuration',
      )
    })

    it('should handle HTTP errors from API', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'Server error occurred' }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].id).toBe('network_error')
      expect(result.validationErrors[0].message).toContain(
        'Server error occurred',
      )
    })

    it('should handle network failures', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockRejectedValue(new Error('Network request failed'))

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].id).toBe('network_error')
      expect(result.validationErrors[0].message).toContain('Failed to connect')
    })

    it('should handle malformed API responses', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON')
        },
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(result.success).toBe(false)
      expect(result.errorCount).toBe(1)
      expect(result.validationErrors[0].id).toBe('network_error')
    })

    it('should handle API response missing validationErrors field', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          // validationErrors missing!
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      // Should handle gracefully with empty errors
      expect(result.success).toBe(true)
      expect(result.validationErrors).toEqual([])
    })

    it('should handle very large number of agents in remote validation', async () => {
      const agents: AgentDefinition[] = Array.from({ length: 100 }, (_, i) => ({
        id: `agent-${i}`,
        displayName: `Agent ${i}`,
        model: 'anthropic/claude-sonnet-4',
      }))

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          validationErrors: [],
          errorCount: 0,
        }),
      })

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(result.success).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      // Verify all agents were sent
      const requestBody = JSON.parse(
        (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
      )
      expect(requestBody.agentDefinitions.length).toBe(100)
    })

    it('should handle timeout-like errors', async () => {
      const agents: AgentDefinition[] = [
        {
          id: 'test-agent',
          displayName: 'Test Agent',
          model: 'anthropic/claude-sonnet-4',
        },
      ]

      mockFetch.mockRejectedValue(new Error('The operation was aborted'))

      const result = await validateAgents(agents, {
        remote: true,
        websiteUrl: 'https://test.codebuff.com',
      })

      expect(result.success).toBe(false)
      expect(result.validationErrors[0].message).toContain('Failed to connect')
    })
  })
})
