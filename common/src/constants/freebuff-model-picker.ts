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
 * THE iOS AND ANDROID APPS' MODEL PICKER: ON. A catalog read from a phone
 * carries `appModelPicker: true`, and the apps follow `hideModelPicker` and
 * Advanced Mode again, as Web does. Web ignores the field.
 *
 * History, because this constant has been both ways. It was off for everyone
 * from 2026-11-19 (product, Sam) to cut choices on a phone: while false, every
 * catalog read from a phone carried `appModelPicker: false`, and the apps
 * listed no Freebuff model for any account, Advanced Mode or not — Code mode
 * ran on the account's default, Chat mode on Balanced, and Claude Code and
 * Codex kept their models. Since 2026-11-27 (Sam) the apps also let Code mode
 * slide that default model's own reasoning levels where it has more than one:
 * one slider under the level's name, never a choice of model
 * (docs/freebuff-new-account-catalog.md, "The apps' level slider").
 *
 * A checked-in constant, not a switch, and it needs no app release either
 * way: set false to take the picker away from the apps again.
 */
export const FREEBUFF_APP_MODEL_PICKER: boolean = true

/** Whether an account created at `createdAt` (ms or ISO) is past the cutoff. */
export function modelPickerRetiredForAccount(
  createdAt: number | string | null | undefined,
): boolean {
  if (createdAt === null || createdAt === undefined) return false
  const ms = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
  return Number.isFinite(ms) && ms >= FREEBUFF_MODEL_PICKER_RETIRED_SINCE
}
