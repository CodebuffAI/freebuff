/**
 * A one-line hint for a failed terminal command whose output shows a shell
 * dialect mismatch: cmd.exe or PowerShell commands sent to bash on Windows, or
 * bash syntax sent to a PowerShell 5.1 host (the sponsored Windows floor).
 *
 * The system prompt already names the shell, yet traces keep showing `dir` or
 * `&&` retried several times. A hint next to the error is where the model looks.
 *
 * Conservative: only on a non-zero exit and only for exact signatures, so a
 * genuinely missing program (`pnpm: command not found`) never gets a hint.
 */

/** cmd.exe commands and their bash replacements. */
const CMD_TO_POSIX: Record<string, string> = {
  dir: 'ls',
  del: 'rm',
  copy: 'cp',
  move: 'mv',
  findstr: 'grep',
  type: 'cat',
  where: 'command -v',
}

/** POSIX tools PowerShell 5.1 lacks (it aliases ls, cat, rm, cp, mv). */
const POSIX_TO_POWERSHELL: Record<string, string> = {
  grep: 'Select-String',
  touch: 'New-Item -ItemType File',
  which: 'Get-Command',
  head: 'Select-Object -First N',
  tail: 'Get-Content -Tail N',
  export: "$env:NAME = 'value'",
  sed: "(Get-Content f) -replace 'a','b'",
  wc: 'Measure-Object',
}

// Git Bash: `bash: dir: command not found` or `/usr/bin/bash: line 1: dir: ...`.
const BASH_NOT_FOUND =
  /(?:^|\n)(?:\S*\/)?bash(?:: line \d+)?: ([A-Za-z][\w-]*): command not found/g

// An unquoted Windows drive path; bash strips each `\`, so `C:\Users\me`
// reaches the program as `C:Usersme`.
const DRIVE_PATH = /(?:^|[\s=])([A-Za-z]:\\[^\s'"`;|&<>()]+)/g

const PS_TERM_NOT_RECOGNIZED =
  /The term '([^'\r\n]+)' is not recognized as (?:the|a) name of a cmdlet/g

const PS_AND_OR = /The token '(&&|\|\|)' is not a valid statement separator/

const PS = 'Hint: this terminal is Windows PowerShell 5.1;'

function bashOnWindows(command: string, output: string): string | undefined {
  for (const [, name] of output.matchAll(BASH_NOT_FOUND)) {
    const replacement = CMD_TO_POSIX[name!.toLowerCase()]
    if (replacement)
      return `Hint: this terminal is bash on Windows, not cmd.exe; use ${replacement} instead of ${name}, and forward slashes in paths.`
    if (/^(?:Get|Set|New|Remove)-[A-Za-z]+$/.test(name!))
      return 'Hint: this terminal is bash on Windows, not PowerShell; use POSIX commands (ls, cat, rm -rf, mkdir -p) instead of cmdlets.'
  }
  for (const [, path] of command.matchAll(DRIVE_PATH)) {
    const eaten = path!.replace(/\\(.)/g, '$1')
    // Only a path that visibly lost its backslashes in the output.
    if (eaten !== path && eaten.length >= 5 && output.includes(eaten))
      return 'Hint: this terminal is bash on Windows, where \\ is an escape character; write paths with forward slashes (C:/Users/me).'
  }
  return undefined
}

function powershellHost(command: string, output: string): string | undefined {
  const andOr = output.match(PS_AND_OR)?.[1]
  if (andOr)
    return `${PS} it has no ${andOr}; chain commands with ; and check $LASTEXITCODE.`
  if (command.includes('/dev/null') && /dev[\\/]null/i.test(output))
    return `${PS} discard output with > $null or 2> $null, not /dev/null.`
  // `rm -rf x`, `ls -la`: the aliases are cmdlets that take no POSIX flags.
  if (
    /\b(?:ls|rm|cp|mv|cat)\s+-[a-z]/.test(command) &&
    /A parameter cannot be found that matches parameter name '[a-z]{1,3}'/.test(
      output,
    )
  )
    return `${PS} ls, rm, cp take no POSIX flags; use e.g. Remove-Item -Recurse -Force, Get-ChildItem -Force.`
  for (const [, term] of output.matchAll(PS_TERM_NOT_RECOGNIZED)) {
    if (/^[A-Za-z_]\w*=/.test(term!))
      return `${PS} set variables with $env:NAME = 'value'; then run the command.`
    const replacement = POSIX_TO_POWERSHELL[term!.toLowerCase()]
    if (replacement) return `${PS} use ${replacement} instead of ${term}.`
  }
  return undefined
}

export function shellMismatchHint({
  platform,
  shell,
  command,
  stdout,
  stderr,
  exitCode,
}: {
  platform: string
  shell: 'bash' | 'powershell'
  command: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
}): string | undefined {
  if (typeof exitCode !== 'number' || exitCode === 0) return undefined
  const output = `${stderr ?? ''}\n${stdout ?? ''}`
  if (shell === 'powershell') return powershellHost(command, output)
  if (platform === 'win32') return bashOnWindows(command, output)
  return undefined
}
