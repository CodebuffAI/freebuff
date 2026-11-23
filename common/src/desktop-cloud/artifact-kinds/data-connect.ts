/**
 * Connected datasets: a dataset whose rows come from one of the OWNER's connected apps
 * (Gmail, Linear, PostHog… through Freebuff integrations), pulled again on Refresh by the server.
 *
 * This file holds the stored shapes and the trust rules for them, with nothing but zod imported
 * (data.ts builds its schema from it). Mapping a result into rows and filling blanks live in
 * data-connect-run.ts; the server route in web/src/server/desktop-cloud/artifact-data-refresh.ts.
 *
 * A connected recipe (`refresh.how` of kind "integration") is:
 *  - `app`: the integration's slug ("linear"), for display and to check the call belongs to it;
 *  - `calls`: 1-4 READ-ONLY integration tool calls ({tool, arguments, account?}). The server runs
 *    them as the owner with read-only tools only; a tool that can change anything is refused.
 *    `{{id}}` blanks (a filter or parameter id) may appear in string argument values: plain text
 *    only, as in a command recipe;
 *  - `map`: how a call's result becomes rows, declaratively: `records`, the path to the list of
 *    records in each call's data, and `columns`, a path per dataset column (types come from the
 *    dataset's columns and values are coerced to them). No code.
 *
 * Who may run it is decided by these owner-only options on `refresh` (the existing rule: only the
 * owner changes `refresh`, data-trust.ts):
 *  - `approved`: the owner's approval of exactly this recipe and these options (the schedule
 *    included). Stamped only by `normaliseRecipeApproval` on an owner's own (non-agent) SAVE, and
 *    marked `via: APPROVAL_VIA` there: a stamp without the marker (written before the store
 *    enforced these rules, or forged) never counts. An agent's write of a connected recipe leaves
 *    it unapproved ("pending"), so it cannot run until the owner approves it in the app; a new
 *    artifact (a copy, a template's use) starts pending; a restore keeps only the stamp already
 *    stored. Any later change to the recipe or options leaves the stamp stale (untrusted).
 *  - `collaboratorsCanRefresh`: editors may press Refresh (it still runs as the owner). Off by default.
 *  - `onOpen`: refresh when the dashboard is opened, at most once per staleness window.
 *  - `schedule`: a scheduled refresh ({every, at?}). Recorded only: nothing runs it yet.
 */

import { z } from 'zod/v4'

export const INTEGRATION_RECIPE_MAX_CALLS = 4
/** The most JSON text a call's arguments may take. */
export const INTEGRATION_ARGS_MAX_CHARS = 4000
export const INTEGRATION_PATH_MAX_CHARS = 200
const PATH_MAX_SEGMENTS = 16
/** Mirrors data.ts MAX_COLUMNS and MAX_ROWS_PER_DATASET (data.ts imports this file, not the reverse). */
const MAX_COLUMNS = 40
export const INTEGRATION_MAX_ROWS = 2000

const TOOL_SLUG = /^[A-Z0-9][A-Z0-9_]{1,119}$/
const APP_SLUG = /^[a-z0-9][a-z0-9_]{0,63}$/
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/
const BLANK = /\{\{([A-Za-z0-9_-]+)\}\}/g
const columnKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'use letters, digits, "-" or "_"')

/** Path segments that would reach an object's prototype: never read. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
/** Read from the call, not its data: the account's handle, the tool, the record's position. */
export const SPECIAL_PATHS = ['$account', '$tool', '$index'] as const

/**
 * A path into a JSON value, as segments: `data.items`, `fields.Name`, `labels[0]`, `[2].id`;
 * the empty path is the value itself. Null when it is not a valid path.
 */
export function pathSegments(path: string): Array<string | number> | null {
  if (path.length > INTEGRATION_PATH_MAX_CHARS) return null
  if (path === '') return []
  const out: Array<string | number> = []
  const re = /\[(\d{1,5})\]|(?:^|\.)([A-Za-z0-9_$@-]+)/y
  let at = 0
  while (at < path.length) {
    re.lastIndex = at
    const match = re.exec(path)
    if (!match || match.index !== at) return null
    if (match[1] !== undefined) out.push(Number(match[1]))
    else {
      // A name after the start needs its dot; "a..b" and a leading "." fail the sticky match.
      if (at > 0 && path[at] !== '.') return null
      if (at === 0 && path[0] === '.') return null
      const name = match[2]!
      if (FORBIDDEN_SEGMENTS.has(name)) return null
      out.push(name)
    }
    at = re.lastIndex
    if (out.length > PATH_MAX_SEGMENTS) return null
  }
  return out
}

