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

HARD RULE: You may not write your final answer until you have successfully fetched at least 3 pages with read_url — for multi-part or comparative questions, fetch 5 or more. Search results alone are never sufficient, no matter how complete they look. If you are about to answer and have fewer than 3 read_url fetches, call read_url instead.
`.trim(),
  // Without this, every step ends the conversation on a raw tool result and
  // the model is never asked for anything, so it ends the step after thinking
  // — no text, no tool call — and the spawner gets a thinking trace instead of
  // the summary.
  stepPrompt: `Continue. Respond with either more tool calls or your final written answer.`,
}

export default definition
