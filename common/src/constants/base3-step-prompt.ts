/**
 * base3's per-step batching reminder on DeepSeek V4.1 Flash (`stepPrompt`,
 * agents/base3.ts). Here so the server can recognise it by its exact text
 * (`isRootStepReminderMessage`, common/src/util/system-reminder.ts): it is the
 * last user message of every such request, never the user's own words.
 */
export const BASE3_BATCHING_STEP_PROMPT = `Work in batches: put every tool call you can already make into this response (all the searches you can think of, every file worth reading, all the edits you know with their checks in one command). Once every part of the request is done and checked, give the final message instead.`

/**
 * Earlier texts of the reminder, which released clients still send until they
 * update. "Once the request is met" read as permission to stop with part of a
 * larger change undone (docs/benchmarks/base3-batched/README.md, round 1).
 */
export const BASE3_BATCHING_STEP_PROMPT_PREVIOUS: readonly string[] = [
  `Work in batches: put every tool call you can already make into this response (all the searches you can think of, every file worth reading, all the edits you know with their checks in one command). Once the request is met, give the final message instead.`,
]
