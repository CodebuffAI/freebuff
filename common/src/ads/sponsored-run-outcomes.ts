/**
 * Verified outcomes of a sponsored run — what the committed diff PROVES the
 * run did, as opposed to what the run said it did (COD-515).
 *
 * Two of the funnel's stages, `api_key_issued` and `mcp_installed`
 * (`../constants/agentic-ad-events.ts`), had a vocabulary and no producer.
 * This module is the producer's decision procedure, and it is deliberately
 * NEVER a model self-report: the sponsored agent is running an advertiser's
 * procedure against a user's repository, and an advertiser's funnel is not
 * something the advertiser's own prompt gets to fill in. A stage is emitted
 * only when BOTH of two independent things are true:
 *
 *   1. The reviewed procedure DECLARED it (`declaredOutcomes`). A procedure
 *      that wires Supabase Auth cannot be credited with installing an MCP
 *      server however the diff reads, and a procedure with no declaration is
 *      credited with nothing.
 *   2. The committed diff — added lines only, on our side, after the commit —
 *      satisfies the outcome's deterministic rule (`verifyOutcomes`).
 *
 * Dependency-free on purpose: it runs in three runtimes (the Next state route,
 * a Convex `'use node'` action against a Daytona worktree, and Desktop against
 * a local worktree) and none of them may pull the others' imports. Nothing here
 * reads a file, runs git, or sees a secret — callers hand it the diff, and it
 * hands back outcome names and file PATHS. Contents never leave the caller.
 *
 * This is a read of the diff after the run, inside our own process; it grants
 * the sponsored agent nothing and changes no refusal in
 * `docs/freebuff-sponsored-local-execution.md`.
 */

export const SPONSORED_RUN_OUTCOMES = [
  'api_key_issued',
  'mcp_installed',
] as const

export type SponsoredRunOutcome = (typeof SPONSORED_RUN_OUTCOMES)[number]

export function isSponsoredRunOutcome(
  value: unknown,
): value is SponsoredRunOutcome {
  return (
    typeof value === 'string' &&
    (SPONSORED_RUN_OUTCOMES as readonly string[]).includes(value)
  )
}

/**
 * The procedure with its declaration, for a caller that has a structured
 * contract in hand. Today no such contract exists anywhere in the repo — the
 * reviewed procedure is one text column (`ad_placement_campaign
 * .sponsored_procedure`), copied verbatim onto the accept response, the
 * proposal row (`compute_procedure`) and the Cloud action's arguments. So the
 * declaration that actually ships rides INSIDE that text, as a directive line
 * (see `SPONSORED_OUTCOMES_DIRECTIVE`), and this shape exists so that a
 * structured contract (COD-446's Supabase Postgres and Auth procedures, when
 * they land) can carry the same list as a field without re-parsing prose.
 */
export type SponsoredProcedureContract = {
  text: string
  /** Explicit declaration. When present it WINS over any directive in `text`. */
  outcomes?: readonly string[] | null
}

/**
 * The directive a procedure declares its outcomes with:
 *
 *     outcomes: api_key_issued, mcp_installed
 *
 * One line, key case-insensitive, names separated by commas or whitespace,
 * unknown names ignored. Placed in the procedure TEXT rather than a new column
 * because the text is the one thing every executor already receives, and
 * because it is what the advertiser writes and we review — a declaration
 * outside the reviewed text could be edited without sending the campaign back
 * to `pending_review`, and this one cannot (`compute_procedure_sha256` covers
 * it). The line reaches the model as part of the prompt, which is harmless: it
 * declares what the funnel MAY credit, and the model cannot make the diff
 * satisfy a rule by having read the rule's name.
 */
export const SPONSORED_OUTCOMES_DIRECTIVE = 'outcomes:'

const DIRECTIVE_LINE = /^\s*outcomes\s*:\s*(.*?)\s*$/i

/**
 * What a procedure declares, in canonical order, deduplicated. Empty when the
 * procedure declares nothing, is absent, or declares only names this module
 * does not know — an unknown name is a typo in advertiser text and must not
 * fail a run, but it must not credit anything either.
 */
export function declaredOutcomes(
  procedure: string | SponsoredProcedureContract | null | undefined,
): SponsoredRunOutcome[] {
  if (procedure === null || procedure === undefined) return []
  if (typeof procedure !== 'string') {
    if (Array.isArray(procedure.outcomes)) {
      return canonical(procedure.outcomes)
    }
    return declaredOutcomes(procedure.text)
  }
  const names: string[] = []
  for (const line of procedure.split(/\r?\n/)) {
    const match = DIRECTIVE_LINE.exec(line)
    if (!match) continue
    names.push(...match[1]!.split(/[\s,]+/))
  }
  return canonical(names)
}

