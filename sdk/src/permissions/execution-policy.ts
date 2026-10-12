/**
 * Execution Policy
 *
 * Per-run, immutable authorization for tool execution.
 *
 * There is deliberately NO module-global policy state. A global policy is a
 * security defect in an embeddable SDK: two concurrent runs with different
 * restrictions would overwrite each other, so a restricted run could inherit a
 * permissive run's policy. Each run constructs its own policy and captures it
 * in its tool-dispatch closure.
 */

import { promises as nodeFs } from 'fs'
import { resolve, sep as sep_default } from 'path'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

/** What a tool can do, for authorization purposes. */
export type ToolCapability =
  | 'shell'
  | 'fs-read'
  | 'fs-write'
  | 'network'
  | 'agent'
  | 'external'
  | 'inert'

export type ShellApprovalVerdict = 'approve' | 'deny'

export interface ShellApprovalRequest {
  /** Unique id correlating this approval to exactly one command. */
  id: string
  command: string
  cwd: string
  processType: 'SYNC' | 'BACKGROUND'
  signal?: AbortSignal
}

export type ShellApprovalCallback = (
  request: ShellApprovalRequest,
) => Promise<ShellApprovalVerdict>

export interface ExecutionPolicy {
  readonly noShell: boolean
  readonly askShell: boolean
  readonly projectOnly: boolean
  readonly readOnly: boolean
  /** Absolute, canonicalized project root this run is confined to. */
  readonly projectRoot: string
  /**
   * Whether external tools (MCP servers, custom tool definitions, host
   * overrides) may run. Default false: they are outside the SDK's enforcement
   * boundary and must be explicitly trusted by the host.
   */
  readonly allowExternalTools: boolean
  readonly shellApproval?: ShellApprovalCallback
}

export interface PolicyDecision {
  allowed: boolean
  reason?: string
  approvalRequired?: boolean
}

export interface ToolAuthorizationRequest {
  toolName: string
  capability: ToolCapability
  /** Resolved absolute target path, for filesystem tools. */
  targetPath?: string
  /** Shell command details, for the shell capability. */
  command?: string
  cwd?: string
  processType?: 'SYNC' | 'BACKGROUND'
  signal?: AbortSignal
}

/**
 * Build an immutable policy for one run.
 */
export function createExecutionPolicy(input: {
  projectRoot: string
  noShell?: boolean
  askShell?: boolean
  projectOnly?: boolean
  readOnly?: boolean
  allowExternalTools?: boolean
  shellApproval?: ShellApprovalCallback
}): ExecutionPolicy {
  return Object.freeze({
    noShell: input.noShell ?? false,
    askShell: input.askShell ?? false,
    projectOnly: input.projectOnly ?? false,
    readOnly: input.readOnly ?? false,
    projectRoot: resolve(input.projectRoot),
    allowExternalTools: input.allowExternalTools ?? false,
    ...(input.shellApproval ? { shellApproval: input.shellApproval } : {}),
  })
}

/**
 * Classify a tool by capability. Unknown names are treated as `external`
 * (denied under strict policies) rather than assumed safe.
 */
export function classifyTool(toolName: string): ToolCapability {
  switch (toolName) {
    case 'run_terminal_command':
      return 'shell'
    case 'write_file':
    case 'str_replace':
    case 'apply_patch':
      return 'fs-write'
    case 'read_files':
    case 'read_subtree':
    case 'list_directory':
    case 'glob':
    case 'code_search':
      return 'fs-read'
    case 'read_url':
    case 'web_search':
    case 'read_docs':
      return 'network'
    case 'spawn_agents':
    case 'spawn_agent_inline':
      return 'agent'
    case 'think_deeply':
    case 'set_output':
    case 'end_turn':
    case 'add_message':
    case 'ask_user':
    case 'create_plan':
    case 'write_todos':
    case 'suggest_followups':
    case 'task_completed':
    case 'update_subgoal':
    case 'add_subgoal':
    case 'render_ui':
    case 'report_project_profile':
    case 'lookup_agent_info':
    case 'skill':
      return 'inert'
    default:
      // MCP tools, custom tool definitions, and anything unrecognized.
      return 'external'
  }
}

/**
 * Canonicalize a path through symlinks by resolving the nearest existing
 * ancestor with realpath, then re-appending the not-yet-existing tail. This
 * catches a symlink inside the project that points outside it.
 */
export async function canonicalizePath(
  targetPath: string,
  realpath: (p: string) => Promise<string> = nodeFs.realpath,
): Promise<string> {
  const absolute = resolve(targetPath)
  const segments: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = await realpath(current)
      return segments.length === 0 ? real : resolve(real, ...segments.reverse())
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return absolute
      }
      segments.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

/**
 * Symlink-aware containment check: true only when the canonicalized target is
 * the canonicalized root or a descendant of it.
 */
export async function isPathWithinRoot(
  targetPath: string,
  root: string,
  realpath: (p: string) => Promise<string> = nodeFs.realpath,
): Promise<boolean> {
  const [realTarget, realRoot] = await Promise.all([
    canonicalizePath(targetPath, realpath),
    canonicalizePath(root, realpath),
  ])
  return isContainedPath(realTarget, realRoot)
}

/**
 * Platform-correct containment over already-normalized paths.
 *
 * Windows paths are case-insensitive and use backslash separators, so a
 * byte-prefix comparison would wrongly reject `C:\Proj\a.ts` against root
 * `C:\proj` (or wrongly accept a sibling differing only in case). The flags are
 * explicit so the Windows branch is unit-testable on any host.
 */
