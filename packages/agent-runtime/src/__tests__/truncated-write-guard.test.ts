import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { describe, expect, it } from 'bun:test'

import { mockFileContext } from './test-utils'
import { processFileBlock } from '../process-file-block'
import { processStream } from '../tools/stream-parser'
import {
  detectTruncatedRewrite,
  isTruncatedJsonPrefix,
} from '../util/truncated-write-guard'

import type { AgentTemplate } from '../templates/types'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** A 316-line egui editor, the size of the file in the 2026-09-29 report. */
function eguiEditorSource(): string {
  const lines = [
    'use eframe::egui;',
    '',
    'pub struct Editor {',
    '    pub text: String,',
    '    pub dirty: bool,',
    '}',
    '',
    'impl Editor {',
  ]
  let i = 0
  while (lines.length < 306) {
    lines.push(
      `    pub fn toolbar_${i}(&mut self, ui: &mut egui::Ui) {`,
      '        ui.horizontal_wrapped(|ui| {',
      `            if ui.button("Action ${i}").clicked() {`,
      '                self.dirty = true;',
      '            }',
      '        });',
      '    }',
      '',
    )
    i++
  }
  lines.push(
    '    pub fn show(&mut self, ui: &mut egui::Ui) {',
    '        ui.horizontal_wrapped(|ui| {',
    '            ui.label("Editor");',
    '        });',
    '        ui.text_edit_multiline(&mut self.text);',
    '    }',
    '}',
    '',
  )
  return lines.join('\n')
}

/** The same file cut off mid-expression, as the model reported it. */
function cutOffCopy(source: string): string {
  const cut = source.indexOf('ui.horizontal_wrapped(|ui', source.length / 3)
  return source.slice(0, cut) + 'ui.horizontal_wrapped(ui'
}

describe('isTruncatedJsonPrefix', () => {
  it('recognises arguments cut off inside a string', () => {
    // The tail of real GPT-6 Luna write_file arguments cut by
    // max_output_tokens (OpenRouter, 2026-09-29 probe).
    expect(
      isTruncatedJsonPrefix(
        '{"path":"src/editor.rs","instructions":"Create the editor","content":"use eframe::egui;\\n\\n    /// Marks the current document as saved.\\n    pub fn mark_saved(&mut',
      ),
    ).toBe(true)
  })

  it('recognises arguments cut off between members or inside arrays', () => {
    expect(isTruncatedJsonPrefix('{"path": "a.ts", ')).toBe(true)
    expect(
      isTruncatedJsonPrefix(
        '{"path":"a.ts","replacements":[{"oldString":"a","newString":"b"}',
      ),
    ).toBe(true)
    // Double-encoded arguments cut off inside the outer string.
    expect(
      isTruncatedJsonPrefix('"{\\"path\\":\\"a.ts\\",\\"content\\":\\"x'),
    ).toBe(true)
  })

  it('does not call malformed or non-JSON input truncated', () => {
    expect(isTruncatedJsonPrefix('{"path": "a.ts"]')).toBe(false)
    expect(isTruncatedJsonPrefix('{"path": "a.ts"}}')).toBe(false)
    expect(isTruncatedJsonPrefix('path=a.ts')).toBe(false)
    expect(isTruncatedJsonPrefix('')).toBe(false)
    expect(isTruncatedJsonPrefix('{"a": "b"}')).toBe(false)
  })
})

describe('detectTruncatedRewrite', () => {
  const source = eguiEditorSource()

  it('refuses a cut-off copy of an existing file', () => {
    expect(source.split('\n').length).toBeGreaterThanOrEqual(310)
    const result = detectTruncatedRewrite(source, cutOffCopy(source))
    expect(result).not.toBeNull()
    expect(result!.oldLines).toBe(source.split('\n').length)
    expect(result!.openBrackets).toBeGreaterThan(0)
    expect(result!.lastLine).toContain('ui.horizontal_wrapped(ui')
  })

  it('allows a legitimate, much shorter rewrite', () => {
    const rewrite = [
      'use eframe::egui;',
      '',
      'pub struct Editor { pub text: String }',
      '',
      'impl Editor {',
      '    pub fn show(&mut self, ui: &mut egui::Ui) {',
      '        ui.text_edit_multiline(&mut self.text);',
      '    }',
      '}',
      '',
    ].join('\n')
    expect(detectTruncatedRewrite(source, rewrite)).toBeNull()
  })

  it('allows edits that keep most of the file, even mid-expression', () => {
    const lines = source.split('\n')
    const mostly = lines.slice(0, Math.floor(lines.length * 0.8)).join('\n')
    expect(detectTruncatedRewrite(source, mostly + '\n    fn f(')).toBeNull()
  })

  it('leaves small files alone', () => {
    const small = 'fn main() {\n    println!("hi");\n}\n'
    expect(detectTruncatedRewrite(small, 'fn main() {')).toBeNull()
  })

  it('does not judge a file whose own brackets do not balance', () => {
    // A string literal throws the naive count off; the guard stands down.
    const odd = source.replace('"Editor"', '"Editor :-("')
    expect(detectTruncatedRewrite(odd, cutOffCopy(odd))).toBeNull()
  })
})

