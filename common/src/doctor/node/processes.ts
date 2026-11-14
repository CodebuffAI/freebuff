import { runCommand, type RunCommand } from './git'

export type ProcessRow = { pid: number; ppid: number; command: string }

/** Every process with its parent and command line. Read-only; bounded by the command's time limit. */
export async function processTable(platform: string, run: RunCommand = runCommand): Promise<ProcessRow[]> {
  if (platform === 'win32') {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'], { timeoutMs: 8_000 })
    return result.stdout.split(/\r?\n/).flatMap(line => {
      const [pid, ppid, ...command] = line.split('\t')
      return pid && ppid ? [{ pid: Number(pid), ppid: Number(ppid), command: command.join('\t') }] : []
    })
  }
  const result = await run('ps', ['-axww', '-o', 'pid=,ppid=,command='], { timeoutMs: 4_000 })
  return result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
  })
}
