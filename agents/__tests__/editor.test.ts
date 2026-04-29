import { describe, test, expect } from 'bun:test'

import editor, { createCodeEditor } from '../editor/editor'

import type { AgentState, ToolCall } from '../types/agent-definition'

describe('editor agent', () => {
  const createMockAgentState = (
    messageHistory: any[] = [],
  ): AgentState => ({
    agentId: 'editor-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  })

  describe('default editor definition', () => {
    test('has correct id', () => {
      expect(editor.id).toBe('editor')
    })

    test('has display name', () => {
      expect(editor.displayName).toBe('Code Editor')
    })

    test('uses opus model by default', () => {
      expect(editor.model).toBe('anthropic/claude-opus-4.7')
    })

    test('has output mode set to structured_output', () => {
      expect(editor.outputMode).toBe('structured_output')
    })

    test('includes message history', () => {
      expect(editor.includeMessageHistory).toBe(true)
    })

    test('inherits parent system prompt', () => {
      expect(editor.inheritParentSystemPrompt).toBe(true)
    })

    test('has correct tool names', () => {
      expect(editor.toolNames).toContain('write_file')
      expect(editor.toolNames).toContain('str_replace')
      expect(editor.toolNames).toContain('set_output')
      expect(editor.toolNames).toHaveLength(3)
    })
  })

  describe('createCodeEditor', () => {
    test('creates opus editor by default', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      expect(opusEditor.model).toBe('anthropic/claude-opus-4.7')
    })

    test('creates gpt-5 editor', () => {
      const gpt5Editor = createCodeEditor({ model: 'gpt-5' })
      expect(gpt5Editor.model).toBe('openai/gpt-5.1')
    })

    test('creates kimi editor', () => {
      const kimiEditor = createCodeEditor({ model: 'kimi' })
      expect(kimiEditor.model).toBe('moonshotai/kimi-k2.6')
    })

    test('creates kimi editor', () => {
      const kimiEditor = createCodeEditor({ model: 'kimi' })
      expect(kimiEditor.model).toBe('moonshotai/kimi-k2.6')
    })

    test('creates minimax editor', () => {
      const minimaxEditor = createCodeEditor({ model: 'minimax' })
      expect(minimaxEditor.model).toBe('minimax/minimax-m2.7')
    })

    test('gpt-5 editor does not include think tags in instructions', () => {
      const gpt5Editor = createCodeEditor({ model: 'gpt-5' })
      expect(gpt5Editor.instructionsPrompt).not.toContain('<think>')
      expect(gpt5Editor.instructionsPrompt).not.toContain('</think>')
    })

    test('kimi editor does not include think tags in instructions', () => {
      const kimiEditor = createCodeEditor({ model: 'kimi' })
      expect(kimiEditor.instructionsPrompt).not.toContain('<think>')
      expect(kimiEditor.instructionsPrompt).not.toContain('</think>')
    })

    test('kimi editor does not include think tags in instructions', () => {
      const kimiEditor = createCodeEditor({ model: 'kimi' })
      expect(kimiEditor.instructionsPrompt).not.toContain('<think>')
      expect(kimiEditor.instructionsPrompt).not.toContain('</think>')
    })

    test('minimax editor does not include think tags in instructions', () => {
      const minimaxEditor = createCodeEditor({ model: 'minimax' })
      expect(minimaxEditor.instructionsPrompt).not.toContain('<think>')
      expect(minimaxEditor.instructionsPrompt).not.toContain('</think>')
    })

    test('opus editor includes think tags in instructions', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      expect(opusEditor.instructionsPrompt).toContain('<think>')
      expect(opusEditor.instructionsPrompt).toContain('</think>')
    })

    test('all variants have same base properties', () => {
      const opusEditor = createCodeEditor({ model: 'opus' })
      const gpt5Editor = createCodeEditor({ model: 'gpt-5' })
      const kimiEditor = createCodeEditor({ model: 'kimi' })

      // All should have same basic structure
      expect(opusEditor.displayName).toBe(gpt5Editor.displayName)
      expect(gpt5Editor.displayName).toBe(kimiEditor.displayName)

      expect(opusEditor.outputMode).toBe(gpt5Editor.outputMode)
      expect(gpt5Editor.outputMode).toBe(kimiEditor.outputMode)

      expect(opusEditor.toolNames).toEqual(gpt5Editor.toolNames)
      expect(gpt5Editor.toolNames).toEqual(kimiEditor.toolNames)
    })
  })

  describe('instructions prompt', () => {
    test('contains str_replace format example', () => {
      expect(editor.instructionsPrompt).toContain('str_replace')
      expect(editor.instructionsPrompt).toContain('replacements')
      expect(editor.instructionsPrompt).toContain('old')
      expect(editor.instructionsPrompt).toContain('new')
    })

    test('contains write_file format example', () => {
      expect(editor.instructionsPrompt).toContain('write_file')
      expect(editor.instructionsPrompt).toContain('content')
    })

    test('contains codebuff_tool_call format', () => {
      expect(editor.instructionsPrompt).toContain('<codebuff_tool_call>')
      expect(editor.instructionsPrompt).toContain('</codebuff_tool_call>')
    })

    test('instructs not to call set_output', () => {
      expect(editor.instructionsPrompt).toContain('set_output')
      expect(editor.instructionsPrompt).toContain('should not be used')
    })

    test('mentions being an expert code editor', () => {
      expect(editor.instructionsPrompt).toContain('expert code editor')
    })

    test('mentions comprehensive changes', () => {
      expect(editor.instructionsPrompt).toContain('comprehensive')
    })

    test('mentions project conventions', () => {
      expect(editor.instructionsPrompt).toContain('conventions')
    })
  })

  describe('spawner prompt', () => {
    test('describes the editor purpose', () => {
      expect(editor.spawnerPrompt).toContain('code changes')
    })

    test('mentions not to specify input prompt', () => {
      expect(editor.spawnerPrompt).toContain('input prompt')
    })

    test('mentions reading files before spawning', () => {
      expect(editor.spawnerPrompt).toContain('read')
      expect(editor.spawnerPrompt).toContain('files')
    })
  })

  describe('handleSteps', () => {
    test('yields STEP with initial state tracking', () => {
      const initialMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      const result = generator.next()

      expect(result.value).toBe('STEP')
    })

    test('captures new messages after STEP', () => {
      const initialMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Initial' }] },
      ]
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      // First STEP
      generator.next()

      // Simulate new messages being added
      const newMessages = [
        ...initialMessages,
        { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      ]
      const updatedState = createMockAgentState(newMessages)

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        toolName: string
        input: { output: { messages: any[] } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.output.messages).toHaveLength(1)
      expect(toolCall.input.output.messages[0].role).toBe('assistant')
    })

    test('returns only new messages in output', () => {
      const initialMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Message 1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] },
      ]
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const newMessages = [
        ...initialMessages,
        { role: 'user', content: [{ type: 'text', text: 'Message 2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Response 2' }] },
        { role: 'user', content: [{ type: 'text', text: 'Message 3' }] },
      ]
      const updatedState = createMockAgentState(newMessages)

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      // Should only include the 3 new messages
      const toolCall = result.value as unknown as {
        input: { output: { messages: any[] } }
      }
      expect(toolCall.input.output.messages).toHaveLength(3)
      expect(toolCall.input.output.messages[0].content[0].text).toBe('Message 2')
    })

    test('handleSteps can be serialized for sandbox execution', () => {
      const handleStepsString = editor.handleSteps!.toString()

      // Verify it's a valid generator function string
      expect(handleStepsString).toMatch(/^function\*\s*\(/)

      // Should be able to create a new function from it
      const isolatedFunction = new Function(`return (${handleStepsString})`)()
      expect(typeof isolatedFunction).toBe('function')
    })

    test('outputs correct structure for set_output', () => {
      const initialMessages: any[] = []
      const mockAgentState = createMockAgentState(initialMessages)
      const mockLogger = {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const newMessages = [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }]
      const updatedState = createMockAgentState(newMessages)

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      expect(result.value).toEqual({
        toolName: 'set_output',
        input: {
          output: {
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }],
          },
        },
        includeToolCall: false,
      })
    })

    test('works with empty initial message history', () => {
      const mockAgentState = createMockAgentState([])
      const mockLogger = {
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { },
      }

      const generator = editor.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      generator.next()

      const newMessages = [
        { role: 'assistant', content: [{ type: 'text', text: 'First response' }] },
      ]
      const updatedState = createMockAgentState(newMessages)

      const result = generator.next({
        agentState: updatedState,
        toolResult: undefined,
        stepsComplete: true,
      })

      const toolCall = result.value as unknown as {
        input: { output: { messages: any[] } }
      }
      expect(toolCall.input.output.messages).toHaveLength(1)
    })
  })

  describe('style notes in instructions', () => {
    test('mentions try/catch blocks', () => {
      expect(editor.instructionsPrompt).toContain('try/catch')
    })

    test('mentions optional arguments', () => {
      expect(editor.instructionsPrompt).toContain('Optional arguments')
    })

    test('mentions new components in new files', () => {
      expect(editor.instructionsPrompt).toContain('new file')
    })
  })
})
