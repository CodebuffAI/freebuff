/**
 * Shell Approval Bridge
 *
 * A correlated, concurrency-safe bridge for shell-command approvals.
 *
 * The generic AskUserBridge holds a single `pendingRequest`, so a second
 * concurrent request silently replaces the first and the first caller never
 * resolves. That is unsafe for approvals: a lost request must never be treated
 * as granted. This bridge:
 *   - correlates every request by a unique id,
 *   - serializes requests (the UI shows one at a time) in FIFO order,
 *   - resolves 'deny' on timeout, abort, or UI shutdown,
 *   - never resolves 'approve' unless an explicit submit says so.
 */

export type ShellApprovalVerdict = 'approve' | 'deny'

export interface ShellApprovalRequest {
  id: string
  command: string
  cwd: string
  processType: 'SYNC' | 'BACKGROUND'
  signal?: AbortSignal
}

export interface PendingShellApproval extends ShellApprovalRequest {}

type Listener = (active: PendingShellApproval | null, queued: number) => void

interface Entry {
  request: ShellApprovalRequest
  resolve: (verdict: ShellApprovalVerdict) => void
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  onAbort: (() => void) | null
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

let active: Entry | null = null
const queue: Entry[] = []
const listeners: Listener[] = []

function notify() {
  const snapshot = active ? { ...active.request } : null
  for (const l of listeners) l(snapshot, queue.length)
}

function settleEntry(entry: Entry, verdict: ShellApprovalVerdict) {
  if (entry.settled) return
  entry.settled = true
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.onAbort && entry.request.signal) {
    entry.request.signal.removeEventListener('abort', entry.onAbort)
  }
  entry.resolve(verdict)
}

function activateNext() {
  while (queue.length > 0) {
    const next = queue.shift()!
    if (next.settled) continue
    if (next.request.signal?.aborted) {
      settleEntry(next, 'deny')
      continue
    }
    active = next
    notify()
    return
  }
  active = null
  notify()
}

function settle(entry: Entry, verdict: ShellApprovalVerdict) {
  if (entry.settled) return
  const wasActive = active === entry
  const queuedIndex = queue.indexOf(entry)
  settleEntry(entry, verdict)

  if (wasActive) {
    active = null
    activateNext()
  } else if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1)
    notify()
  }
}

/**
 * Request approval for one command. Resolves 'approve' only when the matching
 * id is submitted with that verdict; otherwise 'deny' (timeout/abort/shutdown).
 */
export function requestShellApproval(
  request: ShellApprovalRequest,
  options: { timeoutMs?: number } = {},
): Promise<ShellApprovalVerdict> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<ShellApprovalVerdict>((resolve) => {
    const entry: Entry = {
      request,
      resolve,
      settled: false,
      timer: null,
      onAbort: null,
    }

    // If the run is already aborted, deny without queueing.
    if (request.signal?.aborted) {
      entry.settled = true
      resolve('deny')
      return
    }

    if (request.signal) {
      entry.onAbort = () => settle(entry, 'deny')
      request.signal.addEventListener('abort', entry.onAbort, { once: true })
    }

    entry.timer = setTimeout(() => settle(entry, 'deny'), timeoutMs)
    entry.timer.unref?.()

    if (active) {
      queue.push(entry)
      notify()
    } else {
      active = entry
      notify()
    }
  })
}

/**
 * Submit a verdict for a specific approval id. Ids that do not match the active
 * request are ignored, so a stale UI action cannot approve a different command.
 */
export function submitShellApproval(
  id: string,
  verdict: ShellApprovalVerdict,
): boolean {
  if (!active || active.request.id !== id || active.settled) return false
  const current = active
  settle(current, verdict)
  return true
}

/** Deny every pending request. Called on UI shutdown so no caller hangs. */
export function cancelAllShellApprovals(): void {
  const pending = active ? [active, ...queue] : [...queue]
  active = null
  queue.length = 0
  for (const entry of pending) settleEntry(entry, 'deny')
  notify()
}

export function getActiveShellApproval(): PendingShellApproval | null {
  return active ? { ...active.request } : null
}

export function subscribeShellApprovals(listener: Listener): () => void {
  listeners.push(listener)
  listener(active ? { ...active.request } : null, queue.length)
  return () => {
    const idx = listeners.indexOf(listener)
    if (idx !== -1) listeners.splice(idx, 1)
  }
}

/** Test-only: reset all state. */
export function __resetShellApprovalBridge(): void {
  active = null
  queue.length = 0
  listeners.length = 0
}
