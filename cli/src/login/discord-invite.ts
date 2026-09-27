import {
  FREEBUFF_DISCORD_INVITE_URL,
  FREEBUFF_DISCORD_MEMBERS_LABEL,
} from '@codebuff/common/constants/freebuff-community'

/**
 * The line a fresh Freebuff sign-in ends on, in the TUI's top banner and in
 * `freebuff login --plain`: the moment someone has just joined is the one
 * most worth inviting them to talk to us. Freebuff only — Codebuff's
 * community is a different server.
 */
export const DISCORD_AFTER_LOGIN_TEXT = `Talk directly with our team and ${FREEBUFF_DISCORD_MEMBERS_LABEL} community members on Discord:`

export { FREEBUFF_DISCORD_INVITE_URL }
