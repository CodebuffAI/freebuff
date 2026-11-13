import { compiledFreebuffModelIdOfRow } from '@codebuff/common/util/freebuff-catalog-compiled-model'

import { getFreebuffModelDirectory } from '../state/freebuff-catalog-store'
import { getSelectedFreebuffModel } from '../state/freebuff-model-store'
import { getCodebuffClient } from '../utils/codebuff-client'
import { extractSpawnAgentResultContent } from '../utils/message-block-helpers'

import type { AgentDefinition, ResolvedByokConnection, RunState } from '@codebuff/sdk'

export const BTW_USAGE = 'Usage: /btw <question>'

/**
 * `/btw` is Claude Code's side question: one answer that sees the conversation,
 * takes no actions, and never becomes part of the history. The constraints are
 * in the system prompt because the agent has no tools to enforce them.
 */
const SIDE_QUESTION_SYSTEM_PROMPT = [
  'You are answering a side question the user asked in the middle of a task.',
  'Answer directly in a single response, using only what this conversation already shows.',
  'You have no tools: do not read files, run commands, search, or change anything, and never promise to try, check, or look something up.',
  'When the conversation does not contain the answer, say what is missing.',
].join('\n')

/**
 * The model the current selection runs, in the form an inline agent may name:
 * a catalog row runs the server-side handle, which only its own root admits, so
 * a plain definition has to name the compiled model id underneath it.
 */
function sideQuestionAgent(): AgentDefinition {
  const selection = getSelectedFreebuffModel()
  const row = getFreebuffModelDirectory().row(selection)
  const model =
    row?.key === selection ? compiledFreebuffModelIdOfRow(row) : selection
  return {
    id: 'freebuff-side-question',
    displayName: 'Side question',
    model: model as AgentDefinition['model'],
    systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
    toolNames: [],
  }
}

/**
 * Runs the question against `previousRun` and returns the answer. The returned
 * run state is dropped: forking from the session means the answer is not
 * appended to the conversation the main agent keeps working in.
 */
export async function askSideQuestion({
  question,
  previousRun,
  byok,
  getClient = getCodebuffClient,
}: {
  question: string
  previousRun: RunState
  /** The BYOK connection the session runs on, if the user selected one. */
  byok?: ResolvedByokConnection
  getClient?: typeof getCodebuffClient
}): Promise<string> {
  const client = await getClient({ ...(byok ? { byok } : {}) })
  if (!client) {
    throw new Error('Not logged in. Run /login first.')
  }

  const state = await client.run({
    agent: sideQuestionAgent(),
    prompt: question,
    previousRun,
    // One model call and no tool round trip.
    maxAgentSteps: 1,
    // BYOK skips the free-mode admission path, same as a normal send.
    costMode: byok ? 'normal' : 'free',
  })

  if (state.output.type === 'error') {
    throw new Error(state.output.message)
  }
  const { content, hasError } = extractSpawnAgentResultContent(state.output)
  const answer = content.trim()
  if (hasError || !answer) {
    throw new Error('No answer came back.')
  }
  return answer
}
