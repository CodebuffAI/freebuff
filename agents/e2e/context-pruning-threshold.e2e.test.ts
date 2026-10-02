/**
 * E2E Test: Context Pruning Threshold Verification
 *
 * This test verifies that context pruning triggers at the correct token count
 * threshold and not prematurely. It uses the real token counting API and
 * a multi-turn conversation to accumulate context naturally.
 *
 * Background: A previous bug caused the token counting API to either fail
 * (falling back to a local overcounting formula) or apply a 30% buffer
 * for non-Anthropic models, causing pruning to trigger at ~140k instead
 * of the 200k limit. This test ensures:
 *
 * 1. Pruning does NOT trigger when token count is well below the limit
 * 2. Pruning DOES trigger when token count exceeds the limit
 * 3. The token count reported by the API is accurate (no 30% buffer for Anthropic models)
 * 4. After pruning, tool-call/tool-result pairs remain intact
 *
 * Detection strategy: We detect pruning by checking for significant message
 * count reduction and token count reduction. The context-pruner may produce
 * a <conversation_summary> message, OR the fallback trimMessagesToFitTokenLimit
 * may produce <system>Previous message(s) omitted due to length</system>.
 * Both count as successful pruning for our purposes.
 */

import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import {
  CodebuffClient,
  initialSessionState,
  withMessageHistory,
  type AgentDefinition,
  type Message,
  type ToolMessage,
  type JSONValue,
} from '@codebuff/sdk'
import { describe, expect, it } from 'bun:test'

import contextPruner from '../context-pruner'

import type { ToolCallPart } from '@codebuff/common/types/messages/content-part'

/**
 * Type guard to check if a content part is a tool-call part with toolCallId.
 */
function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    part.type === 'tool-call' &&
    'toolCallId' in part &&
    typeof (part as ToolCallPart).toolCallId === 'string'
  )
}

/**
 * Type guard to check if a message is a tool message with toolCallId.
 */
function isToolMessageWithId(
  msg: Message,
): msg is ToolMessage & { toolCallId: string } {
  return (
    msg.role === 'tool' &&
    'toolCallId' in msg &&
    typeof msg.toolCallId === 'string'
  )
}

// Helper to create a text message
const createMessage = (
  role: 'user' | 'assistant',
  content: string,
): Message => ({
  role,
  content: [{ type: 'text', text: content }],
})

// Helper to create a tool call message
const createToolCallMessage = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input,
    },
  ],
})

// Helper to create a tool result message
const createToolResultMessage = (
  toolCallId: string,
  toolName: string,
  value: JSONValue,
): ToolMessage => ({
  role: 'tool',
  toolCallId,
  toolName,
  content: [{ type: 'json', value }],
})

/**
 * Test agent that auto-spawns context-pruner inline before each step,
 * exactly mirroring how base2 works in production.
 *
 * The handleSteps function uses ({ params }) to receive maxContextLength
 * from client.run({ params: { maxContextLength: ... } }), which flows through
 * as spawnParams → toolCallParams → generator params, matching base2 exactly.
 */
const testAgent: AgentDefinition = {
  id: 'context-pruning-threshold-test-agent',
  displayName: 'Context Pruning Threshold Test Agent',
  model: 'anthropic/claude-haiku-4.5',
  includeMessageHistory: true,
  toolNames: ['spawn_agents'],
  spawnableAgents: ['context-pruner'],
  instructionsPrompt: `You are a test agent for verifying context pruning behavior. When the user asks you to do something, do it briefly and concisely. Just say "OK" or "DONE" as requested.`,
  handleSteps: function* ({ params }) {
    while (true) {
      // Run context-pruner before each step (same as base2 uses spawn_agent_inline)
      yield {
        toolName: 'spawn_agent_inline',
        input: {
          agent_type: 'context-pruner',
          params: params ?? {},
        },
        includeToolCall: false,
      } as any

      const { stepsComplete } = yield 'STEP'
      if (stepsComplete) break
    }
  },
}

