/**
 * base3's rule for when a turn ends: the runtime ends it on any step without a
 * tool call (docs/freebuff-muse-spark.md). Shared with the server's Muse Spark
 * stopgap, which skips any prompt that already contains this exact text.
 */
export const TURN_ENDING_RULE =
  'A message without a tool call ends your turn: nothing runs after it, and ' +
  'nothing you write is queued for later. When you say what you will do next ' +
  '("let me check the config", "running the tests now"), make that tool call ' +
  'in the same message rather than ending on the plan. End your turn only ' +
  'when the task is done, the question is answered, or you need the user’s ' +
  'input.'
