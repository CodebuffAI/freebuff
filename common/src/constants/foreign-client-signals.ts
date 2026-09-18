import z from 'zod/v4'

import { toolNames } from '../tools/constants'
import { toolParams } from '../tools/list'

/**
 * Where a free-mode request goes when it did not come from a freebuff client.
 *
 * OpenRouter's `:free` variant, so a downgraded request costs nothing upstream
 * — which is the point. A caller proxying our free endpoint into their own
 * harness is spending our inference budget; serving them a free model spends
 * none of it. `getChatCompletionsProvider` has no branch for this slug and
 * falls through to `openrouter`, so nothing else needs to know about it.
 *
 * Verified against the OpenRouter catalog on 2026-08-08: 262k context, $0
 * prompt and completion, and `tools` + `tool_choice` in supported_parameters —
 * so a downgraded tool-calling request degrades rather than hard-erroring.
 */
export const FREEBUFF_DOWNGRADE_MODEL_ID = 'inclusionai/ling-3.0-tiny:free'

/**
 * Tool names we define that other agent harnesses also ship.
 *
 * Maintained as an EXCLUSION list, with the signature derived from it, because
 * the inclusion list rotted: `researcher-web` offers exactly
 * `['web_search', 'read_url']`, and a hand-picked signature that happened to
 * omit both flagged 100% of its 334,042 requests from 4,821 users over 30 days.
 * Any tool added to `toolNames` now joins the signature automatically, so the
 * failure mode is a new *generic* name we forget to list here — which flags a
 * third party we could already flag, rather than silently downgrading our own
 * users.
 *
 * Each entry carries the third-party usage that justifies it, so this stays
 * evidence rather than superstition.
 */
export const GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Counts are distinct users, over 30 days, on requests carrying NO signature
  // tool at all — i.e. unambiguously third-party harnesses. Anything without
  // that evidence belongs in the signature: excluding a name we define costs us
  // nothing against proxies and risks flagging whichever agent of ours uses it
  // alone, which is exactly how researcher-web broke.
  'write_file', // 3,372 users (Cline)
  'web_search', // 3,273 users (opencode)
  'glob', // 2,691 users (opencode, Claude Code ships `Glob`)
  'skill', // 2,257 users
  'apply_patch', // 1,137 users (Codex)
])

/**
 * Tools our own surfaces define outside `toolNames`, via
 * `customToolDefinitions`. Freebuff Desktop's autorun agent
 * (freebuff-desktop/src/server/services/mission.ts) offers exactly `decide` and
 * nothing else, so without this it had no signature tool at all and was flagged
 * on 100% of its 2,904 requests from 41 users over 30 days.
 */
export const FREEBUFF_CUSTOM_TOOL_NAMES = ['decide'] as const

/**
 * Tool names that, on their own, mark a request as coming from one of our
 * clients: everything we define that is not generic.
 *
 * The discriminator is the tool schema rather than the system prompt because
 * the two are attacker-controlled in very different ways. A system prompt is
 * free to copy — ours ships in the CLI and is recoverable from any response —
 * so a prompt check is a speed bump. Tool schemas are not free to copy: a
 * harness dispatches on the tool name the model returns, so sending ours means
 * also executing ours and speaking our result format. Evading this check
 * converges on behaving like a real client, which is the outcome we want.
 *
 * A NAME alone stopped being enough on 2026-09-17. Every public resale proxy
 * (freebuff2api and its forks, freebuff-proxy, 9router) had adapted to the
 * `some(signature)` rule the same way: append one hollow definition —
 * `end_turn` with an empty schema and a one-line description we never shipped
 * — to whatever toolset the real harness (Claude Code, Codex, Cline, opencode)
 * sent, and let the model never call it. Names are strings; strings are free.
 * So a signature tool now has to be GENUINE — see `isGenuineSignatureTool` —
 * which means carrying the parameter schema we ship under that name.
 */
export const FREEBUFF_SIGNATURE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...(toolNames as readonly string[]).filter(
    (name) => !GENERIC_TOOL_NAMES.has(name),
  ),
  ...FREEBUFF_CUSTOM_TOOL_NAMES,
])