/**
 * Builds a message history targeting a specific approximate token count.
 *
 * Token estimation uses word-based content (NATO alphabet words repeated)
 * which tokenizes at a predictable ~4 chars/token for Anthropic models.
 * This is much more accurate than repeated 'x' characters which compress
 * to ~5-6 chars/token, making estimates unreliable.
 *
 * Each round creates user (8k chars) + assistant (8k chars) +
 * tool pair every other round (~4k chars). At ~4 chars/token:
 * - User message: 8k/4 = 2k tokens
 * - Assistant message: 8k/4 = 2k tokens
 * - Tool pair (every other round avg): ~550 tokens
 * - Tokens per round ≈ 4,550
 * - Plus system prompt + tool definitions add ~15-20k tokens
 */
const LARGE_CONTENT_SIZE = 8_000
const CHARS_PER_TOKEN = 4
const TOOL_PAIR_TOKENS = 550 // avg tokens for tool call + result every other round
const TOKENS_PER_ROUND = Math.ceil(
  (2 * LARGE_CONTENT_SIZE) / CHARS_PER_TOKEN + TOOL_PAIR_TOKENS,
)

/**
 * Diverse word content that tokenizes predictably at ~4 chars/token.
 * Repeated 'x' characters compress to ~5-6 chars/token in Anthropic's BPE tokenizer,
 * making token estimates inaccurate. Using diverse words avoids this.
 */
const WORD_FILLER =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '

function makeLargeContent(prefix: string, size: number): string {
  const repeats = Math.ceil((size - prefix.length) / WORD_FILLER.length)
  return prefix + WORD_FILLER.repeat(repeats).slice(0, size - prefix.length)
}

function buildMessageHistory(targetApproxTokens: number): Message[] {
  const messages: Message[] = []
  const roundsNeeded = Math.max(1, Math.ceil(targetApproxTokens / TOKENS_PER_ROUND))
  const now = Date.now()

  console.log(
    `  Building ${roundsNeeded} rounds for ~${targetApproxTokens} tokens ` +
    `(est ${TOKENS_PER_ROUND} tokens/round)`,
  )

  for (let i = 0; i < roundsNeeded; i++) {
    // Add sentAt timestamps so context-pruner's cache-miss detection works correctly.
    // Space messages 30s apart so no cache-miss (>5min gap) is triggered inadvertently.
    const sentAt = now - (roundsNeeded - i) * 30_000

    // User message with diverse word content (~4 chars/token)
    const userMsg = createMessage(
      'user',
      makeLargeContent(`Round ${i + 1}: `, LARGE_CONTENT_SIZE),
    )
    userMsg.sentAt = sentAt
    messages.push(userMsg)

    // Assistant response with diverse word content
    const assistantMsg = createMessage(
      'assistant',
      makeLargeContent(`Response ${i + 1}: `, LARGE_CONTENT_SIZE),
    )
    assistantMsg.sentAt = sentAt + 10_000
    messages.push(assistantMsg)

    // Add a tool call pair every other round for realism
    if (i % 2 === 0) {
      const callId = `call-${i}`
      messages.push(
        createToolCallMessage(callId, 'read_files', { paths: [`file-${i}.ts`] }),
      )
      messages.push(
        createToolResultMessage(callId, 'read_files', {
          content: makeLargeContent('', LARGE_CONTENT_SIZE / 2),
        }),
      )
    }
  }

  return messages
}

/**
 * Detects whether context pruning occurred by checking for:
 * 1. <conversation_summary> tag (context-pruner's output)
 * 2. <system>Previous message(s) omitted due to length</system> (trimMessagesToFitTokenLimit fallback)
 * 3. Significant message count reduction (>50% fewer messages than original)
 */
