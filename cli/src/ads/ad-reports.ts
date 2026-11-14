import {
  AdReportReasonSchema,
  toAdReport,
  type AdReport,
} from '@codebuff/common/ads/ad-report'
import { sanitizeTerminalText } from '@codebuff/common/util/terminal-safe-text'

import { reportAd } from '../utils/ad-report'
import { getAuthToken } from '../utils/auth'

export type AdReportStatus = 'idle' | 'sending' | 'sent' | 'error'
export type ReportableAd = {
  id: number
  snapshot: AdReport
  status: AdReportStatus
  listeners: Set<() => void>
  mounted: number
}
export type AdReportPrompt = {
  entry: ReportableAd
  send: (ad: AdReport, expectedToken?: string) => Promise<void>
}

/** Keep recent snapshots for /ads:report after a rotation or slash-menu close. */
export function createAdReportRegistry(
  send: AdReportPrompt['send'] = reportAd,
  getAccount: () => string | null | undefined = () => null,
) {
  let nextId = 1
  let account = getAccount()
  let generation = 0
  const entries = new Map<string, ReportableAd>()
  const generations = new WeakMap<ReportableAd, number>()
  let prompt: AdReportPrompt | null = null
  const promptListeners = new Set<() => void>()
  const publishPrompt = () => {
    for (const listener of promptListeners) listener()
  }
  const reset = () => {
    account = getAccount()
    generation++
    entries.clear()
    prompt = null
    publishPrompt()
  }
  const syncAccount = () => {
    if (getAccount() !== account) reset()
  }
  const status = (entry: ReportableAd, value: AdReportStatus) => {
    entry.status = value
    for (const listener of entry.listeners) listener()
  }
  const register = (ad: AdReport): ReportableAd => {
    // Select and copy only report fields; no answers, prompt or targeting context.
    const { reason: _reason, ...creative } = toAdReport(ad)
    const snapshot = Object.freeze(creative)
    const key = JSON.stringify(snapshot)
    const existing = entries.get(key)
    if (existing) return existing
    const entry: ReportableAd = {
      id: nextId++,
      snapshot,
      status: 'idle',
      listeners: new Set(),
      mounted: 0,
    }
    entries.set(key, entry)
    generations.set(entry, generation)
    // Mounted cards keep their keyboard target. Bound only the recent history.
    const recent = [...entries.entries()].filter(
      ([, value]) =>
        !value.mounted && value.status !== 'sending' && value !== prompt?.entry,
    )
    for (const [oldKey] of recent.slice(0, Math.max(0, recent.length - 100)))
      entries.delete(oldKey)
    return entry
  }
  const open = (entry: ReportableAd, sendReport = send) => {
    syncAccount()
    if (generations.get(entry) !== generation) return
    if (entry.status === 'sending' || entry.status === 'sent' || prompt) return
    prompt = { entry, send: sendReport }
    publishPrompt()
  }
  const cancel = () => {
    if (prompt?.entry.status === 'sending') return
    prompt = null
    publishPrompt()
  }
  const submit = async (
    entry: ReportableAd,
    reason: string,
    sendReport = send,
  ): Promise<AdReportStatus> => {
    syncAccount()
    if (generations.get(entry) !== generation) return 'error'
    if (entry.status === 'sending' || entry.status === 'sent')
      return entry.status
    const explanation = AdReportReasonSchema.parse(reason)
    const startedGeneration = generation
    status(entry, 'sending')
    syncAccount()
    if (generation !== startedGeneration) return 'error'
    let result: AdReportStatus
    try {
      await sendReport(
        { ...entry.snapshot, reason: explanation },
        account ?? undefined,
      )
      result = 'sent'
    } catch {
      result = 'error'
    }
    // An account change invalidates client state, not an already-sent request.
    syncAccount()
    if (generation === startedGeneration) {
      status(entry, result)
      if (result === 'sent' && prompt?.entry === entry) {
        prompt = null
        publishPrompt()
      }
    }
    return result
  }
  const command = async (args: string): Promise<string | null> => {
    syncAccount()
    const input = args.trim()
    if (!input) {
      const shown = [...entries.values()].reverse().slice(0, 12)
      if (!shown.length) return 'No ads have been shown in this session.'
      return [
        'Report an ad with /ads:report <number>:',
        ...shown.map(
          (entry) =>
            `${entry.id}: ${sanitizeTerminalText(entry.snapshot.title)}${entry.status === 'sent' ? ' (reported)' : ''}`,
        ),
      ].join('\n')
    }
    const entry = /^\d+$/.test(input)
      ? [...entries.values()].find((item) => item.id === Number(input))
      : undefined
    if (!entry) return 'Ad not found. Use /ads:report to list recent ads.'
    if (entry.status === 'sent') return 'This ad has already been reported.'
    if (entry.status === 'sending') return 'Sending this ad report…'
    open(entry)
    return null
  }
  return {
    register,
    open,
    cancel,
    reset,
    syncAccount,
    submit,
    command,
    getPrompt: () => prompt,
    getGeneration: () => generation,
    subscribe: (listener: () => void) => {
      promptListeners.add(listener)
      return () => {
        promptListeners.delete(listener)
      }
    },
  }
}

export const adReports = createAdReportRegistry(reportAd, getAuthToken)
export type AdReportRegistry = ReturnType<typeof createAdReportRegistry>
