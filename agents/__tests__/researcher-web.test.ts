import { describe, expect, test } from 'bun:test'

import researcherWeb from '../researcher/researcher-web'

import type { AgentState, AgentStepContext } from '../types/agent-definition'

const agentState: AgentState = {
  agentId: 'researcher-web-test',
  runId: 'test-run',
  parentId: undefined,
  messageHistory: [],
  output: undefined,
  systemPrompt: '',
  toolDefinitions: {},
  contextTokenCount: 0,
}

/** Drives handleSteps the way the runtime does, answering each 'STEP' with
 *  `stepsComplete` from `finishesAfter` and recording everything yielded. */
function drive(finishesAfter: number | null) {
  const generator = researcherWeb.handleSteps!({
    agentState,
    prompt: 'q',
    logger: console as unknown as AgentStepContext['logger'],
  })
  const yielded: unknown[] = []
  let steps = 0
  let next = generator.next()
  while (!next.done) {
    yielded.push(next.value)
    if (next.value === 'STEP') steps++
    next = generator.next({
      agentState,
      toolResult: undefined,
      stepsComplete: finishesAfter !== null && steps >= finishesAfter,
    })
  }
  return { yielded, steps }
}

describe('researcher-web step budget', () => {
  test('a researcher that answers on its own is never interrupted', () => {
    const { yielded, steps } = drive(6)
    expect(steps).toBe(6)
    expect(yielded.every((v) => v === 'STEP')).toBe(true)
  })

  test('a researcher that never answers is told to, then stopped', () => {
    const { yielded, steps } = drive(null)
    // 15 research steps plus exactly one forced answer — not the runtime's
    // default of 200 for a spawned agent.
    expect(steps).toBe(16)
    const forced = yielded[yielded.length - 2] as {
      toolName: string
      input: { role: string; content: string }
    }
    expect(forced.toolName).toBe('add_message')
    expect(forced.input.role).toBe('user')
    expect(forced.input.content).toContain('Do not call any more tools')
    expect(yielded[yielded.length - 1]).toBe('STEP')
  })

  test('survives serialization, as the runtime runs it', () => {
    // handleSteps is shipped as toString() source and re-evaluated standalone.
    const source = researcherWeb.handleSteps!.toString()
    const revived = new Function(`return (${source})`)() as NonNullable<
      typeof researcherWeb.handleSteps
    >
    const generator = revived({
      agentState,
      logger: console as unknown as AgentStepContext['logger'],
    })
    expect(generator.next().value).toBe('STEP')
  })
})
