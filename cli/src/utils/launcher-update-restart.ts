/**
 * Whether a SIGTERM is the npm launcher replacing this binary with an update.
 *
 * The launcher (`cli/release-core/launcher.js`) spawns the binary at once and
 * checks for an update in the background. When the new build is staged it
 * SIGTERMs the running binary, installs, and relaunches with the same argv —
 * a median ~16s after a Freebuff user has already picked a model and paid for
 * its hour. `stopRunningProcess` in `checkForUpdates` is the launcher's ONLY
 * SIGTERM, and old launchers stay installed until the user reinstalls the npm
 * package, so the binary has to recognise it without the launcher's help:
 * the signal arrives while our parent is still the live launcher.
 *
 * A user's own `kill <pid>` of the binary matches too. That is harmless: the
 * session is then left exactly as a crash leaves it, which the next launch
 * takes over for free (see `isFreebuffInstanceOwnedByDeadLocalProcess`).
 * Terminal close is SIGHUP, and Windows never runs a SIGTERM handler at all
 * (the launcher's kill is TerminateProcess), so neither reaches this.
 */
export function isLauncherUpdateTermination(params: {
  /** `CODEBUFF_LAUNCHER_PID`, as set by the launcher on its child. */
  launcherPid: number
  /** `process.ppid`. A binary orphaned by a dead launcher is reparented. */
  parentPid: number
  isProcessRunning: (pid: number) => boolean
}): boolean {
  const { launcherPid, parentPid } = params
  if (!Number.isInteger(launcherPid) || launcherPid <= 0) return false
  if (parentPid !== launcherPid) return false
  return params.isProcessRunning(launcherPid)
}
