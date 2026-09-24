/**
 * The capability vocabulary a sponsored run is granted from, and the
 * classification of every tool into one of them.
 *
 * THIS IS THE DATA HALF ONLY, and it lives here rather than beside the Cloud
 * policy because there is now more than one environment doing the granting
 * (COD-336). `freebuff/web/convex/ads/sponsoredCapabilityPolicy.ts` re-exports
 * every name below under its historical spelling and keeps the Cloud grant and
 * the Cloud-shaped path/branch checks; `./sponsored-local-execution.ts` holds
 * the LOCAL grant. Two grants over one classification is the point: a tool
 * added upstream has to be classified once, and each environment then answers
 * for itself whether that capability is one it hands out.
 *
 * The classification is TOTAL over `toolNames` (common/src/tools/constants.ts)
 * by contract, asserted by `sponsoredCapabilityPolicy.test.ts`. A tool added
 * upstream and not classified here is a FAILING TEST, not a silent denial — a
 * silent denial is safe but invisible, and what rots is the reviewer's belief
 * that this map was ever read.
 *
 * Deliberately dependency-free: it is imported by a Convex module, by the
 * Desktop orchestrator, and by the SDK. The one import is a pure sibling in
 * `common`, so the env-file rule is the same one the read policy uses.
 */

import { isSensitiveEnvFilePath } from '../util/env-file-path'

/**
 * The named authorities a run can hold.
 *
 * Grouped by WHAT GOES WRONG when the group is abused, not by which part of
 * the agent loop the tools belong to — because the grant is a security
 * decision and has to be reviewable as one. Two tools sit in the same
 * capability exactly when denying one and granting the other would be
 * incoherent.
 */
export const SPONSORED_CAPABILITIES = Object.freeze([
  /** Observe the checkout: files, structure, search. */
  'read_workspace',
  /** Edit files through the structured edit tools. */
  'write_workspace',
  /** Drive the agent's own loop: todos, subgoals, output, termination. */
  'agent_control',
  /** Execute or observe programs — a shell, a hook, a preview console. */
  'run_commands',
  /** Reach anything off the sandbox. */
  'network',
  /** Require a person: ask, propose, render. */
  'human_in_loop',
  /** Hand work to another agent or skill. */
  'delegate',
] as const)

export type SponsoredCapability = (typeof SPONSORED_CAPABILITIES)[number]

/** Every tool name in `toolNames`, classified. Total by contract; see above. */
/**
 * FROZEN, like every other table in this file and the grants that read them.
 *
 * `Readonly<...>` is a compile-time claim and nothing else: the object it
 * describes is an ordinary mutable literal at runtime, exported into a Convex
 * module, the Desktop orchestrator and the SDK. A capability map that anything
 * holding a reference can reclassify a tool in is not a policy.
 */
export const SPONSORED_CAPABILITY_BY_TOOL: Readonly<
  Record<string, SponsoredCapability>
> = Object.freeze({
  // read_workspace
  read_files: 'read_workspace',
  read_subtree: 'read_workspace',
  code_search: 'read_workspace',
  glob: 'read_workspace',
  list_directory: 'read_workspace',
  find_files: 'read_workspace',

  // write_workspace
  write_file: 'write_workspace',
  str_replace: 'write_workspace',
  apply_patch: 'write_workspace',

  // agent_control
  end_turn: 'agent_control',
  task_completed: 'agent_control',
  set_output: 'agent_control',
  set_messages: 'agent_control',
  add_message: 'agent_control',
  think_deeply: 'agent_control',
  write_todos: 'agent_control',
  add_subgoal: 'agent_control',
  update_subgoal: 'agent_control',
  create_plan: 'agent_control',
  cloud_plan_ready: 'agent_control',
  // Reports the project's stack to our own profile dashboard (#3943); it
  // reads and writes nothing in the workspace and reaches no third party.
  report_project_profile: 'agent_control',

  // run_commands — anything that executes or watches a program run.
  // `browser_logs` sits here rather than with the read tools because what it
  // reads is the user's RUNNING app, not the checkout.
  run_terminal_command: 'run_commands',
  run_file_change_hooks: 'run_commands',
  browser_logs: 'run_commands',

  // network — grouped by reach, not by trust of the destination. `read_docs`
  // and `lookup_agent_info` hit our own endpoints and are harmless in
  // themselves; they are here because "may this run reach off the sandbox" has
  // to be ONE answer, and a capability that is granted for the safe hosts is a
  // capability a future tool quietly widens.
  read_url: 'network',
  web_search: 'network',
  read_docs: 'network',
  gravity_index: 'network',
  lookup_agent_info: 'network',
  composio_manage_connections: 'network',
  composio_multi_execute_tool: 'network',
  composio_search_tools: 'network',
  composio_get_tool_schemas: 'network',

  // human_in_loop
  ask_user: 'human_in_loop',
  suggest_followups: 'human_in_loop',
  render_ui: 'human_in_loop',
  propose_write_file: 'human_in_loop',
  propose_str_replace: 'human_in_loop',

  // delegate
  spawn_agents: 'delegate',
  spawn_agent_inline: 'delegate',
  skill: 'delegate',
})