function canonical(names: readonly unknown[]): SponsoredRunOutcome[] {
  const wanted = new Set(
    names.map((name) => (typeof name === 'string' ? name.trim() : '')),
  )
  return SPONSORED_RUN_OUTCOMES.filter((outcome) => wanted.has(outcome))
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** One file of the committed diff: its path and ONLY its added lines. */
export type SponsoredDiffFile = {
  /** Repository-relative, forward slashes, as git prints it after `b/`. */
  path: string
  /** Added lines joined by `\n`, leading `+` stripped. Never removed lines. */
  addedText: string
}

/** Per-file cap on the text the rules scan; a lockfile is not evidence. */
export const SPONSORED_DIFF_FILE_TEXT_CAP = 512_000

/**
 * Added lines per file out of a unified diff, as `git diff --unified=0
 * --no-color` prints it. Shared by Desktop and Cloud so the two surfaces
 * cannot disagree on what "the added lines" are.
 *
 * Deletions (`+++ /dev/null`) are skipped: a file that is gone has no added
 * lines. Binary files contribute a path and empty text. Renames keep the NEW
 * path. `+++`/`---` headers are never mistaken for content because a content
 * line is exactly one `+` followed by the line; the header is three.
 */
export function parseAddedLines(unifiedDiff: string): SponsoredDiffFile[] {
  const files: SponsoredDiffFile[] = []
  let current: { path: string; lines: string[]; length: number } | null = null
  const flush = () => {
    if (!current) return
    files.push({ path: current.path, addedText: current.lines.join('\n') })
    current = null
  }
  for (const rawLine of unifiedDiff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('diff --git ')) {
      flush()
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).split('\t')[0]!
      if (target === '/dev/null') {
        current = null
        continue
      }
      current = {
        path: target.startsWith('b/') ? target.slice(2) : target,
        lines: [],
        length: 0,
      }
      continue
    }
    if (line.startsWith('--- ')) continue
    if (!current) continue
    if (line.startsWith('+')) {
      const content = line.slice(1)
      if (current.length + content.length > SPONSORED_DIFF_FILE_TEXT_CAP) {
        continue
      }
      current.lines.push(content)
      current.length += content.length + 1
    }
  }
  flush()
  return files
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Where a project declares the variables it expects, by basename. The rule
 * for `api_key_issued` reads these and NOT `.env` itself: a sponsored run
 * never writes a secret (the credential-file refusal in
 * `sponsoredCapabilityPolicy.ts` stays), so the only file it can honestly
 * touch is the one that documents the variable NAMES.
 */
export const ENV_EXAMPLE_FILE_NAMES = [
  '.env.example',
  '.env.sample',
  '.env.template',
] as const

/**
 * The variable names the Supabase procedures wire. Substring matches, so the
 * framework-prefixed forms (`NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`,
 * `EXPO_PUBLIC_SUPABASE_ANON_KEY`) count without being enumerated.
 */
export const SUPABASE_URL_VARIABLE = 'SUPABASE_URL'
export const SUPABASE_KEY_VARIABLES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  /** Supabase's newer name for the anon key; same wiring, same evidence. */
  'SUPABASE_PUBLISHABLE_KEY',
] as const

/**
 * A Supabase client being constructed. `createClient` from `supabase-js`,
 * `createServerClient` / `createBrowserClient` from `@supabase/ssr`. The
 * import is required as well — `createClient(` alone names half the SDKs on
 * npm.
 */
