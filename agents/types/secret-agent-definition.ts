import type { AgentDefinition } from './agent-definition'
import type * as Tools from './tools'
export type { Tools }

export type AllToolNames =
  | Tools.ToolName
  | 'add_subgoal'
  | 'browser_logs'
  | 'create_plan'
  | 'spawn_agent_async'
  | 'spawn_agent_inline'
  | 'update_subgoal'
  | 'wait_for_subagents'

export interface SecretAgentDefinition extends Omit<
  AgentDefinition,
  'toolNames'
> {
  /** Tools this agent can use. */
  toolNames?: AllToolNames[]
}

// ============================================================================
// Placeholders (ported from backend/src/templates/types.ts)
// ============================================================================

const placeholderNames = [
  'AGENT_NAME',
  'AGENTS_PROMPT',
  'CURRENT_DATE',
  'FILE_TREE_PROMPT_SMALL',
  'FILE_TREE_PROMPT',
  'FILE_TREE_PROMPT_LARGE',
  'GIT_CHANGES_PROMPT',
  'INITIAL_AGENT_PROMPT',
  'KNOWLEDGE_FILES_CONTENTS',
  'PROJECT_ROOT',
  'REMAINING_STEPS',
  'SYSTEM_INFO_PROMPT',
  'TOOLS_PROMPT',
  'USER_CWD',
  'USER_INPUT_PROMPT',
] as const

type PlaceholderType<T extends readonly string[]> = {
  [K in T[number]]: `{CODEBUFF_${K}}`
}

export const PLACEHOLDER = Object.fromEntries(
  placeholderNames.map((name) => [name, `{CODEBUFF_${name}}` as const]),
) as PlaceholderType<typeof placeholderNames>
export type PlaceholderValue = (typeof PLACEHOLDER)[keyof typeof PLACEHOLDER]
export const placeholderValues = Object.values(PLACEHOLDER)

// ============================================================================
// Agent Template Types (ported from common/src/types/session-state.ts)
// ============================================================================

export const AgentTemplateTypeList = [
  // Base agents
  'base',
  'base_lite',
  'base_max',
  'base_experimental',
  'claude4_gemini_thinking',
  'superagent',
  'base_agent_builder',

  // Ask mode
  'ask',

  // Planning / Thinking
  'dry_run',
  'thinker',

  // Other agents
  'file_picker',
  'file_explorer',
  'researcher',
  'reviewer',
  'agent_builder',
  'example_programmatic',
] as const

type UnderscoreToDash<S extends string> = S extends `${infer L}_${infer R}`
  ? `${L}-${UnderscoreToDash<R>}`
  : S

export const AgentTemplateTypes = Object.fromEntries(
  AgentTemplateTypeList.map((name) => [name, name.replaceAll('_', '-')]),
) as { [K in (typeof AgentTemplateTypeList)[number]]: UnderscoreToDash<K> }

export type AgentTemplateType =
  | (typeof AgentTemplateTypeList)[number]
  | (string & {})
