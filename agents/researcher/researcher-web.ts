import { GEMINI_3_5_FLASH_LITE_MODEL_ID } from '@codebuff/common/constants/gemini'

import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'researcher-web',
  publisher,
  model: GEMINI_3_5_FLASH_LITE_MODEL_ID,
  displayName: 'Web Researcher',
  spawnerPrompt: `Browses the web to find relevant information.`,
  inputSchema: {
    prompt: {
      type: 'string',
      description: 'A question you would like answered using web search',
    },
  },
  outputMode: 'last_message',
  includeMessageHistory: false,
  toolNames: ['web_search', 'read_url'],
  spawnableAgents: [],

  systemPrompt: `You are an expert researcher who can search the web to find relevant information. Start with web_search using a focused keyword query and a standalone objective. Base your answer on the returned excerpts when they cover the question. Cite their URLs. Use read_url for a specific page the user asked you to read, or when an excerpt lacks context, a precise detail, or evidence for a claim.`,
  instructionsPrompt: `Prefer primary sources. Combine related keyword variations in one search. Use indexed content by default and set live only when a recent change could affect the answer. If the evidence leaves a gap, fetch the most relevant page with a focused objective, or refine the search if it found the wrong sources. Stop as soon as you can answer. Give concise findings with the source URL supporting each, and say what you could not verify.`,
  // Without this, every step ends the conversation on a raw tool result and
  // the model is never asked for anything, so it ends the step after thinking
  // — no text, no tool call — and the spawner gets a thinking trace instead of
  // the summary.
  stepPrompt: `Continue. Respond with either more tool calls or your final written answer.`,

  // Spawned agents otherwise get up to 200 steps. Keep a hard ceiling in
  // case a researcher continues looking after a source cannot be read.
  handleSteps: function* () {
    // Constants live inside handleSteps: it is serialized with toString() and
    // re-evaluated standalone, so nothing outside this body is in scope.
    const MAX_RESEARCH_STEPS = 15

    for (let step = 0; step < MAX_RESEARCH_STEPS; step++) {
      const { stepsComplete } = yield 'STEP'
      if (stepsComplete) return
    }

    yield {
      toolName: 'add_message',
      input: {
        role: 'user',
        content:
          'You have used all of your research steps. Do not call any more tools. Write your final answer now from the pages and search results you already have, cite the URLs supporting your findings, and say plainly which parts you could not verify.',
      },
      includeToolCall: false,
    }
    yield 'STEP'
  },
}

export default definition
