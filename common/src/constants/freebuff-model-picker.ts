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

/**
 * THE iOS AND ANDROID APPS' MODEL PICKER (product, Sam, 2026-11-19): off for
 * everyone, to cut choices on a phone. While false, every catalog read from a
 * phone carries `appModelPicker: false`, and the apps draw no Freebuff model
 * control for any account, Advanced Mode or not: Code mode runs on the
 * account's default, Chat mode on Balanced. Claude Code and Codex keep their
 * models. Set true to bring the picker back with no app release: the apps
 * then follow `hideModelPicker` and Advanced Mode again, as Web does.
 */
export const FREEBUFF_APP_MODEL_PICKER: boolean = false

/** Whether an account created at `createdAt` (ms or ISO) is past the cutoff. */
export function modelPickerRetiredForAccount(
  createdAt: number | string | null | undefined,
): boolean {
  if (createdAt === null || createdAt === undefined) return false
  const ms = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
  return Number.isFinite(ms) && ms >= FREEBUFF_MODEL_PICKER_RETIRED_SINCE
}