const pathSchema = z
  .string()
  .max(INTEGRATION_PATH_MAX_CHARS)
  .refine((path) => pathSegments(path) !== null, 'a path like data.items, fields.name or labels[0]')

const columnPathSchema = z
  .string()
  .max(INTEGRATION_PATH_MAX_CHARS)
  .refine(
    (path) => (SPECIAL_PATHS as readonly string[]).includes(path) || (path !== '' && pathSegments(path) !== null),
    'a path like fields.name, or $account, $tool or $index',
  )

/** One column of the mapped rows: which dataset column, read from where in each record. */
export const integrationMapColumnSchema = z
  .object({
    key: columnKey,
    path: columnPathSchema,
    /** Multiplies a number (cents to dollars: 0.01; a ratio to percent: 100). */
    scale: z.number().finite().refine((n) => n !== 0, 'not 0').optional(),
  })
  .strict()

export const integrationMapSchema = z
  .object({
    /** The list of records in each call's data ("" when the data is the list). */
    records: pathSchema,
    columns: z.array(integrationMapColumnSchema).min(1).max(MAX_COLUMNS),
    /** Keep at most this many rows (in order); the dataset's own cap applies anyway. */
    limit: z.number().int().min(1).max(INTEGRATION_MAX_ROWS).optional(),
  })
  .strict()
  .superRefine((map, ctx) => {
    const seen = new Set<string>()
    map.columns.forEach((column, i) => {
      if (seen.has(column.key)) ctx.addIssue({ code: 'custom', path: ['columns', i, 'key'], message: `"${column.key}" is mapped twice` })
      seen.add(column.key)
    })
  })

/** A JSON value small and plain enough to be a tool argument. */
function argumentsProblem(value: unknown, depth = 0): string | null {
  if (depth > 6) return 'arguments nest too deep'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'numbers must be finite'
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = argumentsProblem(item, depth + 1)
      if (problem) return problem
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SEGMENTS.has(key)) return `"${key}" is not an argument name`
      const problem = argumentsProblem(item, depth + 1)
      if (problem) return problem
    }
    return null
  }
  return 'arguments are JSON values'
}

export const integrationCallSchema = z
  .object({
    /** The integration tool's slug, e.g. LINEAR_LIST_ISSUES. */
    tool: z.string().regex(TOOL_SLUG, 'a tool slug like LINEAR_LIST_ISSUES').refine((slug) => !slug.startsWith('COMPOSIO_'), 'not a tool of a connected app'),
    arguments: z
      .record(z.string(), z.unknown())
      .superRefine((args, ctx) => {
        const problem = argumentsProblem(args)
        if (problem) ctx.addIssue({ code: 'custom', message: problem })
        else if (JSON.stringify(args).length > INTEGRATION_ARGS_MAX_CHARS)
          ctx.addIssue({ code: 'custom', message: `at most ${INTEGRATION_ARGS_MAX_CHARS} characters of arguments` })
      }),
    /**
     * The owner's account handle (or opaque id), when the app has several. Never its label: a
     * label can be an email address, and the recipe is shown to everyone who can open it.
     */
    account: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/, "the account's handle (from the app's accounts), not its name or email")
      .optional(),
  })
  .strict()

/** `refresh.how` of kind "integration" (a member of data.ts `recipeHowSchema`). */
export const integrationRecipeSchema = z
  .object({
    kind: z.literal('integration'),
    app: z.string().regex(APP_SLUG, 'an app slug like linear'),
    calls: z.array(integrationCallSchema).min(1).max(INTEGRATION_RECIPE_MAX_CALLS),
    map: integrationMapSchema,
  })
  .strict()

export const datasetScheduleSchema = z
  .object({
    every: z.enum(['hour', 'day', 'week']),
    /** "HH:MM", in UTC, for a daily or weekly refresh. */
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '"HH:MM"').optional(),
  })
  .strict()

/**
 * The marker only the store's enforced write pipeline puts on an approval (`normaliseRecipeApproval`
 * minting on an owner's save). A stamp without it is never trusted to run.
 */
export const APPROVAL_VIA = 2 as const

