/**
 * Declarative expiry boundaries for messages in agent history, carried on a
 * message's `expiresAt` field. The expiry pass is `expireMessages` in
 * util/messages.ts.
 */
export type AgentExpiresAt =
  /** Removed at the next step boundary after the step that observed it. */
  | 'agentStep'
  /**
   * Removed only when a user prompt ends (or a turn-time-out closes the
   * turn). Deprecated: prefer agentStep — every `endOf: 'userPrompt'` call
   * site also runs after a turn's messages have been consumed, so surviving
   * there buys nothing over 'agentStep'.
   */
  | 'userPrompt'
  /**
   * Clean up at the end of an agent invocation, but don't keep during
   * truncation. Everything before this is deleted after all messages after it
   * are deleted (or none exist). For example, the prompt a subagent was
   * spawned with should not get repeated (it matters less after a few steps),
   * but it shouldn't just disappear and leave a hanging assistant message.
   *
   * Not yet implemented: treated as a message that never expires.
   */
  | 'turn'
  /**
   * Everything is chunked, and the tags removed/reordered when summarizing
   * from the original messages.
   *
   * Not yet implemented: treated as a message that never expires.
   */
  | 'conversation'
  /**
   * For use with keepLastTags: we don't know when the agent deems it stale.
   * Never expires on its own.
   */
  | 'notImplemented'