const SUPABASE_IMPORT = /['"]@supabase\/(?:supabase-js|ssr)['"]/
const SUPABASE_CLIENT_INIT = /\bcreate(?:Server|Browser)?Client\s*\(/

/**
 * Project MCP configuration files, by repository-relative path. An entry
 * added anywhere else — a user's global `~/.claude.json`, say — is outside the
 * repository and outside the diff, so it cannot be verified and is not
 * counted. Listed as PATHS rather than basenames because `settings.json` is
 * an MCP config only under `.claude/`.
 */
export const MCP_CONFIG_FILE_PATHS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.claude/settings.json',
  '.vscode/mcp.json',
] as const

/**
 * A Supabase MCP server entry, by the three ways it is spelled: the npm
 * package, the hosted endpoint, and the community name. Case-insensitive
 * because JSON values are not, and a run that wrote `Supabase-MCP` has still
 * installed it.
 */
const SUPABASE_MCP_SERVER =
  /@supabase\/mcp-server-supabase|mcp\.supabase\.com|supabase-mcp/i

/** Only ever a subpath test; never a content test. */
function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function isEnvExampleFile(path: string): boolean {
  return (ENV_EXAMPLE_FILE_NAMES as readonly string[]).includes(basename(path))
}

function isMcpConfigFile(path: string): boolean {
  return (MCP_CONFIG_FILE_PATHS as readonly string[]).some(
    (config) => path === config || path.endsWith(`/${config}`),
  )
}

function wiresSupabaseVariables(text: string): boolean {
  return (
    text.includes(SUPABASE_URL_VARIABLE) &&
    SUPABASE_KEY_VARIABLES.some((name) => text.includes(name))
  )
}

/**
 * `api_key_issued` — "the wiring is in place". The committed diff adds the
 * Supabase variable names to an env example file AND adds a source file that
 * constructs a Supabase client from them. Both halves, because either alone is
 * something a run does while wiring anything: an example file naming a
 * variable nobody reads is documentation, and a client built from a literal
 * is a demo.
 */
function apiKeyIssuedFiles(diff: readonly SponsoredDiffFile[]): string[] {
  const envFiles = diff.filter(
    (file) =>
      isEnvExampleFile(file.path) && wiresSupabaseVariables(file.addedText),
  )
  if (envFiles.length === 0) return []
  const sourceFiles = diff.filter(
    (file) =>
      !isEnvExampleFile(file.path) &&
      !isMcpConfigFile(file.path) &&
      SUPABASE_IMPORT.test(file.addedText) &&
      SUPABASE_CLIENT_INIT.test(file.addedText) &&
      file.addedText.includes(SUPABASE_URL_VARIABLE),
  )
  if (sourceFiles.length === 0) return []
  return [...envFiles, ...sourceFiles].map((file) => file.path)
}

/**
 * `mcp_installed` — the diff adds a Supabase MCP server entry to one of the
 * project's MCP configuration files. Added lines only, so an entry that was
 * already there before the run is not credited to it.
 */
function mcpInstalledFiles(diff: readonly SponsoredDiffFile[]): string[] {
  return diff
    .filter(
      (file) =>
        isMcpConfigFile(file.path) && SUPABASE_MCP_SERVER.test(file.addedText),
    )
    .map((file) => file.path)
}

const RULES: Record<
  SponsoredRunOutcome,
  (diff: readonly SponsoredDiffFile[]) => string[]
> = {
  api_key_issued: apiKeyIssuedFiles,
  mcp_installed: mcpInstalledFiles,
}

/** An outcome the diff proved, with the paths that proved it. Paths only. */
export type SponsoredVerifiedOutcome = {
  outcome: SponsoredRunOutcome
  files: string[]
}

/** Enough paths to audit a verdict; not enough to mirror a repository. */
export const SPONSORED_OUTCOME_FILES_CAP = 20

/**
 * The outcomes that are BOTH declared and present in the diff, with evidence.
 *
 * Declared-and-absent is not emitted (the run did not do it), and
 * present-but-undeclared is not emitted either (the procedure was never
 * reviewed as doing it). Canonical order, so two surfaces reporting the same
 * run produce the same list.
 */
export function verifyOutcomes(
  diff: readonly SponsoredDiffFile[],
  declared: readonly string[],
): SponsoredVerifiedOutcome[] {
  const allowed = canonical(declared)
  const verified: SponsoredVerifiedOutcome[] = []
  for (const outcome of allowed) {
    const files = RULES[outcome](diff)
    if (files.length === 0) continue
    verified.push({
      outcome,
      files: [...new Set(files)].slice(0, SPONSORED_OUTCOME_FILES_CAP),
    })
  }
  return verified
}

/** `verifyOutcomes`, names only. */
export function detectOutcomes(
  diff: readonly SponsoredDiffFile[],
  declared: readonly string[],
): SponsoredRunOutcome[] {
  return verifyOutcomes(diff, declared).map((entry) => entry.outcome)
}

/**
 * The funnel row's idempotency key for a verified outcome:
 * `<proposalId>:<outcome>`. One proposal has at most one of each outcome, so
 * a retried terminal report or a redelivered Cloud schedule records once. The
 * proposal id leads (unlike the `<type>:<proposalId>` key the other internal
 * stages use) so every row about one run sorts together under its proposal.
 */
export function sponsoredOutcomeEventId(
  proposalId: string,
  outcome: SponsoredRunOutcome,
): string {
  return `${proposalId}:${outcome}`
}

/**
 * The `metadata` a verified-outcome funnel row carries. `verified_by: 'diff'`
 * is the provenance a readout filters on — it is what says this row came from
 * a rule over the commit and not from anything the run reported about itself.
 * `files` are repository-relative PATHS; content never reaches the row.
 */
export function sponsoredOutcomeMetadata(files: readonly string[]): {
  verified_by: 'diff'
  files: string[]
} {
  return {
    verified_by: 'diff',
    files: files.slice(0, SPONSORED_OUTCOME_FILES_CAP),
  }
}

/**
 * The git command that produces the diff both surfaces read. One string so
 * Desktop (argv) and Cloud (a shell line) cannot drift on flags: zero context
 * so every `+` line is an addition, no colour, no external diff driver, and
 * renames followed so a moved-and-edited file is one entry under its new path.
 */
export const SPONSORED_OUTCOME_DIFF_ARGS = [
  'diff',
  '--unified=0',
  '--no-color',
  '--no-ext-diff',
  '--find-renames',
] as const

/** `<base>..<head>` — the run's commits and nothing the user had before. */
export function sponsoredOutcomeDiffRange(base: string, head: string): string {
  return `${base}..${head}`
}