/**
 * Tool names that belong to a harness we do not ship. Offering ANY of them
 * marks the request foreign, whatever else it carries.
 *
 * Why this exists beside the schema rule: the schema rule says "at least one
 * tool must be genuinely ours", which is what lets a CLI user attach MCP tools
 * beside our own. But a proxy that appends our REAL definitions to Claude
 * Code's toolset satisfies it too — and 2026-09-18, the morning after the
 * schema rule shipped, a Discord user was still running Claude Code on the
 * free lane. Nothing we ship offers `Bash` or `AskUserQuestion`; our names
 * are snake_case, MCP tools carry `server__tool`, and agent-as-tool names are
 * lowercase agent ids. So a PascalCase Claude Code core tool, or one of the
 * distinctive Codex / OpenClaw / opencode names below, is a third-party client
 * with no laundering left to do.
 *
 * Evidence rule, same as GENERIC_TOOL_NAMES: every name here was read off
 * DOWNGRADED traffic in Axiom (`freebuff_foreign_client_detected`,
 * `sampleToolNames`) on 2026-09-17/18, and none collides with a name any of
 * our surfaces registers (`toolNames`, `FREEBUFF_CUSTOM_TOOL_NAMES`, Desktop's
 * THREAD_TOOL_SPECS, Web's image/document tools). Generic lowercase names a
 * user's local agent could plausibly take (`clarify`, `question`,
 * `update_plan`, Cline's `read_file` / `search_files` — Web registers a
 * `search_files`) are deliberately NOT here; those harnesses are caught by
 * the schema rule instead.
 */
export const FOREIGN_HARNESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Claude Code core tools (216 users / 2,932 requests in one 6h window)
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'Skill',
  'SlashCommand',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'ToolSearch',
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronUpdate',
  'SendMessage',
  'ListAgents',
  'TaskStop',
  'TaskOutput',
  'Monitor',
  'ScheduleWakeup',
  'DesignSync',
  'Artifact',
  // Cursor
  'AskQuestion',
  'ReadLints',
  'StrReplace',
  'Shell',
  'Delete',
  // Codex
  'exec_command',
  'write_stdin',
  'request_user_input',
  // OpenClaw
  'browser_exec',
  'delegate_task',
  'computer_use',
  // opencode
  'todowrite',
  'todoread',
  'webfetch',
])

/**
 * Phrases a third-party harness writes into its SYSTEM prompt and none of
 * ours ever does. Checked across every system-role message, not only the
 * first: the root-prompt gate already forces our canonical opening to
 * position 0, so a proxy appends the harness prompt after it or as a second
 * system message. Only system-role text is read — a user pasting a Claude
 * Code transcript into a Freebuff chat must never trip this.
 *
 * Claude Code's prompt opens "You are Claude Code, Anthropic's official CLI
 * for Claude" and leaks its billing header (`cc_version=…; cc_entrypoint=…`),
 * both documented in docs/freebuff-abuse-detection.md. A string check is a
 * speed bump on its own — the proxy can strip the sentence — but stripping it
 * costs the harness its identity and instructions, and this layer sits behind
 * the two structural ones.
 */
export const FOREIGN_HARNESS_PROMPT_MARKERS: readonly string[] = [
  'You are Claude Code',
  "Anthropic's official CLI",
  'cc_version=',
  'cc_entrypoint=',
]

export type ForeignClientSignal =
  | 'foreign_toolset'
  | 'foreign_tool_names'
  | 'foreign_system_prompt'
  | 'root_agent_no_tools'
  | 'sampling_params'

export type ForeignClientVerdict = {
  /** Null when the request looks like it came from one of our clients. */
  signal: ForeignClientSignal | null
  toolCount: number
  /** A few offered tool names, for the log line. Bounded so logs stay small. */
  sampleToolNames: string[]
  /**
   * Offered tools that carry one of our signature NAMES but not our schema —
   * the laundering shape. Bounded like `sampleToolNames`. Logged so the next
   * adaptation (a proxy copying a real schema) is visible as a change in what
   * these look like, not only as a drop in the enforcement count.
   */
  hollowToolNames: string[]
  /**
   * Offered names that are neither ours, nor MCP-namespaced (`server__tool`),
   * nor on the foreign-harness list — bounded sample, observe-only. This is
   * the visibility the 2026-09-18 report lacked: a request that clears every
   * enforced rule is not logged anywhere, so the next laundering shape is
   * invisible until a user announces it. Local `.agents/` ids land here too,
   * which is why nothing enforces on it.
   */
  unrecognisedToolNames: string[]
}

