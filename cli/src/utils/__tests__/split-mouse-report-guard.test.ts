import { describe, expect, test } from 'bun:test'
import { StdinParser } from '@opentui/core'

import {
  installSplitMouseReportGuard,
  SplitMouseReportGuard,
  STDIN_PARSER_TIMEOUT_MS,
} from '../split-mouse-report-guard'

import type { Clock } from '@opentui/core'

/**
 * OpenTUI's real stdin parser on a hand-driven clock, dispatched the way
 * CliRenderer.handleStdinEvent does: key raws and response sequences go to the
 * input handlers first, and a key no handler claims is typed.
 */
function createTerminal(handler?: (sequence: string) => boolean) {
  let now = 1_000
  const clock: Clock = {
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const parser = new StdinParser({ timeoutMs: 20, armTimeouts: false, clock })
  let typed = ''
  const mice: string[] = []
  const drain = () =>
    parser.drain((event) => {
      if (event.type === 'key') {
        if (handler?.(event.raw)) return
        typed += event.key.sequence
      } else if (event.type === 'mouse') {
        mice.push(event.raw)
      } else if (event.type === 'response') {
        handler?.(event.sequence)
      }
    })
  return {
    /** One stdin read, then the parser's timeout check `elapsedMs` later. */
    read(data: string, elapsedMs = 0) {
      parser.push(new TextEncoder().encode(data))
      drain()
      now += elapsedMs
      parser.flushTimeout(now)
      drain()
    },
    get typed() {
      return typed
    },
    mice,
  }
}

function guardedTerminal() {
  let now = 1_000
  const guard = new SplitMouseReportGuard(() => now)
  const terminal = createTerminal(guard.handleInput)
  return {
    terminal,
    advance(ms: number) {
      now += ms
    },
  }
}

describe('a mouse report split after its ESC [', () => {
  test('is typed as text by OpenTUI on its own (the reported leak)', () => {
    const terminal = createTerminal()
    terminal.read('\x1b[', 25)
    terminal.read('<35;76;40M')
    expect(terminal.typed).toBe('<35;76;40M')
  })

  test('types nothing behind the guard', () => {
    const { terminal } = guardedTerminal()
    for (const report of ['<35;76;40M', '<35;51;27M', '<64;58;16M', '<65;57;20m']) {
      terminal.read('\x1b[', 25)
      terminal.read(report)
    }
    expect(terminal.typed).toBe('')
  })

  test('lets the reports that follow it in the same read parse as mouse events', () => {
    const { terminal } = guardedTerminal()
    terminal.read('\x1b[', 25)
    terminal.read('<35;76;40M\x1b[<35;77;40Mhi')
    expect(terminal.typed).toBe('hi')
    expect(terminal.mice).toEqual(['\x1b[<35;77;40M'])
  })
})

describe('typing behind the guard', () => {
  test('keeps text that only looks like a report', () => {
    const { terminal } = guardedTerminal()
    terminal.read('<35;76;40M')
    expect(terminal.typed).toBe('<35;76;40M')
  })

  test('keeps what follows a flushed ESC [ that is not a report', () => {
    const { terminal } = guardedTerminal()
    terminal.read('\x1b[', 25)
    terminal.read('x<1;2;3M')
    expect(terminal.typed).toBe('x<1;2;3M')
  })

  test('stops swallowing at the first key that breaks the report', () => {
    const { terminal } = guardedTerminal()
    terminal.read('\x1b[', 25)
    terminal.read('<35;ab')
    expect(terminal.typed).toBe('ab')
  })

  test('keeps a `<` typed long after a flushed ESC [', () => {
    const { terminal, advance } = guardedTerminal()
    terminal.read('\x1b[', 25)
    advance(5_000)
    terminal.read('<3;4;5M')
    expect(terminal.typed).toBe('<3;4;5M')
  })
})

describe('installSplitMouseReportGuard', () => {
  function fakeRenderer(timeoutMs: number) {
    const handlers: ((sequence: string) => boolean)[] = []
    return {
      stdinParser: { timeoutMs },
      handlers,
      prependInputHandler(handler: (sequence: string) => boolean) {
        handlers.unshift(handler)
      },
      removeInputHandler(handler: (sequence: string) => boolean) {
        handlers.splice(handlers.indexOf(handler), 1)
      },
    }
  }

  test('gives split sequences longer to arrive and removes its handler on uninstall', () => {
    const renderer = fakeRenderer(20)
    const uninstall = installSplitMouseReportGuard(renderer)
    expect(renderer.stdinParser.timeoutMs).toBe(STDIN_PARSER_TIMEOUT_MS)
    expect(renderer.handlers).toHaveLength(1)
    uninstall()
    expect(renderer.handlers).toHaveLength(0)
  })

  test('never shortens a longer parser timeout', () => {
    const renderer = fakeRenderer(500)
    installSplitMouseReportGuard(renderer)
    expect(renderer.stdinParser.timeoutMs).toBe(500)
  })
})
