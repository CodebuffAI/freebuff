import { describe, expect, it } from 'bun:test'

import {
  parseToolCallsFromText,
  parseTextWithToolCalls,
} from '../parse-tool-calls-from-text'

describe('parseToolCallsFromText', () => {
  it('should parse a single tool call', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"]
}
</codebuff_tool_call>`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      toolName: 'read_files',
      input: { paths: ['test.ts'] },
    })
  })

  it('should parse multiple tool calls', () => {
    const text = `Some commentary before

<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["file1.ts"]
}
</codebuff_tool_call>

Some text between

<codebuff_tool_call>
{
  "cb_tool_name": "str_replace",
  "path": "file1.ts",
  "replacements": [{"old": "foo", "new": "bar"}]
}
</codebuff_tool_call>

Some commentary after`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      toolName: 'read_files',
      input: { paths: ['file1.ts'] },
    })
    expect(result[1]).toEqual({
      toolName: 'str_replace',
      input: {
        path: 'file1.ts',
        replacements: [{ old: 'foo', new: 'bar' }],
      },
    })
  })

  it('should remove cb_tool_name from input', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "write_file",
  "path": "test.ts",
  "content": "console.log('hello')"
}
</codebuff_tool_call>`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    expect(result[0].input).not.toHaveProperty('cb_tool_name')
    expect(result[0].input).toEqual({
      path: 'test.ts',
      content: "console.log('hello')",
    })
  })

  it('should remove cb_easp from input', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"],
  "cb_easp": true
}
</codebuff_tool_call>`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    expect(result[0].input).not.toHaveProperty('cb_easp')
    expect(result[0].input).toEqual({ paths: ['test.ts'] })
  })

  it('should skip malformed JSON', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"
}
</codebuff_tool_call>

<codebuff_tool_call>
{
  "cb_tool_name": "write_file",
  "path": "good.ts",
  "content": "valid"
}
</codebuff_tool_call>`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    expect(result[0].toolName).toBe('write_file')
  })

  it('should skip tool calls without cb_tool_name', () => {
    const text = `<codebuff_tool_call>
{
  "paths": ["test.ts"]
}
</codebuff_tool_call>`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(0)
  })

  it('should return empty array for text without tool calls', () => {
    const text = 'Just some regular text without any tool calls'

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(0)
  })

  it('should return empty array for empty string', () => {
    const result = parseToolCallsFromText('')

    expect(result).toHaveLength(0)
  })

  it('should handle complex nested objects in input', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "spawn_agents",
  "agents": [
    {
      "agent_type": "file-picker",
      "prompt": "Find relevant files"
    },
    {
      "agent_type": "code-searcher",
      "params": {
        "searchQueries": [
          {"pattern": "function test"}
        ]
      }
    }
  ]
}
</codebuff_tool_call>`

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    expect(result[0].toolName).toBe('spawn_agents')
    expect(result[0].input.agents).toHaveLength(2)
  })

  it('should handle tool calls with escaped characters in strings', () => {
    const text =
      '<codebuff_tool_call>\n' +
      '{\n' +
      '  "cb_tool_name": "str_replace",\n' +
      '  "path": "test.ts",\n' +
      '  "replacements": [{"old": "console.log(\\"hello\\")", "new": "console.log(\'world\')"}]\n' +
      '}\n' +
      '</codebuff_tool_call>'

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    const replacements = result[0].input.replacements as Array<{
      old: string
      new: string
    }>
    expect(replacements[0].old).toBe('console.log("hello")')
  })

  it('should handle tool calls with newlines in content', () => {
    const text =
      '<codebuff_tool_call>\n' +
      '{\n' +
      '  "cb_tool_name": "write_file",\n' +
      '  "path": "test.ts",\n' +
      '  "content": "line1\\nline2\\nline3"\n' +
      '}\n' +
      '</codebuff_tool_call>'

    const result = parseToolCallsFromText(text)

    expect(result).toHaveLength(1)
    expect(result[0].input.content).toBe('line1\nline2\nline3')
  })
})

describe('parseTextWithToolCalls', () => {
  it('should parse interleaved text and tool calls', () => {
    const text = `Some commentary before

<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["file1.ts"]
}
</codebuff_tool_call>

Some text between

<codebuff_tool_call>
{
  "cb_tool_name": "write_file",
  "path": "file2.ts",
  "content": "test"
}
</codebuff_tool_call>

Some commentary after`

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(5)
    expect(result[0]).toEqual({ type: 'text', text: 'Some commentary before' })
    expect(result[1]).toEqual({
      type: 'tool_call',
      toolName: 'read_files',
      input: { paths: ['file1.ts'] },
    })
    expect(result[2]).toEqual({ type: 'text', text: 'Some text between' })
    expect(result[3]).toEqual({
      type: 'tool_call',
      toolName: 'write_file',
      input: { path: 'file2.ts', content: 'test' },
    })
    expect(result[4]).toEqual({ type: 'text', text: 'Some commentary after' })
  })

  it('should return only tool call when no surrounding text', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"]
}
</codebuff_tool_call>`

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'tool_call',
      toolName: 'read_files',
      input: { paths: ['test.ts'] },
    })
  })

  it('should return only text when no tool calls', () => {
    const text = 'Just some regular text without any tool calls'

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'text',
      text: 'Just some regular text without any tool calls',
    })
  })

  it('should return empty array for empty string', () => {
    const result = parseTextWithToolCalls('')

    expect(result).toHaveLength(0)
  })

  it('should handle text only before tool call', () => {
    const text = `Introduction text

<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"]
}
</codebuff_tool_call>`

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'text', text: 'Introduction text' })
    expect(result[1].type).toBe('tool_call')
  })

  it('should handle text only after tool call', () => {
    const text = `<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"]
}
</codebuff_tool_call>

Conclusion text`

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('tool_call')
    expect(result[1]).toEqual({ type: 'text', text: 'Conclusion text' })
  })

  it('should skip malformed tool calls but keep surrounding text', () => {
    const text = `Before text

<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"
}
</codebuff_tool_call>

After text`

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'text', text: 'Before text' })
    expect(result[1]).toEqual({ type: 'text', text: 'After text' })
  })

  it('should trim whitespace from text segments', () => {
    const text = `   
  Text with whitespace  
   
<codebuff_tool_call>
{
  "cb_tool_name": "read_files",
  "paths": ["test.ts"]
}
</codebuff_tool_call>
   
  More text  
   `

    const result = parseTextWithToolCalls(text)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: 'text', text: 'Text with whitespace' })
    expect(result[1].type).toBe('tool_call')
    expect(result[2]).toEqual({ type: 'text', text: 'More text' })
  })
})