type InspectableRequest = {
  tools?: unknown
  messages?: unknown
  temperature?: unknown
  top_p?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
}

/** Longest tool name kept for the log line. Names are caller-controlled, so an
 *  untruncated one is a log-flood vector; nothing legitimate is near this. */
const MAX_LOGGED_TOOL_NAME_LENGTH = 64

type OfferedTool = {
  name: string
  parameters: unknown
  description?: unknown
}

function readOfferedTools(tools: unknown): OfferedTool[] {
  if (!Array.isArray(tools)) return []
  const offered: OfferedTool[] = []
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue
    const fn = (
      tool as {
        function?: {
          name?: unknown
          parameters?: unknown
          description?: unknown
        }
      }
    ).function
    if (typeof fn?.name !== 'string') continue
    offered.push({
      name: fn.name,
      parameters: fn.parameters,
      description: fn.description,
    })
  }
  return offered
}

/**
 * Top-level property names of a JSON-Schema-shaped object, or null when the
 * value is not an object schema at all (absent, a string, an array …).
 *
 * Reads `properties` and, for a top-level union or intersection, the
 * `properties` of every branch — the shape `z.toJSONSchema` produces for the
 * schemas in `toolParams`, and the shape the AI SDK forwards verbatim as
 * `function.parameters` (`@ai-sdk/openai-compatible` `prepareTools`).
 */
function schemaPropertyKeys(schema: unknown): Set<string> | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return null
  }
  const keys = new Set<string>()
  const record = schema as Record<string, unknown>
  const properties = record.properties
  if (typeof properties === 'object' && properties !== null) {
    for (const key of Object.keys(properties)) keys.add(key)
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    const branches = record[combinator]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      for (const key of schemaPropertyKeys(branch) ?? []) keys.add(key)
    }
  }
  return keys
}

/**
 * The top-level parameter names we ship for a tool in `toolParams`, or null
 * for a name we do not define there (custom tools, agent-as-tool names).
 *
 * Computed from the same Zod schema every client serializes onto the wire, so
 * it cannot drift from what our clients send. Top-level names only: the
 * windowed and legacy `read_files` variants differ INSIDE `paths`, and a
 * client one release behind may lack a newly added optional field, so the
 * comparison below is "a subset of ours", never equality. Memoised because
 * `z.toJSONSchema` runs per tool per request otherwise.
 */
const canonicalKeysByTool = new Map<string, ReadonlySet<string> | null>()
export function canonicalToolParameterKeys(
  name: string,
): ReadonlySet<string> | null {
  const cached = canonicalKeysByTool.get(name)
  if (cached !== undefined) return cached
  const params = (toolParams as Record<string, { inputSchema?: unknown }>)[name]
  let keys: ReadonlySet<string> | null = null
  if (params?.inputSchema) {
    try {
      keys = schemaPropertyKeys(
        z.toJSONSchema(params.inputSchema as z.ZodType, { io: 'input' }),
      )
    } catch {
      keys = null
    }
  }
  canonicalKeysByTool.set(name, keys)
  return keys
}

/**
 * Whether an offered tool is one of ours in substance, not only in name.
 *
 * Three cases:
 *
 *  - A custom tool (`FREEBUFF_CUSTOM_TOOL_NAMES`) has no schema in `toolParams`
 *    to check against, so its name is taken at face value, as before.
 *  - A tool we define with parameters is genuine when it carries a NON-EMPTY
 *    schema whose top-level names are a subset of ours. A subset, so a client a
 *    release behind an added optional field still clears; non-empty, so a bare
 *    `{}` under one of our names does not. This is what a renamed foreign tool
 *    fails: Claude Code's `Read` relabelled `read_files` still asks for
 *    `file_path`/`offset`/`limit`, not `paths`.
 *  - A tool we define WITHOUT parameters (`end_turn`, `task_completed`) never
 *    counts. There is nothing structural to verify — a copied name plus `{}`
 *    is byte-identical to the real thing — and the alternative, comparing the
 *    description string, is a check every client one release behind a wording
 *    edit would fail. Every root and subagent we ship carries a parameterised
 *    signature tool as well, and the shipped-agents CI test asserts it.
 */