export function isContainedPath(
  target: string,
  root: string,
  options: { caseInsensitive: boolean; sep: string } = {
    caseInsensitive: process.platform === 'win32',
    sep: process.platform === 'win32' ? '\\' : sep_default,
  },
): boolean {
  const eq = (a: string, b: string) =>
    options.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
  const startsWith = (a: string, b: string) =>
    options.caseInsensitive
      ? a.toLowerCase().startsWith(b.toLowerCase())
      : a.startsWith(b)
  return eq(target, root) || startsWith(target, root + options.sep)
}

/** Lexical containment check (no filesystem access). Used as a fast pre-filter. */
export function isLexicallyWithinRoot(targetPath: string, root: string): boolean {
  return isContainedPath(resolve(targetPath), resolve(root))
}

/**
 * Authorize one tool call against one run's policy. Pure with respect to
 * policy state: everything it needs is passed in. Filesystem containment is
 * lexical here; callers that have a resolved target should additionally await
 * {@link isPathWithinRoot} for symlink safety.
 */
export function authorizeToolCall(
  policy: ExecutionPolicy,
  request: ToolAuthorizationRequest,
): PolicyDecision {
  const { capability } = request

  // External tools (MCP, custom definitions, overrides) are outside the SDK's
  // enforcement boundary. Under any strict policy they are denied unless the
  // host explicitly trusted them.
  if (capability === 'external') {
    const strict =
      policy.noShell || policy.askShell || policy.projectOnly || policy.readOnly
    if (strict && !policy.allowExternalTools) {
      return {
        allowed: false,
        reason: `Tool '${request.toolName}' is an external capability and is not permitted while execution restrictions are active`,
      }
    }
    return { allowed: true }
  }

  if (capability === 'shell') {
    if (policy.noShell) {
      return {
        allowed: false,
        reason: 'Shell command execution is disabled (--no-shell)',
      }
    }
    // read-only and project-only cannot be guaranteed while an unrestricted
    // shell can write anywhere or read anywhere. Deny until real OS-level
    // containment is active.
    if (policy.readOnly) {
      return {
        allowed: false,
        reason:
          'Shell execution is not permitted in read-only mode: an unrestricted shell can modify files outside the SDK’s control',
      }
    }
    if (policy.projectOnly) {
      return {
        allowed: false,
        reason:
          'Shell execution is not permitted in project-only mode: an unrestricted shell can access paths outside the project',
      }
    }
    if (policy.askShell) {
      if (!policy.shellApproval) {
        return {
          allowed: false,
          reason:
            'Shell command requires approval but no approval handler is configured',
          approvalRequired: true,
        }
      }
      return { allowed: false, reason: 'Approval required', approvalRequired: true }
    }
    return { allowed: true }
  }

  if (capability === 'fs-write') {
    if (policy.readOnly) {
      return {
        allowed: false,
        reason: `Write to '${request.targetPath ?? request.toolName}' denied: read-only mode (--read-only)`,
      }
    }
    if (policy.projectOnly && request.targetPath) {
      if (!isLexicallyWithinRoot(request.targetPath, policy.projectRoot)) {
        return {
          allowed: false,
          reason: `Write to '${request.targetPath}' blocked: outside project root '${policy.projectRoot}' (--project-only)`,
        }
      }
    }
    return { allowed: true }
  }

  if (capability === 'fs-read') {
    if (policy.projectOnly && request.targetPath) {
      if (!isLexicallyWithinRoot(request.targetPath, policy.projectRoot)) {
        return {
          allowed: false,
          reason: `Read of '${request.targetPath}' blocked: outside project root '${policy.projectRoot}' (--project-only)`,
        }
      }
    }
    return { allowed: true }
  }

  // network, agent, inert
  return { allowed: true }
}

/**
 * Filesystem adapter wrapper enforcing read/write containment for a run.
 * Defense in depth: even a tool path the dispatcher missed cannot read or
 * write outside the policy's root, and symlink escapes are caught via realpath.
 */
export function guardFileSystem(
  fs: CodebuffFileSystem,
  policy: ExecutionPolicy,
  realpath?: (p: string) => Promise<string>,
): CodebuffFileSystem {
  const restricted = policy.projectOnly || policy.readOnly
  if (!restricted) return fs

  const assertReadable = async (target: string) => {
    if (!policy.projectOnly) return
    if (!(await isPathWithinRoot(target, policy.projectRoot, realpath))) {
      throw new Error(
        `Read of '${target}' blocked: outside project root '${policy.projectRoot}' (--project-only)`,
      )
    }
  }
  const assertWritable = async (target: string) => {
    if (policy.readOnly) {
      throw new Error(`Write to '${target}' denied: read-only mode (--read-only)`)
    }
    if (!policy.projectOnly) return
    if (!(await isPathWithinRoot(target, policy.projectRoot, realpath))) {
      throw new Error(
        `Write to '${target}' blocked: outside project root '${policy.projectRoot}' (--project-only)`,
      )
    }
  }

  const wrapRead = <T extends (...args: any[]) => any>(fn: T): T =>
    (async (target: string, ...rest: unknown[]) => {
      await assertReadable(target)
      return fn(target, ...rest)
    }) as unknown as T
  const wrapWrite = <T extends (...args: any[]) => any>(fn: T): T =>
    (async (target: string, ...rest: unknown[]) => {
      await assertWritable(target)
      return fn(target, ...rest)
    }) as unknown as T

  return new Proxy(fs as object, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver)
      if (typeof value !== 'function') return value
      switch (prop) {
        case 'readFile':
        case 'readdir':
        case 'stat':
        case 'lstat':
        case 'access':
          return wrapRead(value.bind(obj))
        case 'writeFile':
        case 'unlink':
        case 'rm':
        case 'rmdir':
        case 'mkdir':
        case 'appendFile':
        case 'rename':
          return wrapWrite(value.bind(obj))
        default:
          return value.bind(obj)
      }
    },
  }) as CodebuffFileSystem
}
