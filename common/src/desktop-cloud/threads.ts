import { z } from 'zod/v4'

/**
 * The per-thread record a project coordinator's Threads panel reads (COD-878).
 *
 * One shape for both kinds of thread: a cloud worker writes it for a cloud
 * thread and the Desktop engine builds it for a local one. Everything the
 * panel shows (group, step count, status line, PR chip) is derived from these
 * fields alone, so the panel never branches on `kind`; `kind` only picks the
 * laptop marker and where a routed message is delivered.
 */

export const THREAD_KINDS = ['local', 'cloud'] as const
export type ThreadKind = (typeof THREAD_KINDS)[number]

/** Same states as Desktop's to-do dock (`write_todos` / `TodoWrite`). */
export const THREAD_STEP_STATES = ['pending', 'active', 'done'] as const
export type ThreadStepState = (typeof THREAD_STEP_STATES)[number]

/** `queued` is a cloud turn waiting for one of its project's run slots. */
export const THREAD_RUN_STATES = ['queued', 'running', 'idle'] as const
export type ThreadRunState = (typeof THREAD_RUN_STATES)[number]

export const THREAD_OUTCOMES = ['completed', 'stopped', 'failed'] as const
export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number]

/**
 * Who pays for a thread's model turns: Freebuff (its sessions and credits), or the user's own Codex
 * (ChatGPT) or Claude login, or their own API key. A cloud thread runs Codex or Claude Code on the
 * account's ChatGPT sign-in or saved Claude Code key (`./agents`); any other cloud thread is Freebuff.
 */
export const THREAD_FUNDINGS = ['freebuff', 'codex', 'claude', 'byok'] as const
export type ThreadFunding = (typeof THREAD_FUNDINGS)[number]

export const THREAD_FUNDING_LABELS: Record<ThreadFunding, string> = {
  freebuff: 'Freebuff',
  codex: 'Codex',
  claude: 'Claude',
  byok: 'Own key',
}

export const THREAD_DIGEST_MAX_STEPS = 50
export const THREAD_DIGEST_TEXT_LIMIT = 280

const text = z.string().max(THREAD_DIGEST_TEXT_LIMIT)
const isoTime = z.iso.datetime()

export const threadDigestStepSchema = z
  .object({ text: text.min(1), state: z.enum(THREAD_STEP_STATES) })
  .strict()
export type ThreadDigestStep = z.infer<typeof threadDigestStepSchema>

export const threadDigestQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: text.min(1),
    options: z.array(text.min(1)).max(8),
  })
  .strict()
export type ThreadDigestQuestion = z.infer<typeof threadDigestQuestionSchema>

export const threadDigestPullRequestSchema = z
  .object({
    url: z.url(),
    number: z.number().int().positive(),
    state: z.enum(['open', 'merged', 'closed']),
    conflict: z.boolean(),
    /** Absent reads as not a draft: a producer that never asked GitHub does not say. */
    draft: z.boolean().optional(),
  })
  .strict()
export type ThreadDigestPullRequest = z.infer<typeof threadDigestPullRequestSchema>

/**
 * `uncommitted` counts a shared checkout's working tree; `branch` counts everything a
 * worktree thread's branch changed against the branch it started from, committed or not.
 */
export const THREAD_GIT_CHANGE_SCOPES = ['uncommitted', 'branch'] as const
export type ThreadGitChangeScope = (typeof THREAD_GIT_CHANGE_SCOPES)[number]

const gitCount = z.number().int().nonnegative()

export const threadDigestGitSchema = z
  .object({
    /** The branch the thread works on; null for a detached or shared checkout with no branch. */
    branch: z.string().min(1).max(THREAD_DIGEST_TEXT_LIMIT).nullable(),
    /** Null when the producer has not measured it yet, as for a cloud thread Desktop cannot see into. */
    changes: z
      .object({
        scope: z.enum(THREAD_GIT_CHANGE_SCOPES),
        files: gitCount,
        adds: gitCount,
        dels: gitCount,
      })
      .strict()
      .nullable(),
  })
  .strict()
export type ThreadDigestGit = z.infer<typeof threadDigestGitSchema>