/** The owner's approval of a connected recipe: who, when, and exactly what (`approvalSubject`). */
export const recipeApprovalSchema = z
  .object({
    by: z.string().min(1).max(120),
    at: z.string().regex(ISO_DATE_TIME, 'an ISO date or date-time'),
    of: z.string().min(1).max(16_000),
    /** `APPROVAL_VIA`: minted by the enforced pipeline. */
    via: z.literal(APPROVAL_VIA).optional(),
  })
  .strict()

/** The connected-source fields of data.ts `datasetRefreshSchema` (all optional, all the owner's). */
export const refreshConnectFields = {
  /** Editors may press Refresh on this dataset (it still runs as the owner). Off by default. */
  collaboratorsCanRefresh: z.boolean().optional(),
  /** Refresh when the dashboard is opened, at most once per staleness window. */
  onOpen: z.boolean().optional(),
  /** A scheduled refresh: recorded, not run yet. */
  schedule: datasetScheduleSchema.optional(),
  /** The owner's approval (stamped by the rules below; anything a writer sends is replaced). */
  approved: recipeApprovalSchema.optional(),
}

export type IntegrationCall = z.infer<typeof integrationCallSchema>
export type IntegrationMap = z.infer<typeof integrationMapSchema>
export type IntegrationMapColumn = z.infer<typeof integrationMapColumnSchema>
export type IntegrationRecipe = z.infer<typeof integrationRecipeSchema>
export type DatasetSchedule = z.infer<typeof datasetScheduleSchema>
export type RecipeApproval = z.infer<typeof recipeApprovalSchema>

/** The parts of a dataset's `refresh` these rules read (structural, so data.ts types fit). */
export type ConnectRefresh = {
  how?: { kind: string } | IntegrationRecipe
  collaboratorsCanRefresh?: boolean
  onOpen?: boolean
  schedule?: DatasetSchedule
  approved?: RecipeApproval
  staleAfterHours?: number
}

export const isIntegrationRecipe = (how: { kind: string } | undefined | null): how is IntegrationRecipe =>
  how?.kind === 'integration'

/** Every string in a recipe's call arguments: where `{{blank}}`s may appear (data.ts checks their ids). */
export function integrationBlankTexts(how: IntegrationRecipe): string[] {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  for (const call of how.calls) walk(call.arguments)
  return out
}

/** The blank ids a connected recipe uses. */
export function integrationBlankIds(how: IntegrationRecipe): string[] {
  const ids = new Set<string>()
  for (const text of integrationBlankTexts(how)) for (const match of text.matchAll(BLANK)) ids.add(match[1]!)
  return [...ids]
}

/** JSON with object keys sorted, so equal values have equal text. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

/**
 * What an approval vouches for: the recipe and the options that decide who runs it and when, as
 * text. The schedule is in it although nothing runs schedules yet: when one does, it must run only
 * the schedule the owner approved, so changing it already invalidates the approval.
 */
export function approvalSubject(refresh: ConnectRefresh): string {
  return canonicalJson({
    how: refresh.how ?? null,
    collaboratorsCanRefresh: refresh.collaboratorsCanRefresh === true,
    onOpen: refresh.onOpen === true,
    schedule: refresh.schedule ?? null,
  })
}

/** A connected recipe's state: not connected, pending the owner's approval, or approved as it stands. */
export function connectedRecipeState(refresh: ConnectRefresh | undefined): 'none' | 'pending' | 'approved' {
  if (!refresh || !isIntegrationRecipe(refresh.how)) return 'none'
  const stamp = refresh.approved
  // The full text, never a hash: a recipe changed in any way after approval is not approved. And
  // only the enforced pipeline's stamp counts (`via`): an older or forged one is pending.
  return stamp && stamp.via === APPROVAL_VIA && stamp.of === approvalSubject(refresh) ? 'approved' : 'pending'
}

/**
 * How a write may treat approvals: `mint` (a save: the owner's own new stamp is stamped), `keep`
 * (a restore: only the stamp already stored survives, so restoring an old version never approves
 * what it carries), `strip` (a new artifact, a copy or a template's use: nothing starts approved,
 * least of all by an account that never saw the recipe).
 */
export type ApprovalMode = 'mint' | 'keep' | 'strip'

export type ApprovalWriter = { owner: boolean; agent: boolean; now: string; approvals?: ApprovalMode }

