import { FREEBUFF_BASE3_ASYNC_CHECKS_AGENT_ID } from '@codebuff/common/constants/free-agents'

import { createBase3, createBase3CliRoot } from './base3'
import { publisher } from './constants'

import type { SecretAgentDefinition } from './types/secret-agent-definition'

/**
 * base3-async: base3 working in batches, which hands the checks of a change
 * of eight or more files to one background CHECKS subagent sharing its
 * context (spawn_agent_async, docs/agents-and-tools.md). The subagent inherits
 * the root's system prompt, tools and history byte for byte, so the prompt
 * below describes both roles, and each step's ephemeral reminder
 * (`stepPrompt`, never kept in history) says which one that step plays. Why
 * it is shaped this way: docs/benchmarks/base3-async/README.md.
 */

const guidance = (workerAgentId: string) =>
  `
# Working with a subagent

You can start a subagent with spawn_agent_async. It begins from everything above it (this same conversation, read from the prompt cache), does one task, and when it finishes its whole transcript (every command, edit and result, then its report) joins the conversation as a <subagent_report>. Each step ends with a system reminder saying which role that step plays: the orchestrator, or a subagent. Follow the latest reminder.

## The orchestrator

You own the request from the first message to the final answer and do the work yourself, in batches: finishing quickly matters as much as finishing correctly, and everything above about scope and verification still holds.

1. **Read in two steps.** Your first response is ONE batch of every code_search and glob call you can already think of; your second is ONE read_files call with every file that looks relevant (often 5 to 15). Add a third round only for something specific the first two pointed to.
2. **Write every edit yourself**, all the ones you already know in ONE response. Never hand code or tests to a subagent: on every size of change, delegated work came back less complete and no sooner.
3. **Check in the same response**: end the response with your last edits with the checks. A change of eight or more files gets a CHECKS subagent instead: end that response with ONE spawn_agent_async call, \`agent_type\` "${workerAgentId}", whose task names the files you changed and asks it to run the checks and fix what they find; then call wait_for_subagents until it reports. It is the only task you start: never a placeholder, a confirmation, or a second check of unchanged code.
4. **Finish** as soon as the checks are green, with a final message of a few lines on what changed and how it was verified.

**The checks** are one run_terminal_command that typechecks every package the change touched or that imports what it changed (the repository's root typecheck, when it has one, covers both) and runs the existing test files that cover the changed code, each from inside its package with its exit status echoed (\`cd sdk && bun run typecheck; echo EXIT=$?; bun test src/__tests__/run.test.ts; echo EXIT=$?\`), never piped into head or tail. Whoever runs them fixes what the change broke and re-runs until green, never by weakening a test or adding a suppression; when the tests need setup that two tries have not found, typecheck only and say so.

## A subagent

When your step's reminder says you are a subagent, you run the CHECKS task in the <subagent_task> right above your own work, for the orchestrator: the checks above, in your FIRST response. Read only what the failures point to, edit only where they point, with str_replace, and do nothing else from the user's request. When the checks are green, or you cannot make them green, reply with a short report of each command and its final result and call task_completed in that same response.
`.trim()

/**
 * What the harness adds to a surface's base3 root: its prompt section (after
 * base3's own, never before: the chat-completions gate reads base3's opening
 * at byte 0), the spawn and the wait, task_completed (which the subagent
 * shares through the inherited schema to close its report; the runtime does
 * not make an async team wait for it to end a turn), its one subagent, and the
 * orchestrator's step reminder. The CLI root below and Desktop's thread agent
 * (freebuff-desktop/src/server/harness/thread-agent.ts) both apply it.
 */
export function base3AsyncRoot(
  workerAgentId: string = FREEBUFF_BASE3_ASYNC_CHECKS_AGENT_ID,
) {
  return {
    guidance: guidance(workerAgentId),
    toolNames: [
      'spawn_agent_async',
      'wait_for_subagents',
      'task_completed',
    ] as const,
    spawnableAgents: [workerAgentId],
    stepPrompt: `This step is played by the ORCHESTRATOR. Read in batches and write every edit yourself; end the response with your last edits with the checks: run them yourself, or for a change of eight or more files start ONE CHECKS task with spawn_agent_async and call wait_for_subagents until it reports. Finish once the checks are green.`,
  }
}

/** The orchestrator as a Freebuff CLI root (the CLI's catalog root and the
 *  buffbench arms, which name their own worker). */
export function createBase3AsyncCliRoot(
  model: SecretAgentDefinition['model'],
  options: {
    workerAgentId?: string
  } & Pick<
    NonNullable<Parameters<typeof createBase3CliRoot>[0]>,
    'noAskUser' | 'noWeb' | 'modelLabel' | 'compaction' | 'compiledModelId'
  > = {},
): Omit<SecretAgentDefinition, 'id'> {
  const { workerAgentId, ...rootOptions } = options
  const team = base3AsyncRoot(workerAgentId)
  const root = createBase3CliRoot({
    model,
    isFreebuff: true,
    ...rootOptions,
    extraSystemPrompt: team.guidance,
  })
  return {
    ...root,
    displayName: 'Buffy (async checks)',
    toolNames: [...root.toolNames!, ...team.toolNames],
    spawnableAgents: team.spawnableAgents,
    stepPrompt: team.stepPrompt,
  }
}

/**
 * The CHECKS subagent. No system prompt, tools or compaction of its own: it
 * runs on its parent's, and the runtime executes only its own toolNames
 * (base3's minus the orchestrator's to-do list, plus task_completed),
 * answering anything else with a tool error. `windowedFileReads` is set
 * because the read handlers read the flag off the CHILD's template. It thinks
 * at low effort: running checks and fixing what they report needs little
 * planning, and effort is a request option, so the shared prefix still comes
 * from the cache.
 */
export function createBase3AsyncWorker(
  model: SecretAgentDefinition['model'],
): Omit<SecretAgentDefinition, 'id'> {
  const base3 = createBase3(model)
  return {
    publisher,
    model,
    providerOptions: base3.providerOptions,
    reasoningOptions: { enabled: true, effort: 'low' },
    displayName: 'Buffy Checks',
    spawnerPrompt:
      'Runs the checks of a change in the background from a copy of this conversation, fixes what they find, then reports its whole transcript back',
    inputSchema: {
      prompt: {
        type: 'string',
        description:
          'The CHECKS task: the files the change touched and the packages to typecheck and test',
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: true,
    windowedFileReads: true,
    toolNames: base3
      .toolNames!.filter((name) => name !== 'write_todos')
      .concat('task_completed'),
    spawnableAgents: [],
    stepPrompt: `This step is played by a SUBAGENT, not the orchestrator: do only the CHECKS task in your <subagent_task> above, nothing else from the user's request. When the checks are green, or you cannot make them green, reply with your short report and call task_completed in the same response.`,
  }
}
