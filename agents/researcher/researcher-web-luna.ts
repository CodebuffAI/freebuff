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

When an answer depends on current or external information that needs more than one lookup (library versions and APIs, release notes, unfamiliar error messages, pricing, service docs), spawn the researcher-web agent with a focused question. It searches, reads the source pages and reports back with the URLs it read. Spawn several in parallel only for independent questions, usually one to three per request, and don't respawn one to re-check what it already reported. For a single quick lookup, call web_search or read_url yourself. Don't research what you already know well or what the codebase itself answers. Cite the source URLs to the user when they matter.`

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