function detectPruning(
  finalMessages: Message[],
  originalMessageCount: number,
): {
  wasPruned: boolean
  hasSummary: boolean
  hasTrimFallback: boolean
  messageReduction: number
} {
  const hasSummary = finalMessages.some((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return false
    return msg.content.some(
      (part) =>
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        typeof (part as any).text === 'string' &&
        (part as any).text.includes('<conversation_summary>'),
    )
  })

  const hasTrimFallback = finalMessages.some((msg) => {
    if (!Array.isArray(msg.content)) return false
    return msg.content.some(
      (part) =>
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        typeof (part as any).text === 'string' &&
        (part as any).text.includes('Previous message(s) omitted'),
    )
  })

  // Message reduction: if fewer than 50% of original messages remain
  const messageReduction =
    originalMessageCount > 0
      ? 1 - finalMessages.length / originalMessageCount
      : 0

  const wasPruned =
    hasSummary || hasTrimFallback || messageReduction > 0.5

  return { wasPruned, hasSummary, hasTrimFallback, messageReduction }
}

/**
 * Verifies tool-call/tool-result pair integrity.
 * Anthropic API rejects requests with orphaned tool calls or results.
 */
function verifyToolCallPairIntegrity(messages: Message[]) {
  const toolCallIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (isToolCallPart(part)) {
          toolCallIds.add(part.toolCallId)
        }
      }
    }
    if (isToolMessageWithId(msg)) {
      toolResultIds.add(msg.toolCallId)
    }
  }

  // Every tool result must have a matching tool call
  for (const resultId of toolResultIds) {
    expect(toolCallIds.has(resultId)).toBe(true)
  }
  // Every tool call must have a matching tool result
  for (const callId of toolCallIds) {
    expect(toolResultIds.has(callId)).toBe(true)
  }
}

