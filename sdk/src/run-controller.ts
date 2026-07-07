import type { RunState } from './run-state'

const DEFAULT_CANCEL_REASON = 'Run cancelled by user.'

export class CodebuffRunController {
  public readonly id: string
  private readonly controller: AbortController

  constructor(id: string = crypto.randomUUID()) {
    this.id = id
    this.controller = new AbortController()
  }

  public get signal(): AbortSignal {
    return this.controller.signal
  }

  public get cancelled(): boolean {
    return this.controller.signal.aborted
  }

  public cancel(reason: string | Error = DEFAULT_CANCEL_REASON): void {
    if (this.cancelled) return
    this.controller.abort(
      reason instanceof Error ? reason : new Error(reason),
    )
  }
}

export type CancellableRun = {
  id: string
  controller: CodebuffRunController
  signal: AbortSignal
  result: Promise<RunState>
  cancel: (reason?: string | Error) => void
}

export function createRunController(id?: string): CodebuffRunController {
  return new CodebuffRunController(id)
}

export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  )
  if (activeSignals.length === 0) {
    return new AbortController().signal
  }
  if (activeSignals.length === 1) {
    return activeSignals[0]
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals)
  }

  const controller = new AbortController()
  const abort = (signal: AbortSignal) => {
    if (controller.signal.aborted) return
    controller.abort(signal.reason)
  }
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    signal.addEventListener('abort', () => abort(signal), { once: true })
  }
  return controller.signal
}