export function isGenuineSignatureTool(tool: OfferedTool): boolean {
  if (!FREEBUFF_SIGNATURE_TOOL_NAMES.has(tool.name)) return false
  if ((FREEBUFF_CUSTOM_TOOL_NAMES as readonly string[]).includes(tool.name)) {
    return true
  }
  const ours = canonicalToolParameterKeys(tool.name)
  if (!ours || ours.size === 0) return false
  const theirs = schemaPropertyKeys(tool.parameters)
  if (!theirs || theirs.size === 0) return false
  for (const key of theirs) {
    if (!ours.has(key)) return false
  }
  return true
}

/**
 * Whether an offered tool wears one of our signature names without being
 * ours — the laundering shape, for the log line. Never decides anything.
 *
 * For a parameterised tool this is simply "not genuine". For a
 * zero-parameter tool, which `isGenuineSignatureTool` cannot vouch for either
 * way, the DESCRIPTION is compared instead: that is the one field the hollow
 * `end_turn` the proxies inject gets wrong ("Signal the end of the current
 * task." against the paragraph we ship), and because this only feeds a log,
 * a client one release behind a wording edit costs a misleading log line, not
 * a downgrade. Which is exactly why the same comparison is not enforced.
 */
export function isHollowSignatureTool(tool: OfferedTool): boolean {
  if (!FREEBUFF_SIGNATURE_TOOL_NAMES.has(tool.name)) return false
  if ((FREEBUFF_CUSTOM_TOOL_NAMES as readonly string[]).includes(tool.name)) {
    return false
  }
  const ours = canonicalToolParameterKeys(tool.name)
  if (!ours) return false
  if (ours.size > 0) return !isGenuineSignatureTool(tool)
  const shipped = (toolParams as Record<string, { description?: unknown }>)[
    tool.name
  ]?.description
  return (
    typeof shipped !== 'string' ||
    typeof tool.description !== 'string' ||
    tool.description.trim() !== shipped.trim()
  )
}

function systemMessageTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  const texts: string[] = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const { role, content } = message as { role?: unknown; content?: unknown }
    if (role !== 'system') continue
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text =
          typeof part === 'object' && part !== null
            ? (part as { text?: unknown }).text
            : undefined
        if (typeof text === 'string') texts.push(text)
      }
    }
  }
  return texts
}

/** The first foreign-harness marker found in any system-role message, or
 *  null. Exported for the route's log line. */
export function findForeignHarnessPromptMarker(
  messages: unknown,
): string | null {
  for (const text of systemMessageTexts(messages)) {
    for (const marker of FOREIGN_HARNESS_PROMPT_MARKERS) {
      if (text.includes(marker)) return marker
    }
  }
  return null
}

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...(toolNames as readonly string[]),
  ...FREEBUFF_CUSTOM_TOOL_NAMES,
])

/** Bounded sample of offered names that are neither ours, MCP-namespaced nor
 *  on the harness list. For the route's observe-only line on requests that
 *  CLEAR every enforced rule, which are otherwise never logged. */
export function listUnrecognisedToolNames(tools: unknown): string[] {
  return readOfferedTools(tools)
    .filter((tool) => isUnrecognisedToolName(tool.name))
    .slice(0, 8)
    .map((tool) => tool.name.slice(0, MAX_LOGGED_TOOL_NAME_LENGTH))
}

function isUnrecognisedToolName(name: string): boolean {
  return (
    !KNOWN_TOOL_NAMES.has(name) &&
    !FOREIGN_HARNESS_TOOL_NAMES.has(name) &&
    !name.includes('__')
  )
}

