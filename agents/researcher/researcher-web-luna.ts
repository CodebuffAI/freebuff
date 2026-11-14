import { FREEBUFF_GPT_6_LUNA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import researcherWeb from './researcher-web'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

/** The id a root lists in `spawnableAgents` to offer this researcher. */
export const WEB_RESEARCHER_AGENT_ID = 'researcher-web'

/**
 * When to delegate to the researcher rather than search directly. Appended to
 * the system prompt of every root that offers it (Desktop and Web/Cloud base3).
 */
export const WEB_RESEARCHER_GUIDANCE = `# Web research

For a web lookup, start with web_search and read its excerpts. Answer from them and cite their URLs if they cover the question. Use read_url when a specific page is requested or an excerpt needs more context. Set live only for time-sensitive information. For research that needs multiple independent lookups, spawn the researcher-web agent with a focused question. Don't research what the codebase already answers.`

/**
 * researcher-web on GPT-6 Luna: the web researcher Legacy Chat ran, now also
 * spawned by the Freebuff Desktop and Web/Cloud base3 roots. Same id, prompts
 * and step cap as the shared definition; only the model differs.
 *
 * A separate binding rather than a change to researcher-web.ts, because the CLI
 * and Codebuff's paid roots spawn that file too and keep Gemini Flash Lite.
 * Free mode admits Luna for this id as helper traffic in any session
 * (FREEBUFF_LUNA_HELPER_AGENT_IDS in common/src/constants/free-agents.ts).
 *
 * Medium effort because, unset, the server pins Luna's catalog `high`, several
 * times slower per research call, and `low` finds less.
 */
const definition: SecretAgentDefinition = {
  ...researcherWeb,
  id: WEB_RESEARCHER_AGENT_ID,
  model: FREEBUFF_GPT_6_LUNA_MODEL_ID,
  reasoningOptions: { enabled: true, effort: 'medium' },
}

export default definition
