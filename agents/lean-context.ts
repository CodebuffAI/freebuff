import { compactionThreshold } from '@codebuff/common/constants/compaction-policy'

/**
 * The prompt section of a `lean` compaction policy (LEAN_COMPACTION_POLICY):
 * context is scarce, so read narrowly, without doing less of the task.
 *
 * Tuned on buffbench with Claude Haiku 5.5 held under 100k tokens. Compaction
 * alone cost ~0.5 points; this section brought the gap to ~0.2 and halved how
 * often a run compacted. Telling the model to save context made it do less
 * work until the second paragraph said it must not, and the write_todos line
 * is what lets it resume after a pass (remaining todos survive in the
 * summary). Workspace roots have no write_todos, so for them that line is a
 * short plan in the transcript instead.
 */
export function leanContextGuidance(
  maxContextLength: number,
  options: { workspace?: boolean } = {},
): string {
  const condensedAt = Math.round(compactionThreshold(maxContextLength) / 1000)
  // Desktop and Cloud workspace roots have no write_todos tool
  // (agents/base3.ts drops it), so their plan has to live in the transcript.
  const plan = options.workspace
    ? {
        write: 'keep a short plan in your reply and update it as you go',
        survives:
          'This workspace has no to-do tool; the plan in the transcript is what you check after condensing.',
        check: 'your plan',
      }
    : {
        write:
          'write the plan with write_todos before editing and keep it current',
        survives:
          'Your remaining todos survive condensing, so they are how you pick up where you left off; without them you lose track of what is done.',
        check: 'your todos',
      }
  // One sentence skeleton, two variants: the non-workspace text stays as it was.
  const planGuidance = `- For any task with more than a couple of steps, ${plan.write}. ${plan.survives}`
  const stayGuidance = `- Stay within the request. After condensing, check ${plan.check} and the request before starting anything new rather than broadening the change.`
  return `# Context budget

Your context is small: everything you read or run stays in this conversation. When it grows past ~${condensedAt}k tokens it is condensed automatically: you keep the user's request, a log of your earlier messages and tool calls, the most recent file reads, and an outline with line numbers of the other files you read. Old tool output is gone after that, and files you edited are not carried over; re-read only the window you need, using the outline's line numbers.

The budget limits how you read, never how much of the task you do. Do every part of the request and verify it as thoroughly as you would with unlimited context.

- Search widely, read narrowly. code_search is cheap: use it to find every definition, caller, test and type the change touches (matches come with line numbers), then read the parts you need.
- Read a whole file only when it is about 100 lines or fewer. For a longer file, read a window with { path, offset, limit } of 100-250 lines around what you need, enough to see the surrounding function or block in full; avoid slices of a few dozen lines. The result tells you the file's total line count.
- Don't re-read lines you have already seen unless the file changed since.
- Keep terminal output short: filter long output (grep, head, tail -n 50) while preserving the exit status. Still run the typecheck and the tests that cover your change.
- Edit with str_replace rather than rewriting whole files.
${planGuidance}
${stayGuidance}
- Before finishing, code_search for remaining references to anything you renamed, removed or changed the signature of, including tests, and update them.`
}