export const threadDigestSchema = z
  .object({
    /** The Desktop thread id; the Cloud chat id when the server writes it for a chat Desktop has not opened. */
    id: z.string().min(1),
    kind: z.enum(THREAD_KINDS),
    title: text.min(1),
    runState: z.enum(THREAD_RUN_STATES),
    /** The last finished turn's outcome; null before the first turn ends. */
    outcome: z.enum(THREAD_OUTCOMES).nullable(),
    /** The current turn's plan, or the last turn's when idle. */
    steps: z.array(threadDigestStepSchema).max(THREAD_DIGEST_MAX_STEPS),
    /** Written by the producer; the panel falls back to `threadStatusLine`. */
    statusLine: text.nullable(),
    lastMessage: text.nullable(),
    pendingQuestion: threadDigestQuestionSchema.nullable(),
    pullRequest: threadDigestPullRequestSchema.nullable(),
    /** Absent when the producer knows nothing about the thread's git (no branch, nothing measured). */
    git: threadDigestGitSchema.optional(),
    resolvedAt: isoTime.nullable(),
    /** Absent reads as `freebuff`: a producer that does not say runs on Freebuff. */
    funding: z.enum(THREAD_FUNDINGS).optional(),
    createdAt: isoTime,
    updatedAt: isoTime,
  })
  .strict()
export type ThreadDigest = z.infer<typeof threadDigestSchema>

export const THREAD_GROUPS = ['waiting', 'working', 'idle', 'resolved'] as const
export type ThreadGroup = (typeof THREAD_GROUPS)[number]

export const THREAD_GROUP_LABELS: Record<ThreadGroup, string> = {
  waiting: 'Waiting on you',
  working: 'Working',
  idle: 'Idle',
  resolved: 'Resolved',
}

/**
 * A question, a failed turn or a conflicting PR needs the user even while a
 * turn is still running, so waiting outranks working.
 */
export function threadGroup(digest: ThreadDigest): ThreadGroup {
  if (digest.resolvedAt !== null) return 'resolved'
  if (
    digest.pendingQuestion !== null ||
    (digest.runState === 'idle' && digest.outcome === 'failed') ||
    (digest.pullRequest?.state === 'open' && digest.pullRequest.conflict)
  ) {
    return 'waiting'
  }
  if (digest.runState !== 'idle') return 'working'
  return 'idle'
}

/** The row's progress ring, e.g. 2/4; null when the thread has no plan. */
export function threadStepCount(
  digest: Pick<ThreadDigest, 'steps'>,
): { done: number; total: number } | null {
  if (digest.steps.length === 0) return null
  const done = digest.steps.filter((step) => step.state === 'done').length
  return { done, total: digest.steps.length }
}

const oneLine = (value: string): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > THREAD_DIGEST_TEXT_LIMIT
    ? `${line.slice(0, THREAD_DIGEST_TEXT_LIMIT - 1)}…`
    : line
}

/** Normalizes producer text to the digest's single-line, bounded form. */
export function digestText(value: string | null | undefined): string | null {
  if (!value) return null
  const line = oneLine(value)
  return line || null
}

/**
 * The row's one-line status. A producer's own line wins; otherwise both
 * kinds get the same fallback from the shared fields.
 */
export function threadStatusLine(digest: ThreadDigest): string {
  if (digest.pendingQuestion) return digest.pendingQuestion.question
  if (digest.statusLine) return digest.statusLine
  if (digest.runState === 'queued') return 'Queued'
  if (digest.runState === 'running') {
    const active = digest.steps.find((step) => step.state === 'active')
    return active?.text ?? 'Working'
  }
  if (digest.outcome === 'failed') return 'Turn failed'
  if (digest.outcome === 'stopped') return 'Stopped'
  return digest.lastMessage ?? (digest.outcome === null ? 'Not started' : 'Finished')
}

export type ThreadPanelGroup = {
  group: ThreadGroup
  label: string
  threads: ThreadDigest[]
}

/**
 * The Threads panel model: the four groups in display order (empty ones
 * included, so the panel decides what to hide), newest activity first, and
 * the headline.
 */
