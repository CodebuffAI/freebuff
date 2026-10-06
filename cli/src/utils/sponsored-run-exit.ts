/**
 * What happens to a sponsored run when the terminal goes away (COD-339
 * acceptance 6).
 *
 * A one-function module, and separate from `exit-cleanly.ts` on purpose:
 * `exit-cleanly` is on the path of every exit the CLI ever makes, including the
 * ones that happen before a project root exists, and `sponsored-run.ts` reaches
 * the SDK's tool implementations, the client and a git runner. Importing that
 * graph into the exit path for a feature almost no exit uses is how a shutdown
 * starts costing a module load.
 *
 * ## The question this answers
 *
 * On Cloud a sponsored run is remote and closing the tab leaves it running. In
 * a terminal it is a process on the user's own machine, and Ctrl-C, a `kill`
 * and a closed window all end it the same way. Two things must not survive
 * that:
 *
 *  - the proposal left on `running` with nobody saying why. Upstream does
 *    sweep a locally-executed row now (COD-665): a `running` row an hour and a
 *    half after its `running_at` (the grant's hour of compute plus a grace),
 *    and a row still `accepted` 24 hours after its Accept. But the sweep can
 *    only call it `timed_out`, which says nothing about what happened or about
 *    the files the run had already edited, so this process reports its own
 *    terminal state. The report goes to the outbox before it is sent, so the
 *    next launch delivers it if this one cannot -- and a run killed before it
 *    wrote one is found by its in-flight record (`sponsored-run-inflight.ts`)
 *    at the next launch in ANY folder, which reports it into that run's own
 *    folder's outbox.
 *  - edits the user cannot account for. An in-place run (#3989) writes the
 *    working copy directly, so the notice says how many files it had already
 *    changed and names `/ads:undo`, whose receipts are on disk.
 *
 * ## Why every signal converges here
 *
 * `renderer-cleanup.ts` routes SIGTERM, SIGHUP and SIGINT to `exitCliCleanly`,
 * and `use-exit-handler.ts` routes Ctrl-C there too -- stdin is in raw
 * mode, so SIGINT never fires for the key and it arrives as an ordinary
 * OpenTUI event. One seam covers all four. SIGKILL cannot be caught by anyone,
 * so a row left `running` by one is closed on the way back UP rather than on
 * the way down -- by the next launch's in-flight sweep, in whichever folder
 * that launch opens, as Desktop does. A machine where the CLI is never
 * launched again is left to the server's sweep.
 */
import { currentSponsoredRun } from './sponsored-run'

export async function settleInterruptedSponsoredRun(): Promise<string | null> {
  // No run has ever been started in this session -- the overwhelmingly common
  // case, and the reason this is a cheap call on every exit.
  const run = currentSponsoredRun()
  if (!run) return null
  const outcome = await run.interrupt('signal')
  return outcome.notice
}