describe('processFileBlock', () => {
  it('refuses to replace a file with a cut-off copy of itself', async () => {
    const source = eguiEditorSource()
    const result = await processFileBlock({
      path: 'src/editor.rs',
      initialContentPromise: Promise.resolve(source),
      newContent: cutOffCopy(source),
      logger,
    })
    expect(result.aborted).toBe(false)
    if (result.aborted) return
    expect('error' in result.value).toBe(true)
    if (!('error' in result.value)) return
    expect(result.value.error).toContain('Refused to write `src/editor.rs`')
    expect(result.value.error).toContain('Nothing was written')
  })

  it('still writes an ordinary edit', async () => {
    const source = eguiEditorSource()
    const result = await processFileBlock({
      path: 'src/editor.rs',
      initialContentPromise: Promise.resolve(source),
      newContent: source.replace('"Editor"', '"Text editor"'),
      logger,
    })
    expect(result.aborted).toBe(false)
    if (result.aborted) return
    expect('content' in result.value).toBe(true)
  })
})

describe('processStream with a write_file cut off by the output limit', () => {
  const agentTemplate: AgentTemplate = {
    id: 'test-agent',
    displayName: 'Test Agent',
    spawnerPrompt: 'Test agent',
    model: 'openai/gpt-6-luna',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: ['write_file', 'str_replace', 'end_turn'],
    spawnableAgents: [],
    systemPrompt: 'Test system prompt',
    instructionsPrompt: '',
    stepPrompt: '',
  }

  it('never applies the partial call and says why', async () => {
    // What the OpenAI-compatible provider flushes at end of stream for a tool
    // call whose arguments never closed: the raw argument text as `input`
    // (AI SDK marks it invalid and passes it through unparsed).
    const partialArguments =
      '{"path":"src/editor.rs","instructions":"Rewrite the editor","content":"use eframe::egui;\\n\\nimpl Editor {\\n    pub fn show(&mut self, ui: &mut egui::Ui) {\\n        ui.horizontal_wrapped(ui'
    const chunk = {
      type: 'tool-call',
      toolName: 'write_file',
      toolCallId: 'call_WN6oILk658sfhEDHb2eRDPwp',
      input: partialArguments,
    } as unknown as StreamChunk

    async function* stream() {
      yield chunk
      return promptSuccess('gen-truncated')
    }

    const agentState = getInitialSessionState(mockFileContext).mainAgentState
    const responseChunks: (string | PrintModeEvent)[] = []
    const clientToolCalls: unknown[] = []

    const result = await processStream({
      ...TEST_AGENT_RUNTIME_IMPL,
      sendAction: () => {},
      requestToolCall: async (params: unknown) => {
        clientToolCalls.push(params)
        return { output: [] }
      },
      agentContext: {},
      agentState,
      agentStepId: 'step',
      agentTemplate,
      ancestorRunIds: [],
      clientSessionId: 'session',
      fileContext: mockFileContext,
      fingerprintId: 'fp',
      fullResponse: '',
      localAgentTemplates: { 'test-agent': agentTemplate },
      messages: [],
      prompt: 'rewrite the editor',
      repoId: undefined,
      repoUrl: undefined,
      runId: 'run',
      signal: new AbortController().signal,
      stream: stream(),
      system: 'system',
      tools: {},
      userId: 'user',
      userInputId: 'input',
      onCostCalculated: async () => {},
      onResponseChunk: (c) => {
        responseChunks.push(c)
      },
    })

    expect(clientToolCalls).toHaveLength(0)
    expect(
      responseChunks.filter(
        (c) => typeof c !== 'string' && c.type === 'tool_call',
      ),
    ).toHaveLength(0)
    expect(result.hadToolCallError).toBe(true)

    const note = agentState.messageHistory
      .filter((m) => m.role === 'user' && m.tags?.includes('TOOL_CALL_ERROR'))
      .map((m) => JSON.stringify(m.content))
      .join('\n')
    expect(note).toContain('Your write_file call was cut off')
    expect(note).toContain('`src/editor.rs` is unchanged on disk')
    // The partial content is not echoed back as if it were the file.
    expect(note).not.toContain('horizontal_wrapped(ui')
  })
})