describe('Context Pruning Threshold E2E', () => {
  it(
    'should NOT prune when token count is well below the limit',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]!
      if (!apiKey) {
        console.log('Skipping: No API key found')
        return
      }

      // Build message history targeting ~30k tokens of message content
      // With maxContextLength=100k, this should be well below the pruning threshold
      const messages = buildMessageHistory(30_000)

      const client = new CodebuffClient({
        apiKey,
        agentDefinitions: [testAgent, contextPruner],
      })

      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: {
          traceSessionId: 'test-trace-session',
          sessionState,
          output: { type: 'error', message: '' },
        },
        messages,
      })

      // Run the agent with maxContextLength=100k - context-pruner should NOT prune
      const run = await client.run({
        agent: testAgent.id,
        prompt: 'Say "OK" and nothing else.',
        previousRun: runStateWithMessages,
        params: { maxContextLength: 100_000 },
        handleEvent: (event) => {
          if (event.type === 'text') {
            console.log('  [below-limit] Agent text:', event.text.slice(0, 100))
          }
        },
      })

      // Should complete without error
      if (run.output.type === 'error') {
        console.error('Below-limit test error:', JSON.stringify(run.output, null, 2))
      }
      expect(run.output.type).not.toEqual('error')

      // Check the final message history
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []
      const tokenCount = run.sessionState?.mainAgentState.contextTokenCount ?? 0
      const pruningResult = detectPruning(finalMessages, messages.length)

      console.log('  [below-limit] Token count:', tokenCount)
      console.log(
        '  [below-limit] Message count:',
        finalMessages.length,
        '(original:',
        messages.length,
        ')',
      )
      console.log('  [below-limit] Pruning result:', pruningResult)

      // Key assertion: pruning should NOT have happened
      expect(pruningResult.wasPruned).toBe(false)

      // Token count should be below the limit
      expect(tokenCount).toBeLessThan(100_000)

      // CRITICAL: The token count should NOT have a 30% buffer applied
      // If the old bug were present, the actual count (~50k) would be reported as ~65k
      // With accurate counting for Anthropic models, no buffer is applied
      expect(tokenCount).toBeGreaterThan(10_000) // At least some tokens accumulated
      expect(tokenCount).toBeLessThan(80_000) // Well below limit even with natural variance
    },
    { timeout: 120_000 },
  )

  it(
    'should prune when token count exceeds the limit',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]!
      if (!apiKey) {
        console.log('Skipping: No API key found')
        return
      }

      // Build message history targeting ~80k tokens of message content
      // With maxContextLength=50k, this should exceed the pruning threshold
      const messages = buildMessageHistory(80_000)

      const client = new CodebuffClient({
        apiKey,
        agentDefinitions: [testAgent, contextPruner],
      })

      const sessionState = await initialSessionState({})
      const runStateWithMessages = withMessageHistory({
        runState: {
          traceSessionId: 'test-trace-session',
          sessionState,
          output: { type: 'error', message: '' },
        },
        messages,
      })

      // Run the agent with maxContextLength=50k - context-pruner SHOULD prune
      const run = await client.run({
        agent: testAgent.id,
        prompt: 'Say "DONE" and nothing else.',
        previousRun: runStateWithMessages,
        params: { maxContextLength: 50_000 },
        handleEvent: (event) => {
          if (event.type === 'text') {
            console.log('  [above-limit] Agent text:', event.text.slice(0, 100))
          }
        },
      })

      // Should complete without error
      if (run.output.type === 'error') {
        console.error('Above-limit test error:', JSON.stringify(run.output, null, 2))
      }
      expect(run.output.type).not.toEqual('error')

      // Check the final message history
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []
      const tokenCount = run.sessionState?.mainAgentState.contextTokenCount ?? 0
      const pruningResult = detectPruning(finalMessages, messages.length)

      console.log('  [above-limit] Token count:', tokenCount)
      console.log(
        '  [above-limit] Message count:',
        finalMessages.length,
        '(original:',
        messages.length,
        ')',
      )
      console.log('  [above-limit] Pruning result:', pruningResult)

      // Key assertion: pruning SHOULD have happened
      // We accept any form of pruning: conversation_summary, trimMessages fallback, or significant reduction
      expect(pruningResult.wasPruned).toBe(true)

      // After pruning, the message count should be significantly reduced
      expect(finalMessages.length).toBeLessThan(messages.length)

      // Verify tool-call/tool-result pair integrity after pruning
      verifyToolCallPairIntegrity(finalMessages)

      // `contextTokenCount` is deliberately NOT asserted here. This used to read
      // `expect(tokenCount).toBeLessThan(50_000)`, which contradicted
      // `wasPruned` above: the pruner fires only when `contextTokenCount +
      // TOKEN_COUNT_FUDGE_FACTOR > maxContextLength`, so both could hold only if
      // the fixture happened to land in a ~1k sliver.
      //
      // Nor can the count describe the pruned history. run-agent-step.ts assigns
      // it once per step from the history as it stood BEFORE the inline pruner
      // runs, and handleSetMessages — how the pruner rewrites history — never
      // updates it. So in the single-step run this agent performs, the value
      // still reports what TRIGGERED pruning: 4 retained messages alongside a
      // ~63k count. It also counts the system prompt and tool schemas, which
      // pruning cannot remove. Nothing observable from the SDK carries the
      // per-step count (no PrintModeEvent variant exposes it), so there is no
      // step-count-independent way to assert on it — asserting it is above the
      // threshold instead would flip to failing the moment the model takes a
      // second step and the counter is recomputed from the pruned history.
      //
      // Losing it costs no coverage that matters. A fixture that quietly shrank
      // below the limit already fails `wasPruned` above: the pruner would
      // early-return via `set_messages` with no summary and no trim marker, and
      // `messageReduction` cannot reach the 0.5 that `detectPruning` requires.
    },
    { timeout: 180_000 },
  )

  it(
    'should verify token counting accuracy: no premature 30% buffer for Anthropic models',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]!
      if (!apiKey) {
        console.log('Skipping: No API key found')
        return
      }

      // This test verifies that, once the provider has reported usage, the
      // context size the pruner sees is anchored to that receipt rather than
      // inflated by a 30% buffer or by the local length estimate.
      //
      // Strategy: Run TWO agent calls over the same message history:
      //   1. Calibration run with 200k limit (no pruning) → measure TRUE token count
      //   2. Test run with 100k limit, CONTINUING the calibration run → check if
      //      pruning triggers
      //
      // Step 2 must continue from step 1. Since #3790 a history the provider
      // has never seen is sized by the cheap three-chars-per-token estimate in
      // agent-runtime's token-counter.ts, which overcounts this
      // ~4-chars-per-token fixture by about a third: a FRESH 88k history reads
      // as ~129k, so pruning it at a 100k limit says nothing about a real
      // conversation. Each response's usage then anchors the agent's count
      // (contextTokenBaseline), which is what a conversation runs on from its
      // second turn. Continuing the calibration run gives the 100k run that
      // receipt.
      //
      // If true tokens < 100k but pruning triggered in the 100k run, the
      // pruner decided on an over-reported count even though a receipt
      // existed (a 30% buffer, or the unanchored estimate).
      //
      // We target ~95k estimated tokens of content, which should produce ~95-100k
      // actual tokens — close to the 100k limit but safely under with accurate counting.
      //
      // Anchored counting:   ~90k < 100k → no pruning in either run ✓
      // 30% buffer:          ~90k reported as ~117k → premature pruning in 100k run ✗
      // Unanchored estimate: ~90k reported as ~120k+ → premature pruning in 100k run ✗

      // Create a large history targeting ~95k estimated tokens of message content
      const TARGET_ESTIMATED_TOKENS = 95_000
      const messages = buildMessageHistory(TARGET_ESTIMATED_TOKENS)

      const client = new CodebuffClient({
        apiKey,
        agentDefinitions: [testAgent, contextPruner],
      })

      // =========================================================================
      // Step 1: CALIBRATION RUN — measure true token count with 200k limit (no pruning)
      // =========================================================================
      const sessionStateCal = await initialSessionState({})
      const runStateCal = withMessageHistory({
        runState: {
          traceSessionId: 'test-trace-session',
          sessionState: sessionStateCal,
          output: { type: 'error', message: '' },
        },
        messages,
      })

      console.log('  [accuracy] Running calibration with 200k limit...')
      const calRun = await client.run({
        agent: testAgent.id,
        prompt: 'Say "CAL" and nothing else.',
        previousRun: runStateCal,
        params: { maxContextLength: 200_000 },
        handleEvent: (event) => {
          if (event.type === 'text') {
            console.log('  [accuracy-cal] Agent text:', event.text.slice(0, 100))
          }
        },
      })

      const trueTokenCount =
        calRun.sessionState?.mainAgentState.contextTokenCount ?? 0
      const calMessages =
        calRun.sessionState?.mainAgentState.messageHistory ?? []
      const calPruning = detectPruning(calMessages, messages.length)

      console.log('  [accuracy] ========== CALIBRATION RESULTS ==========')
      console.log('  [accuracy] TRUE token count (200k limit):', trueTokenCount)
      console.log(
        '  [accuracy] Cal message count:',
        calMessages.length,
        '(original:',
        messages.length,
        ')',
      )
      console.log('  [accuracy] Cal pruning result:', calPruning)
      console.log(
        '  [accuracy] Ratio true/estimated:',
        (trueTokenCount / TARGET_ESTIMATED_TOKENS).toFixed(2),
      )
      console.log('  [accuracy] =========================================')

      // Calibration should not have pruned (200k limit is very high)
      expect(calPruning.wasPruned).toBe(false)
      expect(trueTokenCount).toBeGreaterThan(50_000)

      // =========================================================================
      // Step 2: TEST RUN — continue the calibration run with a 100k limit
      // =========================================================================
      const MAX_CONTEXT_LENGTH = 100_000

      console.log('  [accuracy] Running test with 100k limit...')
      const run = await client.run({
        agent: testAgent.id,
        prompt: 'Say "ACK" and nothing else.',
        previousRun: calRun,
        params: { maxContextLength: MAX_CONTEXT_LENGTH },
        handleEvent: (event) => {
          if (event.type === 'text') {
            console.log('  [accuracy-100k] Agent text:', event.text.slice(0, 100))
          }
        },
      })

      if (run.output.type === 'error') {
        console.error('Accuracy test error:', JSON.stringify(run.output, null, 2))
      }
      expect(run.output.type).not.toEqual('error')

      const reportedTokenCount =
        run.sessionState?.mainAgentState.contextTokenCount ?? 0
      const finalMessages =
        run.sessionState?.mainAgentState.messageHistory ?? []
      const pruningResult = detectPruning(finalMessages, messages.length)

      console.log('  [accuracy] ========== 100K LIMIT TEST RESULTS ==========')
      console.log('  [accuracy] Reported token count:', reportedTokenCount)
      console.log(
        '  [accuracy] Final message count:',
        finalMessages.length,
        '(original:',
        messages.length,
        ')',
      )
      console.log('  [accuracy] Pruning result:', pruningResult)
      console.log(
        '  [accuracy] Was pruned:',
        pruningResult.wasPruned,
        '(true tokens were:',
        trueTokenCount,
        ', limit:',
        MAX_CONTEXT_LENGTH,
        ')',
      )
      console.log('  [accuracy] ================================================')

      // =========================================================================
      // DIAGNOSIS: Compare true tokens vs limit
      // =========================================================================
      if (trueTokenCount < MAX_CONTEXT_LENGTH && pruningResult.wasPruned) {
        console.error(
          `  ❌ BUG DETECTED: True tokens (${trueTokenCount}) < limit (${MAX_CONTEXT_LENGTH}), ` +
            `but pruning was triggered! The count the pruner saw is over-reporting despite a provider receipt.`,
        )
      } else if (
        trueTokenCount < MAX_CONTEXT_LENGTH &&
        !pruningResult.wasPruned
      ) {
        console.log(
          `  ✅ No bug: True tokens (${trueTokenCount}) < limit (${MAX_CONTEXT_LENGTH}), ` +
            `no pruning occurred.`,
        )
      } else {
        console.log(
          `  ⚠️ Content too large: True tokens (${trueTokenCount}) >= limit (${MAX_CONTEXT_LENGTH}). ` +
            `Pruning is expected. Adjust content size.`,
        )
      }

      // The ratio of true token count to our estimated content tokens.
      // Our estimate is for message content only; the actual count includes
      // system prompt + tool definitions. So ratio 1.0-1.3 is expected.
      // A 30% buffer on the full count would push the ratio above 1.3.
      const ratio = trueTokenCount / TARGET_ESTIMATED_TOKENS
      console.log(
        '  [accuracy] Ratio of true/estimated:',
        ratio.toFixed(2),
        '(expected: 1.0-1.3, 30% bug → 1.3+, fallback → 1.5+)',
      )
      expect(ratio).toBeLessThan(1.3)

      // CRITICAL: If true tokens are under 100k, no pruning should have occurred.
      // If true tokens >= 100k, pruning is expected and we skip this assertion.
      if (trueTokenCount < MAX_CONTEXT_LENGTH) {
        expect(pruningResult.wasPruned).toBe(false)
      } else {
        console.log(
          `  [accuracy] Content too large: true tokens (${trueTokenCount}) >= limit (${MAX_CONTEXT_LENGTH}). Pruning is expected.`,
        )
      }
    },
    { timeout: 300_000 },
  )
})
