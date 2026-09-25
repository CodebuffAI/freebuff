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
 *  - the proposal stuck on `running` forever. Upstream has no sweep for a
 *    locally-executed row -- the whole point of COD-396 is that the executing
 *    surface is the only writer -- so if this process does not report a
 *    terminal state, nothing ever will. The report goes to the outbox before
 *    it is sent, so the next launch delivers it if this one cannot.
 *  - edits the user cannot account for. An in-place run (#3989) writes the
 *    working copy directly, so the notice says how many files it had already
 *    changed and names `/ads:undo`, whose receipts are on disk.
 *
 * ## Why every signal converges here
 *
 * `renderer-cleanup.ts` routes SIGTERM, SIGHUP and SIGINT to `exitCliCleanly`,
 * and `use-freebuff-ctrl-c-exit.ts` routes Ctrl-C there too -- stdin is in raw
 * mode, so SIGINT never fires for the key and it arrives as an ordinary
 * OpenTUI event. One seam covers all four. SIGKILL cannot be caught by anyone,
 * and a row left `running` by one is the honest limit of this: it is the same
 * limit Desktop has, and Desktop closes it on the way back UP rather than on
 * the way down.
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
