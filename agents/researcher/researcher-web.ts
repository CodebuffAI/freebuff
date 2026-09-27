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

  systemPrompt: `You are an expert researcher who can search the web to find relevant information. Your goal is to answer the user's question from current search results and useful source pages. Use web_search to get Serper JSON search results. Use read_url to fetch and extract readable text from pages that would help answer the user's question. Search snippets and answer boxes are NOT evidence and are often stale — you must read source pages with read_url before answering.`,
  instructionsPrompt: `Provide comprehensive research on the user's prompt.

Research iteratively, in multiple rounds:
1. Start with 1-2 web_search calls. Inspect the titles, links, snippets, answer boxes, and related results.
2. Call read_url on the most promising results, especially official or primary sources. Call read_url on several pages at once, in parallel.
3. After reading, check what is still missing, uncertain, or worth verifying. Run follow-up searches with refined queries (using new terms you learned from the pages) and read more pages until the question is well covered from multiple sources.

If read_url cannot handle a source, choose a different result or explain the limitation.

Then, write a concise answer with key findings and cite the URLs of source pages you actually read for those findings. Include these source URLs in the final answer so the parent agent can pass them on to the user.

HARD RULE: You may not write your final answer until you have successfully fetched at least 3 pages with read_url — for multi-part or comparative questions, fetch 5 or more. Search results alone are never sufficient, no matter how complete they look. If you are about to answer and have fewer than 3 read_url fetches, call read_url instead. The one exception: if read_url has already failed on several different pages, stop retrying and answer from what you have, saying which claims you could not verify.

You have a limited number of research steps. Be efficient: batch your read_url calls in parallel, and answer as soon as the question is well covered.
`.trim(),
  // Without this, every step ends the conversation on a raw tool result and
  // the model is never asked for anything, so it ends the step after thinking
  // — no text, no tool call — and the spawner gets a thinking trace instead of
  // the summary.
  stepPrompt: `Continue. Respond with either more tool calls or your final written answer.`,

  // A spawned agent gets the runtime's default of 200 steps whatever its
  // parent's maxAgentSteps is (spawn-agent-utils.ts), and nothing above ever
  // stops a researcher that will not write its answer — the HARD RULE above
  // keeps it searching whenever read_url fails. That is how five chat messages
  // became 1,519 researcher calls in one hour on 2026-09-26. Measured over
  // that day's 13,384 chat messages: a message that researched at all used 4
  // researcher calls at the least, most often 6-10, and 16 at the median
  // across ALL of its researchers — so 15 research steps plus one forced
  // answer per researcher stops only the runaway ones.
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
          'You have used all of your research steps. Do not call any more tools. Write your final answer now from the pages and search results you already have, cite the URLs you read, and say plainly which parts you could not verify.',
      },
      includeToolCall: false,
    }
    yield 'STEP'
  },
}

export default definition
