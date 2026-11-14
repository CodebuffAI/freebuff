import { describe, expect, it } from 'bun:test'

import { createTurnProgress } from '../turn-progress'

import type { StepToolCall } from '../turn-progress'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

let id = 0
const step = (
  toolName: string,
  input: unknown,
  output: unknown,
): [StepToolCall[], ToolMessage[]] => {
  const toolCallId = `call-${id++}`
  const result: ToolMessage = {
    role: 'tool',
    toolName,
    toolCallId,
    content: [{ type: 'json', value: output as never }],
  }
  return [[{ toolCallId, toolName, input }], [result]]
}

const search = (pattern: string, output = 'no matches') =>
  step('code_search', { pattern }, output)

describe('createTurnProgress', () => {
  it('counts the same call with the same result, across generated call ids', () => {
    const progress = createTurnProgress()
    expect(progress.recordStep(...search('a'))).toBe(0)
    expect(progress.recordStep(...search('a'))).toBe(1)
    expect(progress.recordStep(...search('a'))).toBe(2)
  })

  it('counts a cycle of old results, which a trailing-identical check cannot see', () => {
    const progress = createTurnProgress()
    progress.recordStep(...search('a'))
    progress.recordStep(...search('b'))
    expect(progress.recordStep(...search('a'))).toBe(1)
    expect(progress.recordStep(...search('b'))).toBe(2)
    expect(progress.recordStep(...search('a'))).toBe(3)
  })

  it('treats new output from the same command as progress, so polling is not stuck', () => {
    const progress = createTurnProgress()
    for (let percent = 0; percent < 100; percent++) {
      const poll = step(
        'run_terminal_command',
        { command: 'tail build.log' },
        { stdout: `${percent}%` },
      )
      expect(progress.recordStep(...poll)).toBe(0)
    }
  })

  it('never counts a long stretch of new reads', () => {
    const progress = createTurnProgress()
    for (let file = 0; file < 500; file++) {
      const read = step('read_files', { paths: [`src/${file}.ts`] }, 'text')
      expect(progress.recordStep(...read)).toBe(0)
    }
  })

  it('lets an accepted edit clear a stretch of repeated reads', () => {
    const progress = createTurnProgress()
    for (let i = 0; i < 30; i++) progress.recordStep(...search('a'))
    expect(progress.recordStep(...search('a'))).toBe(30)
    const edit = step('str_replace', { path: 'a.ts' }, { file: 'a.ts' })
    expect(progress.recordStep(...edit)).toBe(0)
  })

  it('does not count a rejected edit as progress, even when it varies', () => {
    const progress = createTurnProgress()
    for (let attempt = 1; attempt <= 5; attempt++) {
      const edit = step(
        'str_replace',
        { path: 'a.ts', old: `attempt ${attempt}` },
        { file: 'a.ts', errorMessage: 'old string not found' },
      )
      expect(progress.recordStep(...edit)).toBe(attempt)
    }
  })

  it('does not count bookkeeping, or a step with no tools', () => {
    const progress = createTurnProgress()
    for (let i = 1; i <= 3; i++) {
      const todos = step(
        'write_todos',
        { todos: [`task ${i}`] },
        'Todos written',
      )
      expect(progress.recordStep(...todos)).toBe(i)
    }
    expect(progress.recordStep([], [])).toBe(4)
  })

  it('counts a step as progress when any one of its results is new', () => {
    const progress = createTurnProgress()
    progress.recordStep(...search('a'))
    const [oldCall, oldResult] = search('a')
    const [newCall, newResult] = search('b')
    expect(
      progress.recordStep(
        [...oldCall, ...newCall],
        [...oldResult, ...newResult],
      ),
    ).toBe(0)
  })

  it('starts over after reset, and still remembers what it has seen', () => {
    const progress = createTurnProgress()
    progress.recordStep(...search('a'))
    progress.recordStep(...search('a'))
    progress.reset()
    expect(progress.recordStep(...search('a'))).toBe(1)
  })
})
