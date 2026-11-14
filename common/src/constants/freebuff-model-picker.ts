/**
 * NO MODEL PICKER FOR NEW ACCOUNTS (product, 2026-11-13, Dawson). An account
 * created at or after this instant, at either access tier and on any plan,
 * gets no model control in the Freebuff workspace composer (web and hosted
 * Desktop), in Code mode or Chat mode: Code mode runs on the account's
 * default model at its default reasoning, Chat mode on Freebuff 1.5's middle
 * stop.
 *
 * The picker comes back, listing every model, with Settings → Advanced Mode
 * on, or once the account has its own model provider, Claude Code or Codex
 * connected, since the picker is the only way to choose those. Accounts
 * created before this instant keep today's picker.
 *
 * A checked-in constant, not a switch: to move the cutoff, change it here.
 */
export const FREEBUFF_MODEL_PICKER_RETIRED_SINCE = Date.parse(
  '2026-11-14T00:00:00Z',
)

/** Whether an account created at `createdAt` (ms or ISO) is past the cutoff. */
export function modelPickerRetiredForAccount(
  createdAt: number | string | null | undefined,
): boolean {
  if (createdAt === null || createdAt === undefined) return false
  const ms = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
  return Number.isFinite(ms) && ms >= FREEBUFF_MODEL_PICKER_RETIRED_SINCE
}
