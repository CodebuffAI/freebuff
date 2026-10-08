/**
 * Freebuff intentionally keeps the chat-header logo static.
 * Keep the existing sheen for Codebuff while honoring the global animation gate.
 */
export function shouldAnimateChatHeader(
  animationEnabled: boolean,
  isFreebuff: boolean,
): boolean {
  return animationEnabled && !isFreebuff
}