/**
 * The `refresh` to store, by the approval rules: only the owner's own write (never an agent's,
 * not even theirs) may add or change an approval, and it is stamped here (who, when, exactly
 * what) whatever the writer sent. A recipe that is not connected carries no approval.
 */
export function normaliseRecipeApproval<R extends ConnectRefresh>(
  old: R | undefined,
  next: R | undefined,
  writer: ApprovalWriter,
  person: string,
): R | undefined {
  if (!next) return next
  const { approved, ...rest } = next
  if (!isIntegrationRecipe(next.how)) return approved === undefined ? next : (rest as R)
  if (approved === undefined) return next
  const mode = writer.approvals ?? 'mint'
  if (mode === 'strip') return rest as R
  // The stored stamp, exactly as stored (never given the marker here: a legacy stamp stays legacy).
  const unchanged = old?.approved !== undefined && canonicalJson(approved) === canonicalJson(old.approved)
  if (unchanged) return next
  // A new or changed stamp: the owner approving now, or anyone else's attempt (dropped: pending).
  if (mode === 'keep' || !writer.owner || writer.agent) return rest as R
  return { ...rest, approved: { by: person, at: writer.now, of: approvalSubject(next), via: APPROVAL_VIA } } as R
}

/** The approval stamp a client sends to approve (the store replaces who and when). */
export function approvalRequest(refresh: ConnectRefresh, now: string): RecipeApproval {
  return { by: 'owner', at: now, of: approvalSubject(refresh) }
}

/** Who may press Refresh on a connected dataset: the owner; an editor when the owner allowed it. */
export function mayRefreshConnected(role: string, refresh: ConnectRefresh | undefined): boolean {
  if (role === 'owner') return true
  return role === 'editor' && refresh?.collaboratorsCanRefresh === true
}

/** Hours between refreshes-on-open: the dataset's staleness window, else one hour. */
export function onOpenWindowHours(refresh: ConnectRefresh | undefined): number {
  return refresh?.staleAfterHours ?? 1
}

/**
 * Whether opening the dashboard should refresh this dataset now: the owner asked for it, the
 * recipe is approved, and the rows are older than the window (or were never fetched).
 */
export function refreshOnOpenDue(
  dataset: { refresh?: ConnectRefresh; provenance?: { fetchedAt?: string }; lastRun?: { at: string } },
  now: number,
): boolean {
  const refresh = dataset.refresh
  if (!refresh?.onOpen || connectedRecipeState(refresh) !== 'approved') return false
  const window = onOpenWindowHours(refresh) * 3_600_000
  // A failed attempt counts too: opening a page never retries a broken source in a loop.
  const stamps = [dataset.provenance?.fetchedAt, dataset.lastRun?.at].map((at) => (at ? Date.parse(at) : NaN)).filter(Number.isFinite)
  if (!stamps.length) return true
  return now - Math.max(...stamps) >= window
}

/**
 * The agent's guidance on connected sources (appended to data.ts DATA_GUIDE).
 */
export const DATA_CONNECT_GUIDE = `Connected sources (live data from the owner's connected apps): a dataset's "refresh": {"recipe": "...", "how": {"kind": "integration", "app": "<app slug>", "calls": [{"tool": "<READ-ONLY tool slug>", "arguments": {...}, "account"?: "<handle>"}] (1-${INTEGRATION_RECIPE_MAX_CALLS}), "map": {"records": "<path to the list in each call's data, e.g. issues.nodes>", "columns": [{"key": "<dataset column>", "path": "<path in each record, e.g. state.name; or $account, $tool, $index>", "scale"?: 0.01}], "limit"?: n}}, "collaboratorsCanRefresh"?, "onOpen"?, "schedule"?: {"every": "hour"|"day"|"week", "at"?: "HH:MM"} }. The server runs the calls as the OWNER, read-only tools only, maps the result into the dataset's columns (coerced to their types), checks "expect", and records provenance and the run.
  When the user has the integration connected, prefer a connected source over pasting rows: find a read-only tool with search_integration_tools, check its schema, then write the recipe with setProvenance. A recipe you write is a PROPOSAL: it stays pending (it cannot run) until the owner approves it in the dashboard's Sources panel; tell them to. Never write "approved"; the store stamps it. {{filter}} / {{param}} blanks may appear in string argument values (plain text only).
  To pull a connected dataset again, call refresh_artifact_dataset {id, datasetId}: never fetch and paste its rows yourself. "schedule" is recorded only: nothing runs it yet.`
