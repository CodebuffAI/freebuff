import { finding, type DoctorArea, type DoctorFinding, type DoctorSeverity } from './types'
import { LEARN_MORE } from './help'

/**
 * A known failure that leaves a recognisable line in our own logs. The scan reports how many
 * times each one appears, never the line itself: a log line can hold a path or a file name.
 */
export type LogSignature = {
  id: string
  pattern: RegExp
  severity: DoctorSeverity
  area: DoctorArea
  title: string
  detail: string
  steps: string[]
  learnMore?: string
}

export const COMMON_LOG_SIGNATURES: LogSignature[] = [
  {
    id: 'log.sqlite-corrupt', pattern: /SQLITE_CORRUPT|database disk image is malformed|file is not a database|SQLITE_NOTADB/i,
    severity: 'error', area: 'chats', title: 'A local database is damaged',
    detail: 'The log shows SQLite reporting a damaged database. Chats stored in it may fail to open.',
    steps: ['Do not delete anything yet: the damaged file still holds your history.', 'Copy this report into a support request so we can help you recover it.'],
  },
  {
    id: 'log.git-dubious-ownership', pattern: /dubious ownership|safe\.directory/i,
    severity: 'warning', area: 'git', title: 'Git refused a folder owned by another user',
    detail: 'Git stops working in a folder whose owner is a different user account ("dubious ownership"). This often happens after copying a project from another computer or user, or on an external drive.',
    steps: ['If you own this folder, trust it in git (Diagnose offers this for each project it finds).', 'Otherwise, take ownership of the folder with your own user account.'],
    learnMore: LEARN_MORE.gitSafeDirectory,
  },
  {
    id: 'log.disk-full', pattern: /ENOSPC|no space left on device|disk (?:is )?full/i,
    severity: 'error', area: 'disk', title: 'The disk ran out of space',
    detail: 'A write failed because the disk was full. Chats, worktrees and updates can fail or be left half written.',
    steps: ['Free up at least a few gigabytes on the drive that holds your home folder.', 'Restart Freebuff.'],
  },
  {
    id: 'log.permission-denied', pattern: /\bE(?:PERM|ACCES)\b|operation not permitted|permission denied/i,
    severity: 'warning', area: 'environment', title: 'Access to a file was denied',
    detail: 'The system refused to let Freebuff read or write a file. On Windows this is usually antivirus or Controlled Folder Access blocking the app; elsewhere it is usually a file owned by another user.',
    steps: ['If you use Windows Security, allow Freebuff under Ransomware protection > Controlled folder access > Allow an app.', 'If you use another antivirus, add an exclusion for Freebuff and your project folders.', 'Check that your user owns the project folder.'],
    learnMore: LEARN_MORE.controlledFolderAccess,
  },
  {
    id: 'log.file-busy', pattern: /\bEBUSY\b|resource busy or locked|being used by another process/i,
    severity: 'warning', area: 'environment', title: 'A file was locked by another program',
    detail: 'Another program held a file Freebuff needed. Antivirus scanners and OneDrive sync are the usual cause on Windows.',
    steps: ['Add an antivirus exclusion for Freebuff and your project folders.', 'Keep project folders and the Freebuff profile out of OneDrive or other sync folders.'],
  },
  {
    id: 'log.illegal-instruction', pattern: /\bSIGILL\b|0xC000001D|illegal instruction/i,
    severity: 'error', area: 'system', title: 'The engine crashed on an unsupported processor instruction',
    detail: 'The bundled Bun runtime used a processor feature this computer does not have (an older CPU, or a virtual machine that hides AVX).',
    steps: ['Update Freebuff: current versions fall back to a runtime for older processors.', 'In a virtual machine, enable AVX/AVX2 pass-through for the guest.'],
  },
  {
    id: 'log.tls-intercepted', pattern: /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|certificate (?:verify failed|has expired)|self[- ]signed certificate/i,
    severity: 'warning', area: 'network', title: 'Secure connections were rejected',
    detail: 'Freebuff could not verify a server certificate. This is what HTTPS scanning by antivirus, or a corporate proxy that inspects traffic, looks like from inside the app.',
    steps: ['Turn off HTTPS or SSL scanning in your antivirus (or exclude freebuff.com and codebuff.com).', 'On a work network, ask IT to exempt freebuff.com and codebuff.com from TLS inspection.', 'Check that your computer clock is correct.'],
  },
  {
    id: 'log.network-unreachable', pattern: /\bENOTFOUND\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bECONNRESET\b|getaddrinfo|ConnectionRefused|FailedToOpenSocket/,
    severity: 'info', area: 'network', title: 'Network requests failed',
    detail: 'The log shows connections that could not be made (name lookup, refused or timed out). Occasional failures are normal on a flaky network; many in a row mean something blocks Freebuff.',
    steps: ['Check the network section of this report.', 'If you use a VPN, firewall or proxy, allow freebuff.com and codebuff.com.'],
  },
  {
    id: 'log.out-of-memory', pattern: /JavaScript heap out of memory|\bout of memory\b|ENOMEM|OOM/,
    severity: 'warning', area: 'system', title: 'A process ran out of memory',
    detail: 'Something Freebuff runs ran out of memory and stopped.',
    steps: ['Close other large apps and restart Freebuff.', 'Very large repositories need more memory; work in a smaller folder if you can.'],
  },
  {
    id: 'log.too-many-files', pattern: /\bEMFILE\b|too many open files|ENOSPC: System limit for number of file watchers/i,
    severity: 'warning', area: 'system', title: 'The system limit on open files or file watchers was reached',
    detail: 'The operating system refused to open more files or watch more folders.',
    steps: ['Raise the limit (see the system section of this report).', 'Restart Freebuff.'],
  },
  {
    id: 'log.port-in-use', pattern: /\bEADDRINUSE\b|address already in use/i,
    severity: 'info', area: 'processes', title: 'A port was already in use',
    detail: 'Something tried to listen on a port another program already holds. A leftover Freebuff or dev server process is the usual cause.',
    steps: ['Quit Freebuff completely and start it again.', 'Stop dev servers you no longer need.'],
  },
]

export type LogScan = { signature: LogSignature; count: number }

export function scanLogText(text: string, signatures: ReadonlyArray<LogSignature>): LogScan[] {
  const counts = new Map<string, LogScan>()
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    for (const signature of signatures) {
      if (!signature.pattern.test(line)) continue
      const entry = counts.get(signature.id) ?? { signature, count: 0 }
      entry.count++
      counts.set(signature.id, entry)
    }
  }
  return [...counts.values()]
}

export function logScanFindings(scans: LogScan[], source: string): DoctorFinding[] {
  return scans.map(({ signature, count }) =>
    finding(signature.id, signature.severity, signature.area, signature.title,
      `${signature.detail} Seen ${count} time${count === 1 ? '' : 's'} in ${source}.`, signature.steps,
      signature.learnMore ? { learnMore: signature.learnMore } : {}))
}
