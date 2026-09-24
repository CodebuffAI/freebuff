import z from 'zod/v4'

import { FileChangeSchema } from '../actions'
import { addMessageParams } from './params/tool/add-message'
import { addSubgoalParams } from './params/tool/add-subgoal'
import { applyPatchParams } from './params/tool/apply-patch'
import { askUserParams } from './params/tool/ask-user'
import { browserLogsParams } from './params/tool/browser-logs'
import { codeSearchParams } from './params/tool/code-search'
import { cloudPlanReadyParams } from './params/tool/cloud-plan-ready'
import { composioMetaToolParams } from './params/tool/composio'
import { createPlanParams } from './params/tool/create-plan'
import { endTurnParams } from './params/tool/end-turn'
import { findFilesParams } from './params/tool/find-files'
import { globParams } from './params/tool/glob'
import { gravityIndexParams } from './params/tool/gravity-index'
import { listDirectoryParams } from './params/tool/list-directory'
import { lookupAgentInfoParams } from './params/tool/lookup-agent-info'
import { proposeStrReplaceParams } from './params/tool/propose-str-replace'
import { proposeWriteFileParams } from './params/tool/propose-write-file'
import { readDocsParams } from './params/tool/read-docs'
import { readFilesParams } from './params/tool/read-files'
import { readSubtreeParams } from './params/tool/read-subtree'
import { readUrlParams } from './params/tool/read-url'
import { renderUIParams } from './params/tool/render-ui'
import { reportProjectProfileParams } from './params/tool/report-project-profile'
import { runFileChangeHooksParams } from './params/tool/run-file-change-hooks'
import { runTerminalCommandParams } from './params/tool/run-terminal-command'
import { setMessagesParams } from './params/tool/set-messages'
import { setOutputParams } from './params/tool/set-output'
import { skillParams } from './params/tool/skill'
import { spawnAgentInlineParams } from './params/tool/spawn-agent-inline'
import { spawnAgentsParams } from './params/tool/spawn-agents'
import { strReplaceParams } from './params/tool/str-replace'
import { suggestFollowupsParams } from './params/tool/suggest-followups'
import { taskCompletedParams } from './params/tool/task-completed'
import { thinkDeeplyParams } from './params/tool/think-deeply'
import { updateSubgoalParams } from './params/tool/update-subgoal'
import { webSearchParams } from './params/tool/web-search'
import { writeFileParams } from './params/tool/write-file'
import { writeTodosParams } from './params/tool/write-todos'

import type { $ToolParams, PublishedToolName, ToolName } from './constants'
import type { ToolMessage } from '../types/messages/codebuff-message'
import type { ToolCallPart } from '../types/messages/content-part'

export const toolParams = {
  add_message: addMessageParams,
  add_subgoal: addSubgoalParams,
  apply_patch: applyPatchParams,
  ask_user: askUserParams,
  browser_logs: browserLogsParams,
  code_search: codeSearchParams,
  cloud_plan_ready: cloudPlanReadyParams,
  create_plan: createPlanParams,
  end_turn: endTurnParams,
  find_files: findFilesParams,
  glob: globParams,
  gravity_index: gravityIndexParams,
  list_directory: listDirectoryParams,
  lookup_agent_info: lookupAgentInfoParams,
  propose_str_replace: proposeStrReplaceParams,
  propose_write_file: proposeWriteFileParams,
  read_docs: readDocsParams,
  read_files: readFilesParams,
  read_subtree: readSubtreeParams,
  read_url: readUrlParams,
  render_ui: renderUIParams,
  report_project_profile: reportProjectProfileParams,
  run_file_change_hooks: runFileChangeHooksParams,
  run_terminal_command: runTerminalCommandParams,
  set_messages: setMessagesParams,
  set_output: setOutputParams,
  skill: skillParams,
  spawn_agents: spawnAgentsParams,
  spawn_agent_inline: spawnAgentInlineParams,
  str_replace: strReplaceParams,
  suggest_followups: suggestFollowupsParams,
  task_completed: taskCompletedParams,
  think_deeply: thinkDeeplyParams,
  update_subgoal: updateSubgoalParams,
  web_search: webSearchParams,
  write_file: writeFileParams,
  write_todos: writeTodosParams,
  ...composioMetaToolParams,
} satisfies {
  [K in ToolName]: $ToolParams<K>
}

// Tool call from LLM after parsing
export type CodebuffToolCall<T extends ToolName = ToolName> = {
  [K in ToolName]: {
    toolName: K
    input: z.infer<(typeof toolParams)[K]['inputSchema']>
  } & Omit<ToolCallPart, 'type'>
}[T]

export type CodebuffToolOutput<T extends ToolName = ToolName> = {
  [K in ToolName]: K extends ToolName
    ? z.infer<(typeof toolParams)[K]['outputSchema']>
    : never
}[T]

export type CodebuffToolMessage<T extends ToolName = ToolName> = ToolMessage & {
  content: CodebuffToolOutput<T>
}

// Tool call to send to client
export const clientToolCallSchema = z.discriminatedUnion('toolName', [
  z.object({
    toolName: z.literal('apply_patch'),
    input: toolParams.apply_patch.inputSchema,
  }),
  z.object({
    toolName: z.literal('ask_user'),
    input: toolParams.ask_user.inputSchema,
  }),
  z.object({
    toolName: z.literal('browser_logs'),
    input: toolParams.browser_logs.inputSchema,
  }),
  z.object({
    toolName: z.literal('code_search'),
    input: toolParams.code_search.inputSchema,
  }),
  z.object({
    toolName: z.literal('create_plan'),
    input: FileChangeSchema,
  }),
  z.object({
    toolName: z.literal('glob'),
    input: toolParams.glob.inputSchema,
  }),
  z.object({
    toolName: z.literal('list_directory'),
    input: toolParams.list_directory.inputSchema,
  }),
  z.object({
    toolName: z.literal('run_file_change_hooks'),
    input: toolParams.run_file_change_hooks.inputSchema,
  }),
  z.object({
    toolName: z.literal('read_url'),
    input: toolParams.read_url.inputSchema,
  }),
  z.object({
    toolName: z.literal('run_terminal_command'),
    input: toolParams.run_terminal_command.inputSchema.and(
      z.object({ mode: z.enum(['assistant', 'user']) }),
    ),
  }),
  z.object({
    toolName: z.literal('str_replace'),
    input: FileChangeSchema,
  }),
  z.object({
    toolName: z.literal('write_file'),
    input: FileChangeSchema,
  }),
  z.object({
    toolName: z.literal('composio_manage_connections'),
    input: toolParams.composio_manage_connections.inputSchema,
  }),
  z.object({
    toolName: z.literal('composio_multi_execute_tool'),
    input: toolParams.composio_multi_execute_tool.inputSchema,
  }),
  z.object({
    toolName: z.literal('composio_search_tools'),
    input: toolParams.composio_search_tools.inputSchema,
  }),
  z.object({
    toolName: z.literal('composio_get_tool_schemas'),
    input: toolParams.composio_get_tool_schemas.inputSchema,
  }),
])
export const clientToolNames = clientToolCallSchema.def.options.map(
  (opt) => opt.shape.toolName.value,
) satisfies ToolName[]
export type ClientToolName = (typeof clientToolNames)[number]

export type ClientToolCall<T extends ClientToolName = ClientToolName> = Extract<
  z.infer<typeof clientToolCallSchema>,
  { toolName: T }
> &
  Pick<ToolCallPart, 'toolCallId' | 'toolName' | 'input' | 'providerOptions'>

export type PublishedClientToolName = Extract<ClientToolName, PublishedToolName>
