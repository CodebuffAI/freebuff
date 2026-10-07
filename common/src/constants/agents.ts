import type { AgentTemplateTypes } from '../types/session-state'

// Define agent personas with their shared characteristics
export const AGENT_PERSONAS = {
  // Base agents - all use Buffy persona
  base: {
    displayName: 'Buffy the Base Agent',
    purpose: 'Base agent that orchestrates the full response.',
  } as const,

  // Ask mode
  ask: {
    displayName: 'Ask Mode Agent',
    purpose: 'Base ask-mode agent that orchestrates the full response.',
  } as const,

  // Specialized agents
  thinker: {
    displayName: 'Theo the Theorizer',
    purpose:
      'Does deep thinking given the current messages and a specific prompt to focus on. Use this to help you solve a specific problem.',
  } as const,
  'file-explorer': {
    displayName: 'Dora The File Explorer',
    purpose: 'Expert at exploring a codebase and finding relevant files.',
  } as const,
  'file-picker': {
    displayName: 'Fletcher the File Fetcher',
    purpose: 'Expert at finding relevant files in a codebase.',
  } as const,
  researcher: {
    displayName: 'Reid Searcher the Researcher',
    purpose: 'Expert at researching topics using web search and documentation.',
  } as const,
  planner: {
    displayName: 'Peter Plan',
    purpose: 'Agent that formulates a comprehensive plan to a prompt.',
    hidden: true,
  } as const,
  reviewer: {
    displayName: 'Nit Pick Nick the Reviewer',
    purpose:
      'Reviews file changes and responds with critical feedback. Use this after making any significant change to the codebase; otherwise, no need to use this agent for minor changes since it takes a second.',
  } as const,
  'agent-builder': {
    displayName: 'Bob the Agent Builder',
    purpose: 'Creates new agent templates for the codebuff multi-agent system',
    hidden: false,
  } as const,
} as const satisfies Partial<
  Record<
    (typeof AgentTemplateTypes)[keyof typeof AgentTemplateTypes],
    { displayName: string; purpose: string; hidden?: boolean }
  >
>

// Agent IDs list from AGENT_PERSONAS keys
export const AGENT_IDS = Object.keys(
  AGENT_PERSONAS,
) as (keyof typeof AGENT_PERSONAS)[]

// Agent ID prefix constant
export const AGENT_ID_PREFIX = 'CodebuffAI/'

// Agent names for client-side reference
export const AGENT_NAMES = Object.fromEntries(
  Object.entries(AGENT_PERSONAS).map(([agentType, persona]) => [
    agentType,
    persona.displayName,
  ]),
) as Record<keyof typeof AGENT_PERSONAS, string>

export type AgentName =
  (typeof AGENT_PERSONAS)[keyof typeof AGENT_PERSONAS]['displayName']

// Get unique agent names for UI display
export const UNIQUE_AGENT_NAMES = Array.from(
  new Set(
    Object.values(AGENT_PERSONAS)
      .filter((persona) => !('hidden' in persona) || !persona.hidden)
      .map((persona) => persona.displayName),
  ),
)

// Map from display name back to agent types (for parsing user input)
export const AGENT_NAME_TO_TYPES = Object.entries(AGENT_NAMES).reduce(
  (acc, [type, name]) => {
    if (!acc[name]) acc[name] = []
    acc[name].push(type)
    return acc
  },
  {} as Record<string, string[]>,
)

export const MAX_AGENT_STEPS_DEFAULT = 200

// Programmatic tool calls can persist additional rows without consuming the
// LLM-call budget, so keep the transport limit separate and safely bounded.
export const MAX_AGENT_STEP_ROWS = 1_000

/**
 * Sent by the SDK on every agent-registry GET to say it applies the publisher
 * trust gate (`sdk/src/agent-publisher-trust.ts`) to what comes back. The
 * registry serves an untrusted publisher's `handleSteps` only to a request
 * carrying it: clients released before the gate `eval` that source with no
 * check, and they cannot send a header they never knew about.
 */
export const AGENT_TRUST_GATE_HEADER = 'x-codebuff-agent-trust-gate'
export const AGENT_TRUST_GATE_HEADER_VALUE = '1'
