import { expect, test } from 'bun:test'

import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'

import { getAgentStreamFromTemplate } from '../prompt-agent-stream'

import type { AgentTemplate } from '../templates/types'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'

test('agent requests do not set an automatic provider stop', () => {
  const runtime = createTestAgentRuntimeParams()
  const template = runtime.agentTemplate as AgentTemplate

  getAgentStreamFromTemplate({
    ...runtime,
    clientSessionId: 'test-session',
    fingerprintId: 'test-fingerprint',
    localAgentTemplates: { [template.id]: template },
    messages: [],
    runId: 'test-run',
    signal: new AbortController().signal,
    template,
    tools: {},
    userId: 'test-user',
    userInputId: 'test-input',
    promptAiSdkStream: runtime.promptAiSdkStream as PromptAiSdkStreamFn,
  })

  expect(runtime.promptAiSdkStream).toHaveBeenCalledTimes(1)
  expect(runtime.promptAiSdkStream.mock.calls[0]?.[0]).not.toHaveProperty(
    'stopSequences',
  )
})
