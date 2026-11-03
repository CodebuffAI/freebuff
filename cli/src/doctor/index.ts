import { buildDoctorReport, doctorHelp, formatDoctorReport, parseDoctorArgs } from './run-doctor'

/** `freebuff doctor` (or `codebuff doctor`): the first argument, before any option. */
export function isDoctorInvocation(argv: string[]) {
  return argv[2] === 'doctor'
}

/**
 * Runs before the app initialises anything (sign-in, analytics, the renderer), so it still works
 * when those are what is broken. Prints a redacted report; returns the exit code (1 when a check
 * found a problem).
 */
export async function runDoctorCommand(input: {
  argv: string[]
  packageName: string
  version: string
  configDir: string
  apiUrl: string
  launcherVersion: string | null
  write?: (text: string) => void
}): Promise<number> {
  const write = input.write ?? (text => process.stdout.write(text))
  const options = parseDoctorArgs(input.argv.slice(3))
  if ('help' in options) {
    write(doctorHelp(input.packageName))
    return 0
  }
  if (options.format === 'text') write(`Checking this computer (read-only)…\n\n`)
  const report = await buildDoctorReport({
    includePaths: options.includePaths, version: input.version, packageName: input.packageName, configDir: input.configDir,
    apiUrl: input.apiUrl, launcherVersion: input.launcherVersion, cwd: process.cwd(),
  })
  write(formatDoctorReport(report, options, input.packageName))
  return report.findings.some(item => item.severity === 'error') ? 1 : 0
}
