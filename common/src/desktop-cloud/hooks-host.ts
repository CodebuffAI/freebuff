import { z } from 'zod/v4'

import {
  HOOK_COMMAND_MAX_CHARS,
  HOOK_FILE_BYTES,
  hookCommandProblem,
  matcherProblem,
} from './hooks'

/**
 * What Settings > Hooks and Desktop's `freebuffHost.hooks` bridge exchange. The hooks themselves
 * live in `~/.agents/hooks.json` (Claude Code's format); a new or changed one does not run until
 * the user switches it on here.
 */

export const HOOKS_LIMIT = 50
/** Equal to the consent bridge's cap (`MAX_HOOK_COMMAND_CHARS`): what Settings writes, the dialog shows whole. */
export const HOOK_COMMAND_MAX = HOOK_COMMAND_MAX_CHARS
export const HOOK_MATCHER_MAX = 200
export const HOOK_TIMEOUT_MAX_S = 60
export const HOOK_NAME_MAX = 80

export const hookEvent = z.enum(['PreToolUse', 'PostToolUse'])
export type HookEvent = z.infer<typeof hookEvent>

/** The first letter up: the shared rules' sentences are also used mid-sentence. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A display label only. Leave control characters and direction overrides out of row titles. */
export const hookDisplayName = z.string().trim().min(1).max(HOOK_NAME_MAX)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]+$/u)

/**
 * What Settings sends Desktop to add a hook. It refuses exactly what the file parser
 * (`matcherProblem`) and the consent bridge (`hookCommandProblem`) would, with their sentence as
 * the issue's message, so nothing the form accepts fails after the approval dialog.
 */
export const hookAddInput = z
  .object({
    event: hookEvent,
    displayName: hookDisplayName.optional(),
    /** Tool names (`Bash`, `Write|Edit`, `*`); empty matches every tool. */
    matcher: z
      .string()
      .trim()
      .max(HOOK_MATCHER_MAX)
      // Before the character check, so `(Write|Edit)` is told it is not a plain tool name.
      .superRefine((matcher, context) => {
        const problem = matcherProblem(matcher)
        if (problem) context.addIssue({ code: 'custom', message: sentence(problem) })
      })
      .regex(/^[A-Za-z0-9_|*. -]*$/)
      .default(''),
    command: z
      .string()
      .trim()
      .min(1)
      .superRefine((command, context) => {
        const problem = hookCommandProblem(command)
        if (problem) context.addIssue({ code: 'custom', message: sentence(problem) })
      }),
    /** Seconds; Desktop's default applies when omitted. */
    timeout: z.number().int().min(1).max(HOOK_TIMEOUT_MAX_S).optional(),
  })
  .strict()
export type HookAddInput = z.infer<typeof hookAddInput>

const hookRouteId = z.string().min(1).max(256)

/**
 * The bytes main LISTED for a hook, sent with `rename` and `remove`: the route changes the hook at that id only
 * while it still holds exactly these bytes, so an edit between the list and the click cannot make
 * the click delete a different hook. Only the two events Settings lists can be removed from it.
 */
export const hookListedBytes = z
  .object({
    event: hookEvent,
    // Only compared with the file, never written or shown, so bounded by what the file parser can
    // list (a hand-written hook may be over Settings' caps and must still be removable), not by them.
    matcher: z.string().max(HOOK_FILE_BYTES),
    command: z.string().min(1).max(HOOK_FILE_BYTES),
    timeout: z.number().positive().finite().nullable(),
  })
  .strict()
export type HookListedBytes = z.infer<typeof hookListedBytes>

/** A rename also compares the listed label so shifts between identical commands are detectable. */
const hookRenameExpected = hookListedBytes.extend({ displayName: hookDisplayName.optional() })
export type HookRenameExpected = z.infer<typeof hookRenameExpected>

/** The route's 409 when the hook at an id no longer holds the bytes main listed. */
export const HOOK_CHANGED_ON_DISK = 'This hook changed. Check it and try again'

/**
 * What Electron main sends the orchestrator's `POST hooks` route (beside `accountId`, which the
 * route checks and strips first). File operations only: nothing here carries approval state, a
 * hash or a switch. Turning a hook on is main's, behind its own dialog.
 */
export const hooksRouteInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('describe'), id: hookRouteId }).strict(),
  z.object({ operation: z.literal('add'), hook: hookAddInput }).strict(),
  /** Writes nothing: refuses `hook` as `add` would (the shared rules, and a file the write would
   *  refuse: a link, not valid JSON, the event not a list, full), else answers as `list`. Main calls
   *  it before the approval dialog, since it cannot load these rules itself. */
  z.object({ operation: z.literal('validate'), hook: hookAddInput }).strict(),
  z.object({ operation: z.literal('rename'), id: hookRouteId, displayName: hookDisplayName.nullable(), expected: hookRenameExpected }).strict(),
  z.object({ operation: z.literal('remove'), id: hookRouteId, expected: hookListedBytes }).strict(),
  /** Writes nothing: refuses as `remove` would (a file Desktop will not rewrite, a hook that is gone
   *  or no longer `expected`), else answers the hook as `describe`. Main calls it before it
   *  forgets the approval, so a remove the write would refuse leaves the approval as it was. */
  z.object({ operation: z.literal('validate-remove'), id: hookRouteId, expected: hookListedBytes }).strict(),
])
export type HooksRouteInput = z.infer<typeof hooksRouteInput>

/**
 * Why `hook` cannot be added, as one sentence for the user, or null: the shared rules' sentence
 * when one applies, else a fixed one.
 */
export function hookAddProblem(hook: unknown): string | null {
  const parsed = hookAddInput.safeParse(hook)
  if (parsed.success) return null
  return parsed.error.issues.find((issue) => issue.code === 'custom')?.message ?? 'Invalid hooks request'
}

/** One hook as the file holds it. `displayName` is outside the bytes main checks for approval. */
export type HookFileEntry = {
  id: string
  event: string
  displayName?: string
  matcher: string
  command: string
  timeout: number | null
}

/** A problem with the file or one entry of it (`where` is `(file)` or e.g. `PreToolUse[0].hooks[1]`). */
export type HookFileError = { where: string; message: string }

/** The route's answer to every operation. `added` is the new hook's id on `add`. */
export type HooksRouteResult = {
  deviceId: string | null
  hooks: HookFileEntry[]
  errors: HookFileError[]
  added?: string
}

/** One hook as Settings shows it. */
export type HookView = {
  id: string
  event: HookEvent
  /** Optional local label. Settings falls back to the trigger label. */
  displayName?: string
  matcher: string
  command: string
  timeout: number | null
  /** The user's switch. */
  enabled: boolean
  /** Whether it runs now: switched on and approved as it is on disk. */
  runnable: boolean
  /**
   * Why it does not run, first match wins: no approval record, `new`; a record whose bytes
   * differ from the file, `changed`; bytes match but switched off, `off`; runnable, `null`.
   */
  reason: 'new' | 'changed' | 'off' | null
  /**
   * Set when the hook can never be switched on as written (a command or matcher the approval
   * dialog cannot show): the sentence why. It is then not runnable and `reason` is null.
   */
  problem?: string
}

/** This computer's install id (as Cloud lists its devices) and its hooks. */
export type HooksHostList = {
  deviceId: string | null
  hooks: HookView[]
  /** What is wrong with `~/.agents/hooks.json`, if anything; a malformed file lists no hooks. */
  errors?: HookFileError[]
  /** The file holds `HOOKS_LIMIT` hooks, counting every event (Settings lists two of five). */
  full: boolean
}