/**
 * Whether a free-mode request came from something other than a freebuff client.
 *
 * Three signals, checked in a deliberate order:
 *
 *  0. The request offers a tool by a name only a third-party harness uses
 *     (`FOREIGN_HARNESS_TOOL_NAMES`), or a system message carries a harness
 *     identity (`FOREIGN_HARNESS_PROMPT_MARKERS`). Either is foreign no
 *     matter what else the request carries — including our own genuine
 *     tools, which is precisely the laundering these two exist to stop.
 *  1. The request offers tools and not one of them is GENUINELY ours — our
 *     name over our parameter schema (`isGenuineSignatureTool`). Measured over
 *     24h of DeepSeek V4 Flash traffic before the schema requirement: 557
 *     users / 75,741 requests; by 2026-09-17 the name-only rule enforced on
 *     ~816 requests/day from 71 users while the resale proxies passed it with
 *     a hollow `end_turn`.
 *  2. The request offers NO tools and the agent is one of our roots, which are
 *     agentic by definition — a caller using a root agent id as a bare
 *     completion endpoint. Reported only; never enforced.
 *  3. The request offers no tools and sets `temperature`, `top_p` or
 *     `max_tokens`. Our clients leave all three unset on 99.2% of requests.
 *     Reported only; never enforced.
 *
 * Signal 1 wins outright when it clears the request, and that ordering is the
 * whole safety story rather than a detail: 16 users in the same window send our
 * toolset *and* set sampling params (2,673 requests). Checking params first, or
 * checking them independently, would downgrade those users. Anyone sending our
 * tools is one of ours no matter what else the body says.
 */
export function detectForeignFreebuffClient(
  body: InspectableRequest,
  /** The resolved agent id, when the caller has it. Root agents are agentic by
   *  definition, so one that offers no tools is not being driven by our client
   *  — see `root_agent_no_tools` below. */
  isRootAgent = false,
): ForeignClientVerdict {
  const offered = readOfferedTools(body.tools)
  const sampleToolNames = offered
    .slice(0, 8)
    .map((tool) => tool.name.slice(0, MAX_LOGGED_TOOL_NAME_LENGTH))
  const unrecognisedToolNames = listUnrecognisedToolNames(body.tools)
  // Our name, not our schema. Empty on every request our clients send and on
  // every unadapted foreign harness; populated exactly by the laundering shape.
  const hollowToolNames = offered
    .filter(isHollowSignatureTool)
    .slice(0, 8)
    .map((tool) => tool.name.slice(0, MAX_LOGGED_TOOL_NAME_LENGTH))

  const evidence = {
    toolCount: offered.length,
    sampleToolNames,
    hollowToolNames,
    unrecognisedToolNames,
  }

  // A harness's own tool name or identity settles it before the signature is
  // consulted: appending our genuine definitions to Claude Code's toolset must
  // not launder it.
  if (offered.some((tool) => FOREIGN_HARNESS_TOOL_NAMES.has(tool.name))) {
    return { signal: 'foreign_tool_names', ...evidence }
  }
  if (findForeignHarnessPromptMarker(body.messages) !== null) {
    return { signal: 'foreign_system_prompt', ...evidence }
  }

  if (offered.length > 0) {
    const hasSignatureTool = offered.some(isGenuineSignatureTool)
    return {
      signal: hasSignatureTool ? null : 'foreign_toolset',
      ...evidence,
    }
  }

  // A ROOT agent that offers no tools at all. Our roots always ship their
  // toolset — the CI guard in foreign-client-shipped-agents.test.ts enforces
  // that — so on its face this is a caller driving one of our root agent ids as
  // a bare completion endpoint.
  //
  // An early hand-sample of 18 such users came back 18-for-18 non-coding
  // automation — Shopee customer-service bots, Solana memecoin traders, RAG
  // rephrasers, benchmark probes. DO NOT cite that as evidence for enforcing.
  // It was drawn from a tail of roughly 5,000 users and the cohort analysis
  // below shows it was not representative: 90% of the accounts the signal names
  // also do real agentic work. An 18-for-18 result from an unrepresentative
  // frame is what a biased sample looks like, not a strong one.
  //
  // REPORTED, NEVER ENFORCED, per the full 30-day backtest. Counting only root
  // agents and excluding the paired
  // assistant-response rows (they carry no tools by design and are half of all
  // rows — miss that and every agent reads ~50% tool-free):
  //
  //   base2-free-deepseek           4.46%  215,777 reqs   2,672 users
  //   base2-free-deepseek-flash     0.296% 103,726 reqs   2,281 users
  //   base2-free                    0.90%      222 reqs      15 users
  //   freebuff-desktop-thread-local 0.018%   2,400 reqs      11 users
  //
  // Only 417 of those users are 100% tool-free — actual bare-completion
  // proxies. The other 3,729 mix tool-free requests into heavy real agentic
  // traffic (bucket at <10% tool-free: 1,658 users over 1.25M requests), and
  // 7,379 of their tool-free requests land INSIDE 999 sessions that also make
  // tool-bearing root calls. Enforcing per-request would swap the model
  // mid-session for real coding runs.
  //
  // Nor does run length separate the two: the longest consecutive tool-free run
  // belongs to the MIXED cohort (11,094) and exceeds the pure proxies' longest
  // (2,153), with 334 mixed users exceeding 50. There is no per-request
  // threshold, so enforcement needs an account-level verdict this function
  // cannot see. Note also that these requests all already reproduce our
  // canonical root system prompt at position 0 — `requestHasFreebuffSystemMarker`
  // rejects root requests that do not — so the prompt is not a discriminator
  // either.
  if (isRootAgent) {
    return { signal: 'root_agent_no_tools', ...evidence }
  }

  // Only reached when no tools were offered at all, so this can never override
  // the carve-out above.
  //
  // `!= null` deliberately, not `!== undefined`: a client that serializes its
  // whole request sends `"temperature": null` rather than omitting the key, and
  // that is unset, not a choice. Treating it as set downgraded every such
  // caller. This matches how the rest of the request path already reads these
  // fields — see `applyOpenRouterDefaultMaxTokens`, which gates on
  // `body.max_tokens != null` for the same reason.
  const setsSamplingParams =
    body.temperature != null ||
    body.top_p != null ||
    body.max_tokens != null ||
    body.max_completion_tokens != null
  return { signal: setsSamplingParams ? 'sampling_params' : null, ...evidence }
}

