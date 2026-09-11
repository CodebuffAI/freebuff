import { setTreeSitterWasmPath as setCodeMapTreeSitterWasmPath } from '@codebuff/code-map/init-node'
import { setWasmDir as setCodeMapWasmDir } from '@codebuff/code-map/languages'
import { getFileTokenScores as getCodeMapFileTokenScores } from '@codebuff/code-map/parse'

export type * from '@codebuff/common/types/json'
export type * from '@codebuff/common/types/messages/codebuff-message'
export type * from '@codebuff/common/types/messages/data-content'
export type * from '@codebuff/common/types/print-mode'
export type {
  TextPart,
  ImagePart,
} from '@codebuff/common/types/messages/content-part'
export { run, STATE_SNAPSHOT_INTERRUPTION_MESSAGE } from './run'
export { getFiles } from './tools/read-files'
export type { FileFilter, FileFilterResult } from './tools/read-files'
export type {
  CodebuffClientOptions,
  OverrideToolHandlers,
  RunOptions,
  MessageContent,
  TextContent,
  ImageContent,
} from './run'
export type { TraceWriter } from '@codebuff/common/types/contracts/trace'
export { buildUserMessageContent } from '@codebuff/agent-runtime/util/messages'
// Agent type exports
export type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
export type { ToolName } from '@codebuff/common/tools/constants'

export type {
  ClientToolCall,
  ClientToolName,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
export * from './client'
export * from './custom-tool'
export * from './native/ripgrep'
export * from './run-state'
export { ToolHelpers } from './tools'
export * from './constants'

export { getUserInfoFromApiKey } from './impl/database'
export * from './credentials'
export * from './byok'
export { loadLocalAgents } from './agents/load-agents'
export { loadMCPConfig, loadMCPConfigSync } from './agents/load-mcp-config'
export {
  loadSkills,
  loadSkillsSync,
  parseSkillFileContent,
} from './skills/load-skills'
export { formatAvailableSkillsXml } from '@codebuff/common/util/skills'
export type { LoadSkillsOptions } from './skills/load-skills'
export type { SkillDefinition, SkillsMap } from '@codebuff/common/types/skill'
export type {
  LoadedAgents,
  LoadedAgentDefinition,
  LoadLocalAgentsResult,
  AgentValidationError,
} from './agents/load-agents'
export type { MCPFileConfig, LoadedMCPConfig } from './agents/load-mcp-config'

export { validateAgents } from './validate-agents'
export type { ValidationResult, ValidateAgentsOptions } from './validate-agents'

// Free-mode capacity deferral notifications (server-side tier shedding)
export { setFreeModeCapacityDeferralListener } from './impl/model-provider'
export type { FreeModeCapacityDeferral } from './impl/model-provider'

// Error utilities
export {
  isRetryableStatusCode,
  getErrorStatusCode,
  sanitizeErrorMessage,
  RETRYABLE_STATUS_CODES,
  createHttpError,
  createAuthError,
  createForbiddenError,
  createPaymentRequiredError,
  createServerError,
  createNetworkError,
} from './error-utils'
export type { HttpError } from './error-utils'

// Retry configuration constants
export {
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
  RETRY_BACKOFF_MAX_DELAY_MS,
  RECONNECTION_MESSAGE_DURATION_MS,
  RECONNECTION_RETRY_DELAY_MS,
} from './retry-config'

export type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

// Tree-sitter / code-map exports
export function getFileTokenScores(
  ...args: Parameters<typeof getCodeMapFileTokenScores>
): ReturnType<typeof getCodeMapFileTokenScores> {
  return getCodeMapFileTokenScores(...args)
}

export function setWasmDir(dir: string): void {
  setCodeMapWasmDir(dir)
}

export function setTreeSitterWasmPath(wasmPath: string): void {
  setCodeMapTreeSitterWasmPath(wasmPath)
}
export type { FileTokenData, TokenCallerMap } from '@codebuff/code-map'

export {
  getActiveTerminalCommandProcesses,
  runTerminalCommand,
} from './tools/run-terminal-command'
export type {
  ActiveTerminalCommandProcess,
  TerminalCommandBroker,
  TerminalCommandProcess,
  TerminalCommandSpawnRequest,
} from './tools/run-terminal-command'
// Containment for a sponsored run on the user's own machine (COD-336). Exported
// from the SDK rather than kept in Desktop because the CLI needs the same
// boundary, and a second copy of a seatbelt profile is a second thing to be
// wrong about.
export {
  assertSponsoredCommandCwd,
  assertSponsoredReadPath,
  assertSponsoredWritePath,
  createSponsoredCodeSearchBroker,
  createSponsoredTerminalBroker,
  findBubblewrap,
  sponsoredCodeSearchFlagsRefusal,
  sponsoredContainment,
  sponsoredMacProfile,
} from './tools/sponsored-sandbox'
export type { SponsoredSandboxOptions } from './tools/sponsored-sandbox'
export { createSponsoredRootedFileSystem } from './tools/sponsored-rooted-filesystem'
export {
  promptAiSdk,
  promptAiSdkStream,
  promptAiSdkStructured,
} from './impl/llm'