export function threadPanel(digests: readonly ThreadDigest[]): {
  groups: ThreadPanelGroup[]
  headline: string
} {
  const byGroup = new Map<ThreadGroup, ThreadDigest[]>(
    THREAD_GROUPS.map((group) => [group, []]),
  )
  for (const digest of digests) byGroup.get(threadGroup(digest))!.push(digest)
  const groups = THREAD_GROUPS.map((group) => ({
    group,
    label: THREAD_GROUP_LABELS[group],
    threads: byGroup
      .get(group)!
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }))
  return { groups, headline: threadPanelHeadline(groups) }
}

function threadPanelHeadline(groups: readonly ThreadPanelGroup[]): string {
  const count = (group: ThreadGroup) =>
    groups.find((entry) => entry.group === group)!.threads.length
  const waiting = count('waiting')
  if (waiting > 0) {
    return `${waiting} ${waiting === 1 ? 'thread needs' : 'threads need'} you`
  }
  const working = count('working')
  if (working > 0) {
    return `${working} ${working === 1 ? 'thread' : 'threads'} working`
  }
  return groups.some((entry) => entry.threads.length > 0)
    ? 'All clear'
    : 'No threads yet'
}

/**
 * The panel's groups as the viewer arranged them: groups in `order` (a saved
 * order missing a group, or naming an unknown one, still yields all four),
 * and pinned threads first within each group, keeping newest-first otherwise.
 *
 * Within the pinned block the viewer's own `pinnedOrder` wins, so a pinned
 * thread stays where it was put instead of shuffling with every message. It is
 * a partial order: pinned threads it does not name — never arranged, or since
 * deleted from it — sort in behind the named ones, and sort is stable, so they
 * keep their newest-first order there.
 */
export function arrangeThreadPanel(
  groups: readonly ThreadPanelGroup[],
  {
    order = THREAD_GROUPS,
    pinned = new Set<string>(),
    pinnedOrder = [],
  }: {
    order?: readonly string[]
    pinned?: ReadonlySet<string>
    pinnedOrder?: readonly string[]
  } = {},
): ThreadPanelGroup[] {
  const rank = (group: ThreadGroup) => {
    const at = order.indexOf(group)
    return at === -1 ? order.length + THREAD_GROUPS.indexOf(group) : at
  }
  const rankPinned = (digest: ThreadDigest) => {
    const at = pinnedOrder.indexOf(digest.id)
    return at === -1 ? pinnedOrder.length : at
  }
  return [...groups]
    .sort((a, b) => rank(a.group) - rank(b.group))
    .map((entry) => {
      const pinnedThreads = entry.threads.filter((digest) => pinned.has(digest.id))
      return {
        ...entry,
        threads: [
          ...pinnedThreads.sort((a, b) => rankPinned(a) - rankPinned(b)),
          ...entry.threads.filter((digest) => !pinned.has(digest.id)),
        ],
      }
    })
}

/** `order` with `group` moved to where `target` sits; unknown groups are dropped. */
export function moveThreadGroup(
  order: readonly string[],
  group: ThreadGroup,
  target: ThreadGroup,
): ThreadGroup[] {
  const known = arrangeThreadPanel(
    THREAD_GROUPS.map((entry) => ({ group: entry, label: '', threads: [] })),
    { order },
  ).map((entry) => entry.group)
  const without = known.filter((entry) => entry !== group)
  without.splice(known.indexOf(target), 0, group)
  return without
}

/**
 * `pinnedOrder` with `thread` moved to sit directly above `target`, so a drag
 * onto a row leaves it where it was dropped.
 *
 * Unlike the group order this list is partial — it holds only the pinned
 * threads the viewer has arranged — so a `thread` it never named is simply
 * inserted, and a `target` it never named (one still resting in the
 * newest-first tail) sends `thread` to the end of the saved order, where the
 * tail follows it. Names not matching a pinned thread are kept: a saved order
 * outlives threads that were deleted or unpinned, and dropping them is the
 * viewer's call, not this function's.
 */
export function movePinnedThread(
  pinnedOrder: readonly string[],
  thread: string,
  target: string,
): string[] {
  const without = pinnedOrder.filter((id) => id !== thread)
  const at = without.indexOf(target)
  if (at === -1) return [...without, thread]
  without.splice(at, 0, thread)
  return without
}
