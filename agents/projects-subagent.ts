import {
  FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS,
  FREEBUFF_PROJECTS_SUBAGENT_ID,
} from '@codebuff/common/constants/free-agents'

import { publisher } from './constants'

import type { SecretAgentDefinition } from './types/secret-agent-definition'

/**
 * The subagent a Freebuff Projects account's threads may spawn (the
 * Projects allowlist only; the completions route refuses the id for anyone
 * else). Unlike fast mode's worker it is a full agent: it has the root's
 * coding tools, terminal included, and may spawn more of itself, so a thread
 * can fan out as wide and as deep as the work calls for.
 *
 * It runs the root's model with `inheritParentSystemPrompt` and
 * `includeMessageHistory`, like the fast-mode worker (agents/base3-fast.ts):
 * the request is the root's prefix plus the assignment, a prompt-cache hit on
 * a prefix-cached provider, and the session gate accepts it because the model
 * is the session's own.
 *
 * At most FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS run at once under one root
 * (the agent runtime's spawn_agents handler), and every spawn_agents call is
 * held to MAX_SPAWN_AGENTS_PER_CALL. Every agent also has its step budget, and
 * the server refuses a run more than MAX_ANCESTOR_RUN_IDS (32) levels deep
 * (web/src/app/api/v1/agent-runs/_post.ts).
 */
export function createProjectsSubagent(options: {
  model: SecretAgentDefinition['model']
  /** The tools the subagent may run: the root's own, minus any that address
   *  the human. `spawn_agents` is added here. */
  toolNames: readonly string[]
  /** Other agents it may spawn besides itself (they must be in the run's
   *  agent definitions). */
  extraSpawnableAgents?: readonly string[]
}): SecretAgentDefinition {
  return {
    id: FREEBUFF_PROJECTS_SUBAGENT_ID,
    publisher,
    model: options.model,
    displayName: 'Buffy Subagent',
    spawnerPrompt:
      `A full coding agent that takes one piece of the current task and works it to the end in parallel with any siblings: it reads, edits, runs commands and tests, and can spawn subagents of its own. It sees this whole conversation and inherits your system prompt, so brief it rather than re-explaining. At most ${FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS} may run at once in a session. Its last message is its report.`,
    inputSchema: {
      prompt: {
        type: 'string',
        description:
          'The assignment: what this subagent owns (files, area, question), what it must not touch because a sibling owns it, and what to report back. Brief: it already has the context above.',
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: true,
    windowedFileReads: true,
    toolNames: Array.from(
      new Set([...options.toolNames, 'spawn_agents']),
    ) as SecretAgentDefinition['toolNames'],
    spawnableAgents: Array.from(
      new Set([
        FREEBUFF_PROJECTS_SUBAGENT_ID,
        ...(options.extraSpawnableAgents ?? []),
      ]),
    ),
    instructionsPrompt: `You are a SUBAGENT spawned by the agent whose conversation appears above, possibly one of several running in parallel. The plan to spawn you has already happened: you are that spawn.

- Do your assignment and only that. Stay inside what it says you own; if the work needs a change a sibling owns, leave it and say so in your report.
- Do not re-explore what the conversation above already established.
- If your piece itself splits into independent parts, you may spawn subagents of your own for them, in one spawn_agents call.
- Verify what you changed when the assignment calls for it. Never commit, push or open a PR unless the assignment says to.
- Your last message is your report: what you did, every file you changed, and anything left undone or worth checking, in a few sentences.`,
  }
}