/**
 * Own-property lookup, and never `SPONSORED_CAPABILITY_BY_TOOL[toolName]`
 * directly.
 *
 * A plain object literal inherits from `Object.prototype`, so the direct
 * indexing this replaces answered `'__proto__'` with an object, `'toString'`
 * with a function, and `'constructor'` with a constructor — every one of them
 * truthy, so every one of them skipped the `unknown_tool` refusal and fell
 * through to a capability check against a value that is not a capability. A
 * tool name is a string that reaches us from a model's output, so those names
 * are producible.
 */
export function sponsoredCapabilityForTool(
  toolName: string,
): SponsoredCapability | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(
      SPONSORED_CAPABILITY_BY_TOOL,
      toolName,
    )
  ) {
    return undefined
  }
  return SPONSORED_CAPABILITY_BY_TOOL[toolName]
}

export type SponsoredToolDecision =
  | { allowed: true; capability: SponsoredCapability }
  | {
      allowed: false
      code: 'unknown_tool' | 'capability_not_granted'
      capability?: SponsoredCapability
      message: string
    }

/**
 * May a run holding `grant` call this tool?
 *
 * `unknown_tool` IS THE POINT OF THIS FUNCTION. The runtime's own gates do the
 * opposite: `getToolSet` silently drops a name it does not recognise, and an
 * unrecognised name reaching a gate that only knows how to subtract is a name
 * that was never subtracted. Custom tools, MCP tools and anything added
 * upstream all arrive here as strings this map has never seen, and every one
 * of them is refused.
 *
 * The grant is REQUIRED here, with no default. The default used to be the
 * Cloud grant, which is exactly the shape of mistake COD-336 asked to be made
 * impossible: a local caller that forgot the argument would have been answered
 * with Cloud's authority. Each environment's own wrapper supplies its own set.
 */
export function evaluateSponsoredToolCallWithGrant(
  toolName: string,
  grant: ReadonlySet<SponsoredCapability>,
): SponsoredToolDecision {
  const capability = sponsoredCapabilityForTool(toolName)
  if (!capability) {
    return {
      allowed: false,
      code: 'unknown_tool',
      message: `Tool \`${toolName}\` is not available to a sponsored run. Sponsored runs may only use tools this channel explicitly allows.`,
    }
  }
  if (!grant.has(capability)) {
    return {
      allowed: false,
      code: 'capability_not_granted',
      capability,
      message: `Tool \`${toolName}\` needs the \`${capability}\` capability, which sponsored runs are not granted. Work within the files of this worktree.`,
    }
  }
  return { allowed: true, capability }
}

/**
 * The toolset a sponsored run's agent definition should carry, given a grant.
 *
 * An INTERSECTION with the host's own list, never a replacement for it: the
 * sponsored run must be a strict narrowing of what an ordinary run can do, so
 * a tool the host does not have cannot appear here by way of this policy
 * granting its capability.
 *
 * This is the ADVISORY half and must never be the only half: it changes what
 * the model is OFFERED, and a model can emit a call for a tool it was not
 * offered. Pair it with {@link evaluateSponsoredToolCallWithGrant} at the call
 * site.
 */
export function sponsoredToolNamesWithGrant(
  baseToolNames: readonly string[],
  grant: ReadonlySet<SponsoredCapability>,
): string[] {
  return baseToolNames.filter(
    (toolName) => evaluateSponsoredToolCallWithGrant(toolName, grant).allowed,
  )
}

// --------------------------------------------------------- write paths

export type SponsoredPathDecision =
  | { allowed: true; path: string }
  | {
      allowed: false
      code:
        | 'empty'
        | 'traversal'
        | 'outside_workspace'
        | 'git_internals'
        | 'ci_workflow'
        | 'credential_file'
      message: string
    }

/**
 * Collapse `.` segments and duplicate separators, preserving a leading `/`.
 *
 * Deliberately NOT a general path resolver: `..` is refused before this runs,
 * so this can only ever shorten a path within the same directory tree.
 */
function normalisePath(input: string): string {
  const absolute = input.startsWith('/')
  const segments = input
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  return (absolute ? '/' : '') + segments.join('/')
}

/** `.git` as a path segment anywhere, which includes the worktree's gitdir. */
const GIT_SEGMENT = /(^|\/)\.git(\/|$)/

/**
 * Paths whose CONTENT executes somewhere the pull-request diff is not the
 * decision point.
 *
 * WHY EACH CLASS IS REFUSED is in `docs/freebuff-sponsored-local-execution.md`
 * §9, not here. This module ships to the public repository (it is inside
 * `common`, which is one include line in the export manifest), and reasoning
 * that reads as "here is what this list is for and here is what it misses" is
 * more useful to somebody working around it than to anybody reading it.
 */
const CI_PATHS = Object.freeze([
  '.github/workflows/',
  '.github/actions/',
  '.gitlab-ci.yml',
  '.circleci/',
  // Hook directories tracked in the repository, so they arrive with the branch.
  '.husky/',
  '.githooks/',
  // The rest of the CI field. A class, not a list of vendors.
  '.buildkite/',
  '.drone.yml',
  '.travis.yml',
  '.gitea/workflows/',
  'jenkinsfile',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  // Executes on open in the editor, which is again not the diff.
  '.vscode/tasks.json',
])

