/** The step that spends a session past its target ends with a notice of the
 * next step's pause; hosts learn it before that pause starts. */
import { sessionSlowedNotice } from '@codebuff/common/util/freebuff-session-slowed'
import { streamText } from 'ai'
import { afterEach, expect, test } from 'bun:test'

import {
  getModelForRequest,
  setFreeModeSessionSlowedListener,
  type FreeModeSessionSlowed,
} from '../model-provider'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  setFreeModeSessionSlowedListener(null)
})

test('the step that crosses the target announces the next pause at its end', async () => {
  const chunk = {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'z-ai/glm-5.3-flash',
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
  }
  globalThis.fetch = (async () =>
    new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` +
        `: freebuff-session-slowed {malformed\n\n` +
        sessionSlowedNotice({ instanceId: 'tab', delayMs: 15_000 }),
      { headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch
  const seen: FreeModeSessionSlowed[] = []
  setFreeModeSessionSlowedListener((slowed) => seen.push(slowed))
  const before = Date.now()
  const result = streamText({
    model: getModelForRequest({ apiKey: 'k', model: 'z-ai/glm-5.3-flash' }),
    messages: [{ role: 'user', content: 'hi' }],
  })
  // The answer is untouched, and the notice has been seen by the time it ends.
  expect(await result.text).toBe('ok')
  expect(seen).toMatchObject([{ instanceId: 'tab', delayMs: 15_000 }])
  expect(seen[0]!.sentAt).toBeGreaterThanOrEqual(before)
})
