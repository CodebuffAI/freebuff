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
import { basename, resolve, sep as sep_default } from 'path'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { ToolName } from '@codebuff/common/tools/constants'

/**
 * Resolves a path through symlinks. Must match the filesystem the run actually
 * uses: the default `fs.promises.realpath` only tells the truth about the real
 * host filesystem, so a run with an injected adapter needs its own canonicalizer
 * (see {@link createExecutionPolicy}).
 */
export type PathCanonicalizer = (path: string) => Promise<string>

/** True for the exact Node default adapter; anything else may be a virtual fs. */
function isNodeFileSystem(fs: CodebuffFileSystem): boolean {
  return fs === (nodeFs as unknown as CodebuffFileSystem)
}

/** `realpath` failures that legitimately mean "the path does not exist yet". */
function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

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
  /**
   * Canonicalizer used to resolve symlinks for filesystem confinement. Must be
   * compatible with the run's filesystem adapter: a custom adapter that does not
   * share the host `realpath` requires its own canonicalizer, or strict
   * confinement (`--project-only`) is refused.
   */
  readonly canonicalize?: PathCanonicalizer
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
  canonicalize?: PathCanonicalizer
}): ExecutionPolicy {
  return Object.freeze({
    noShell: input.noShell ?? false,
    askShell: input.askShell ?? false,
    projectOnly: input.projectOnly ?? false,
    readOnly: input.readOnly ?? false,
    projectRoot: resolve(input.projectRoot),
    allowExternalTools: input.allowExternalTools ?? false,
    ...(input.shellApproval ? { shellApproval: input.shellApproval } : {}),
    ...(input.canonicalize ? { canonicalize: input.canonicalize } : {}),
  })
}

/**
 * Explicit capability for every SDK built-in in common/src/tools/constants.ts.
 * The ToolName-derived Record makes adding a registered tool without a policy
 * classification a type error. `toolParams` separately checks the runtime
 * registry against the same names in execution-policy.test.ts.
 */
export const BUILT_IN_TOOL_CAPABILITIES = Object.freeze({
  add_message: 'inert',
  add_subgoal: 'inert',
  apply_patch: 'fs-write',
  ask_user: 'inert',
  // This reads the browser session rather than the checkout or shell.
  browser_logs: 'network',
  code_search: 'fs-read',
  cloud_plan_ready: 'inert',
  create_plan: 'inert',
  end_turn: 'inert',
  find_files: 'fs-read',
  glob: 'fs-read',
  gravity_index: 'network',
  list_directory: 'fs-read',
  lookup_agent_info: 'network',
  // Proposals carry writes that a host may later apply; enforce both the
  // read-only and project-root rules before they leave the SDK.
  propose_str_replace: 'fs-write',
  propose_write_file: 'fs-write',
  read_docs: 'network',
  read_files: 'fs-read',
  read_subtree: 'fs-read',
  read_url: 'network',
  render_ui: 'inert',
  report_project_profile: 'inert',
  // Hooks execute client-configured programs outside the SDK's process
  // boundary, so restrictions require explicit host trust.
  run_file_change_hooks: 'external',
  run_terminal_command: 'shell',
  set_messages: 'inert',
  set_output: 'inert',
  skill: 'agent',
  spawn_agents: 'agent',
  spawn_agent_inline: 'agent',
  str_replace: 'fs-write',
  suggest_followups: 'inert',
  task_completed: 'inert',
  think_deeply: 'inert',
  update_subgoal: 'inert',
  web_search: 'network',
  write_file: 'fs-write',
  write_todos: 'inert',
} satisfies Record<ToolName, ToolCapability>)

/**
 * Classify a tool by capability. Unknown names are treated as `external`
 * (denied under strict policies) rather than assumed safe.
 */
export function classifyTool(toolName: string): ToolCapability {
  if (
    Object.prototype.hasOwnProperty.call(BUILT_IN_TOOL_CAPABILITIES, toolName)
  ) {
    return BUILT_IN_TOOL_CAPABILITIES[toolName as ToolName]
  }
  // MCP tools, custom tool definitions, host overrides, and anything
  // unrecognized stay outside the SDK's enforcement boundary.
  return 'external'
}

/**
 * Canonicalize a path through symlinks by resolving the nearest existing
 * ancestor with realpath, then re-appending the not-yet-existing tail. This
 * catches a symlink inside the project that points outside it.
 *
 * Only a genuinely-missing path is walked up to its nearest existing ancestor.
 * Every other `realpath` failure (permission denial, symlink loop, I/O error) is
 * rethrown so callers fail closed rather than treating an unresolvable path as
 * contained.
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
    } catch (error) {
      // ENOTDIR (a non-directory in the path) is as "missing" as ENOENT for our
      // purposes; anything else is unexpected and must not be swallowed.
      if (!isMissingPathError(error)) throw error
      const parent = resolve(current, '..')
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return absolute
      }
      // `basename` is correct at the root boundary: for `/foo` with parent `/`
      // a manual slice would drop the leading character.
      segments.push(basename(current))
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
 *
 * Confinement is only as trustworthy as the canonicalizer. When `--project-only`
 * is active the guard needs a canonicalizer that describes the run's actual
 * filesystem: the policy's `canonicalize`, an explicit `realpath` argument, or
 * the Node default adapter. It refuses strict confinement rather than silently
 * checking a virtual adapter against the host filesystem.
 *
 * This is NOT an OS security boundary. It authorizes and then delegates to the
 * adapter, so a concurrent process can still swap a path (e.g. replace a checked
 * file or directory with a symlink) between the check and the operation. It
 * restricts SDK-managed filesystem operations; it does not defend against
 * external processes mutating the same tree.
 */
export function guardFileSystem(
  fs: CodebuffFileSystem,
  policy: ExecutionPolicy,
  realpath?: PathCanonicalizer,
): CodebuffFileSystem {
  const restricted = policy.projectOnly || policy.readOnly
  if (!restricted) return fs

  const canonicalize = realpath ?? policy.canonicalize
  if (policy.projectOnly && !canonicalize && !isNodeFileSystem(fs)) {
    throw new Error(
      'Strict confinement (--project-only) requires a path canonicalizer compatible with the run filesystem. Provide `canonicalize` for a custom filesystem adapter.',
    )
  }
  // Only consulted when `canonicalize` is absent, which is already guaranteed to
  // be the Node default adapter by the check above.
  const resolveReal: PathCanonicalizer = canonicalize ?? nodeFs.realpath

  const assertReadable = async (target: string) => {
    if (!policy.projectOnly) return
    if (!(await isPathWithinRoot(target, policy.projectRoot, resolveReal))) {
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
    if (!(await isPathWithinRoot(target, policy.projectRoot, resolveReal))) {
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