const CREDENTIAL_BASENAMES: ReadonlySet<string> = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
])

const CREDENTIAL_SUFFIXES = Object.freeze(['.pem', '.key', '.p12', '.pfx'])

/**
 * May this sponsored run write this path?
 *
 * Ordered as: is it a path at all, is it inside the boundary, and only then is
 * it one of the classes refused even inside it. The order decides the message
 * the model reads.
 *
 * THE REASONING IS NOT HERE. Why each class is refused, what a path check
 * cannot see, and how the boundary is shaped on each environment are in
 * `docs/freebuff-sponsored-local-execution.md` §9 — a private file, because
 * `common` is published and that reasoning is worth more to somebody working
 * around this than to anybody maintaining it. Change one and change the other.
 *
 * `..` is refused outright rather than normalised, matching `assertProjectPath`
 * (freebuff/web/src/server/agent-runner/harness.ts): a normaliser is a thing
 * that can be wrong and a rejection is not.
 */
export function evaluateSponsoredWritePath(
  rawPath: unknown,
  policy: { workspaceRoot: string },
): SponsoredPathDecision {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return {
      allowed: false,
      code: 'empty',
      message: 'Sponsored runs must name the file they are writing.',
    }
  }
  const trimmed = rawPath.trim()

  if (trimmed.includes('\0') || trimmed.split('/').includes('..')) {
    return {
      allowed: false,
      code: 'traversal',
      message: `Refusing \`${trimmed}\`: sponsored runs may not use \`..\` to leave their worktree.`,
    }
  }

  // NORMALISED BEFORE ANY MATCHING. The write lands through `path.join`, which
  // collapses `.` and duplicate slashes -- so `./.github/workflows/x.yml` and
  // `.github//workflows/x.yml` both resolve to the path the refusals below are
  // written to catch, while matching the RAW string let them straight through.
  // One character of prefix defeated the CI refusal entirely.
  //
  // `..` is already rejected above, so this only has to drop `.` segments and
  // squeeze separators; it can never resolve upward.
  const path = normalisePath(trimmed)

  // AN UNUSABLE ROOT REFUSES. `''` and `/` both collapse to an empty string
  // here, after which `startsWith(root)` is trivially true for every absolute
  // path and the worktree bound disappears entirely. A policy that cannot say
  // where its boundary is has no boundary, and must deny rather than allow.
  const root = policy.workspaceRoot.replace(/\/+$/, '')
  if (root === '') {
    return {
      allowed: false,
      code: 'outside_workspace',
      message:
        'Refusing the write: this sponsored run has no worktree boundary configured.',
    }
  }

  let relative: string
  if (path.startsWith('/')) {
    if (path !== root && !path.startsWith(`${root}/`)) {
      return {
        allowed: false,
        code: 'outside_workspace',
        message: `Refusing \`${path}\`: a sponsored run may only write inside its own worktree at ${root}.`,
      }
    }
    relative = path.slice(root.length).replace(/^\/+/, '')
  } else {
    relative = path
  }

  const lower = relative.toLowerCase()

  // Tested against the LOWERCASED path, like every other refusal below.
  // Testing the raw string made `.GIT/config` allowed while
  // `.GitHub/workflows/x.yml` was refused -- an asymmetry with no reason
  // behind it, and live on any case-insensitive filesystem.
  if (GIT_SEGMENT.test(lower)) {
    return {
      allowed: false,
      code: 'git_internals',
      message: `Refusing \`${path}\`: git internals are not part of the pull request, so nothing about this change would be reviewed.`,
    }
  }

  if (CI_PATHS.some((prefix) => lower === prefix || lower.startsWith(prefix))) {
    return {
      allowed: false,
      code: 'ci_workflow',
      message: `Refusing \`${path}\`: sponsored runs may not change CI configuration.`,
    }
  }

  // Env templates (`ENV_TEMPLATE_FILE_PATTERNS`) are writable; every other
  // env-family name is a credential file. The rule is `isSensitiveEnvFilePath`,
  // the one the read policy uses, so the two cannot drift. Reasoning: §9.
  if (isSensitiveEnvFilePath(relative)) {
    return {
      allowed: false,
      code: 'credential_file',
      message: `Refusing \`${path}\`: sponsored runs may not write environment files, which hold real values. Declare new variable names with placeholder values in \`.env.example\` instead.`,
    }
  }

  // Either separator, like `isSensitiveEnvFilePath` above: `keys\id_rsa` is
  // `id_rsa` on Windows.
  const basename = lower.split(/[\\/]/).at(-1) ?? lower
  if (
    CREDENTIAL_BASENAMES.has(basename) ||
    CREDENTIAL_SUFFIXES.some((suffix) => basename.endsWith(suffix))
  ) {
    return {
      allowed: false,
      code: 'credential_file',
      message: `Refusing \`${path}\`: sponsored runs may not write credential files.`,
    }
  }

  return { allowed: true, path: relative }
}