/** The signals that change what is served. The other two are measurements. */
export const ENFORCED_SIGNALS: ReadonlySet<ForeignClientSignal> =
  new Set<ForeignClientSignal>([
    'foreign_toolset',
    'foreign_tool_names',
    'foreign_system_prompt',
  ])

export type ForeignClientDecision = ForeignClientVerdict & {
  signal: ForeignClientSignal
  /** The model to serve instead, or null to serve what was requested. */
  downgradeTo: string | null
}

/**
 * Detect, then decide whether the signal changes what is served.
 *
 * `foreign_toolset`, `foreign_tool_names` and `foreign_system_prompt`
 * downgrade. Using a third-party client against this
 * endpoint is a terms violation, not a grey area: Freebuff funds free
 * inference with ads that only our own clients render, so a proxied request
 * takes the cost and returns none of the revenue.
 *
 * The other two are reported but never enforced, both because they fire on our
 * own traffic:
 *
 *  - `sampling_params` — 568 requests / 13 users on
 *    `code-reviewer-deepseek-flash` in a 24h sample, plus the CLI's own
 *    free-mode shape, which sends `max_completion_tokens` with no tools. It
 *    now only reports NON-root agents: `root_agent_no_tools` is checked first,
 *    so the 8,884 requests / 395 users this used to cite on
 *    `base2-free-deepseek-flash` classify under that signal instead. Neither
 *    enforces, so the reclassification changes measurement, not behavior.
 *  - `root_agent_no_tools` — 3,729 users who also do real agentic work, 999 of
 *    whose sessions mix it with tool-bearing root calls. See the backtest in
 *    `detectForeignFreebuffClient`. Catching the 417 genuine proxies inside
 *    that population needs an account-level verdict, not a per-request one.
 *
 * They stay as measurements, which is what makes the account-level rule
 * buildable later without guessing at its blast radius.
 */
export function resolveForeignClientDowngrade(params: {
  body: InspectableRequest & { model?: unknown }
  isRootAgent?: boolean
}): ForeignClientDecision | null {
  const { body, isRootAgent = false } = params
  const verdict = detectForeignFreebuffClient(body, isRootAgent)
  if (!verdict.signal) return null

  return {
    ...verdict,
    signal: verdict.signal,
    // Never downgrade something already on the downgrade model: that would be
    // a no-op write that still reads as an enforcement in the logs.
    downgradeTo:
      ENFORCED_SIGNALS.has(verdict.signal) &&
      body.model !== FREEBUFF_DOWNGRADE_MODEL_ID
        ? FREEBUFF_DOWNGRADE_MODEL_ID
        : null,
  }
}
